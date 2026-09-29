#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 每小時鏡像工作（launchd com.dzy.bulletin.mirror，StartInterval 3600；同一個 job 不會重疊）
 *   1. 簽名回填：找出 driveSigId 空白、本機有圖的已讀，批次（一次 ≤20 張、一次橋接呼叫）經 `sigs` op 上傳到 Drive 簽名資料夾，
 *      回填 driveSigId（只寫這一欄）。每輪最多 SIG_MAX_PER_RUN 張，避免撞 Apps Script 6 分鐘上限。這同時是簽名圖的異地備份。
 *      M2 契約：saveSigs 逐張處理，失敗的那張回 null——拿到 id 的照常回填，null 的留到下一輪只重傳它（不整批作廢，#14 B1）。
 *      同一張失敗 SIG_BAD_AFTER（3）次就標成壞圖，之後不再挑它（不會每輪卡在同一批、擋住後面的簽名），計入 bad。
 *      只有「同一批有成功也有失敗」才計數，且同一張兩次計數至少隔 30 分鐘、一次執行最多 1 次；整批都 null 視為 Drive 暫時故障，
 *      不計數、這一輪結束回填、ok:false（#14 B2）。已知限制：只剩一張壞圖單獨成批時永遠是「整批 null」，不會被標壞，
 *      會一直 ok:false（/health 連續失敗亮黃、mirror.log 寫原因），由人處理。
 *   2. 鏡像：Mac mini 正本整份寫回試算表四分頁（走 `mirror` op；Apps Script 先寫暫存分頁再換名，見 gas/Store.js）。
 *      四份資料＋待回填清單在同一個讀交易裡取（同一個快照，#14 S1），COMMIT 之後才呼叫橋接（不在交易開著時等 Google，免得擋住 checkpoint）。
 *      已讀帶 driveSigId（Drive id），試算表「簽名檔 id」只寫它、還沒回填的留空——回退到 GAS 後 readSig(id) 才讀得到。
 *   先回填再鏡像：這一輪剛拿到的 Drive id 就跟著這一輪寫進試算表。
 * 橋接出錯不在同一輪重試（橋接打的是會排隊的 Apps Script，重試只會更塞）；下一輪（一小時後）自然重做。
 *
 * 待回填的三種狀態（#14 S2；回退步驟「回填到 pending=0」的判準就是 pending）：
 *   pending＝本機有圖、還沒回填、不是壞圖（mirror.js 還能處理的）
 *   missing＝有 sigId 但本機找不到圖檔（傳不了，列出清單讓人決定）
 *   bad    ＝連續上傳失敗 3 次的壞圖（例如 0 位元組；列出清單，不再自動重試）
 *   missing／bad 大於 0 時印警告並列出是哪幾筆，但不卡住；/health 亮黃。
 * 壞圖計數與「已上傳、還沒寫進庫」的 Drive id 記在 logs/sig-state.json（不寫進資料庫：背景工作只寫 reads.driveSigId 一欄，#8）。
 *   把某張壞圖從 sig-state.json 的 fails 刪掉，下一輪就會再試。
 * 結果寫 DATA_DIR/logs/mirror-last.json＝{ at, ok, uploaded, pending, missing, bad, failed, fails, missingIds, badIds }，每輪一行進 logs/mirror.log。
 *   fails＝連續失敗次數（守門規則「mirror.ok=false 連續 2 次 → 黃」用）；failed＝這一輪回 null 的張數（不算整輪失敗）。
 *
 * 還原防呆（#14 S5）：posts／staff／reads 任一比上次成功送出的筆數少就不送（多半是剛從快照還原，試算表比本機新）、ok:false。
 * 用法：node server/mirror.js          （launchd 每小時）
 *       node server/mirror.js --all    （回退前手動跑：不設每輪上限、失敗的再重掃一次；完成條件是印出 pending=0，見 #10）
 *       node server/mirror.js --force  （還原後、確認試算表可被覆寫時手動跑：越過筆數防呆，並帶 force:true 給 Apps Script）
 *   手動執行撞到另一輪正在跑時印「已跳過」並以非 0 結束。
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env）；SIG_BATCH（每批張數，預設 15、上限 20）；SIG_MAX_PER_RUN（預設 60） */
'use strict';
const fs = require('fs');
const path = require('path');
const J = require('./job-common.js');

const SIGS_MAX = 20;                                        // 與 gas/Code.js SIGS_MAX_ 相同：Apps Script 一次最多收 20 張
const SIG_BAD_AFTER = 3;                                    // 同一張連續失敗幾次算壞圖
const LAST = 'mirror-last.json', STATE = 'sig-state.json';
const LIST_MAX = 50;                                        // 結果檔與警告最多列幾筆
const FAIL_GAP_MS = 30 * 60e3;                              // 同一張兩次失敗計數至少隔 30 分鐘

function clampInt(v, dflt, lo, hi) { const n = Math.floor(Number(v)); return n >= lo ? Math.min(n, hi) : dflt; }
const keyOf = (r) => r.postId + '\t' + r.staffId + '\t' + r.sigId;   // 含 sigId：同一格被重建成別張圖時，舊的失敗計數不沿用
const label = (r) => r.postId + '/' + r.staffId;

// 跑一輪；回傳結果物件（也寫進 mirror-last.json）。bridge 只需要 call(op, payload, timeoutSec)。
// o.force：還原後手動覆寫（越過筆數防呆，並帶 force:true 給 Apps Script）。o.busyMs／o.nowMs：測試用。
// o._betweenReads：測試用鉤子，在讀交易的第一個 SELECT 之後呼叫（驗四份是同一個快照）。
async function runMirror(o) {
  const dir = o.dir, bridge = o.bridge, nowMs = o.nowMs || Date.now;   // nowMs 只給測試快轉時間
  const batch = clampInt(o.batch, 15, 1, SIGS_MAX);
  const maxPerRun = o.all ? Infinity : clampInt(o.maxPerRun, 60, 1, 100000);
  const prev = J.readLast(dir, LAST);
  const res = { at: new Date().toISOString(), ok: false, uploaded: 0, carried: 0, pending: null, missing: 0, bad: 0, failed: 0, fails: 0 };
  const errs = [], warns = [];
  const release = J.takeLock(dir, 'mirror');
  if (!release) {   // 另一輪還在跑（或正在還原）：不寫結果檔、不算失敗（--all 由 main() 以非 0 結束並印原因）
    J.logLine(dir, 'mirror.log', '另一輪鏡像還在跑（或正在還原），這次跳過');
    return Object.assign(res, { ok: true, skipped: true });
  }
  // 上一次「成功送出」的筆數（還原防呆用）：失敗的那輪沒有 counts，沿用更早的
  res.lastSent = (prev && (prev.counts || prev.lastSent)) || null;
  // sig-state.json 壞掉：改名保留成 .corrupt-時間、記 ok:false（不默默歸零——unsaved 裡已上傳的 Drive id 會跟著不見）
  const st = J.readState(dir, STATE);
  if (st.corrupt) {
    const bak = STATE + '.corrupt-' + J.taipeiStamp(new Date()) + '-' + process.pid;
    try { fs.renameSync(path.join(dir, 'logs', STATE), path.join(dir, 'logs', bak)); } catch (e) {}
    errs.push(`logs/${STATE} 損毀，已改名保留為 ${bak}（裡面已上傳未寫庫的 Drive id 需人工核對，這一輪起重新計數）`);
  }
  const state = st.v || {};
  const fails = state.fails || {}, unsaved = state.unsaved || {};
  Object.keys(fails).forEach((k) => { if (typeof fails[k] === 'number') fails[k] = { n: fails[k], at: 0 }; });   // 舊格式（只有次數）
  // 存狀態失敗（例如磁碟滿）只記警告，鏡像照做
  const saveState = () => { try { J.writeLast(dir, STATE, { fails, unsaved }); } catch (e) { if (!warns.length) warns.push('sig-state.json 寫不進去：' + J.errText(e)); } };
  let db = null;
  try {
    db = J.openDb(dir, { busyMs: o.busyMs });
    if (!db.prepare('PRAGMA table_info(reads)').all().some((c) => c.name === 'driveSigId')) throw new Error('資料庫還沒有 driveSigId 欄（伺服器升級後重新啟動一次即會補上）');
    const sigDir = path.join(dir, 'sigs');
    const TODO_SQL = "SELECT postId, staffId, sigId FROM reads WHERE sigId <> '' AND driveSigId = '' ORDER BY rowid";
    const hasFile = (r) => fs.existsSync(path.join(sigDir, path.basename(r.sigId)));   // sigId 由 store-sqlite.js 產生（只有安全字元），basename 是多一道保險
    const isBad = (r) => ((fails[keyOf(r)] || {}).n || 0) >= SIG_BAD_AFTER;
    // 失敗計數（#14 B2）：只在「同一批有成功也有失敗」時才算；同一張要跨輪、距上次計數至少 30 分鐘才再加 1，
    // 一次執行裡（--all 重掃）最多加 1 次——Drive 暫時故障（配額、5xx）幾分鐘內連續失敗，不會把好圖標成壞圖。
    const counted = new Set();
    const countFail = (r) => {
      const k = keyOf(r), f = fails[k] || { n: 0, at: 0 }, now = nowMs();
      if (counted.has(k) || now - f.at < FAIL_GAP_MS) return;
      counted.add(k); fails[k] = { n: f.n + 1, at: now };
    };
    // 只寫 driveSigId 一欄；已有 id 的不覆蓋、sigId 變了（上傳這幾分鐘裡被 load() 重建）的不套用
    const upd = db.prepare("UPDATE reads SET driveSigId = ? WHERE postId = ? AND staffId = ? AND sigId = ? AND driveSigId = ''");
    const writeIds = (pairs) => {   // pairs: [{ r, id }]；寫不進去（busy 逾時等）就把 id 記在 sig-state.json，下一輪先用、不重傳
      if (!pairs.length) return true;
      try {
        db.exec('BEGIN IMMEDIATE');
        try { pairs.forEach((x) => upd.run(x.id, x.r.postId, x.r.staffId, x.r.sigId)); db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
        pairs.forEach((x) => { delete unsaved[keyOf(x.r)]; delete fails[keyOf(x.r)]; });
        return true;
      } catch (e) {
        pairs.forEach((x) => { unsaved[keyOf(x.r)] = x.id; });
        errs.push('回填寫入：' + J.errText(e));
        return false;
      }
    };

    // ---- 1. 簽名回填 ----
    // 1a. 上一輪已上傳、但沒寫進庫的 Drive id：先寫，不重傳（避免孤兒檔）
    const todo0 = J.rows(db, TODO_SQL);
    const carry = todo0.filter((r) => unsaved[keyOf(r)]).map((r) => ({ r, id: unsaved[keyOf(r)] }));
    Object.keys(unsaved).forEach((k) => { if (!todo0.some((r) => keyOf(r) === k)) delete unsaved[k]; });   // 那一格已被回填或重建：丟掉
    if (carry.length && writeIds(carry)) res.carried = carry.length;
    // 1b. 逐批上傳。--all 不設上限、回 null 的那幾張再重掃一次（不再計數）
    const done = new Set();                                  // 這一輪已成功的不再重傳（--all 的重掃也一樣）
    let budget = maxPerRun, stop = errs.length > 0;          // 前面已出錯（sig-state 損毀、carry 寫不進去）這一輪就不上傳，免得重傳成孤兒檔
    for (let pass = 0; pass < (o.all ? 2 : 1) && !stop && budget > 0; pass++) {
      let pick = J.rows(db, TODO_SQL).filter((r) => !done.has(keyOf(r)) && !unsaved[keyOf(r)] && !isBad(r) && hasFile(r));
      if (budget !== Infinity) pick = pick.slice(0, budget);
      if (!pick.length) break;
      for (let i = 0; i < pick.length && !stop; i += batch) {
        const part = pick.slice(i, i + batch).map((r) => {   // 傳這一批時才讀這一批的圖（--all 不會一次把全部圖讀進記憶體）
          const file = path.basename(r.sigId);
          let data = '';
          try { data = 'data:' + (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(path.join(sigDir, file)).toString('base64'); } catch (e) {}
          return { r, name: file.replace(/\.(png|jpe?g)$/i, ''), data };
        });
        budget -= part.length;
        if (o.all) release.touch();                          // --all 可能跑很久：每批更新鎖檔 mtime，不被當成殘留鎖
        let ids;
        try {
          const out = await bridge.call('sigs', { put: part.map((x) => ({ name: x.name, data: x.data })) }, 300);
          ids = out && out.ids;
          if (!Array.isArray(ids) || ids.length !== part.length) throw new Error('sigs 回傳筆數不符');
        } catch (e) { errs.push('簽名回填：' + J.errText(e)); stop = true; break; }   // 橋接出錯：同一輪不重試，剩下的留給下一輪
        const ok = (id) => typeof id === 'string' && id;
        if (!ids.some(ok)) {   // 整批都回 null：當作 Drive 暫時故障，不累計任何一張、這一輪結束回填
          res.failed += part.length;
          errs.push(`簽名回填：這批 ${part.length} 張全部失敗（Drive 暫時故障？不計入壞圖，下一輪再試）`);
          stop = true; break;
        }
        const good = [];
        part.forEach((x, k) => {
          if (ok(ids[k])) { good.push({ r: x.r, id: ids[k] }); done.add(keyOf(x.r)); }
          else { countFail(x.r); res.failed++; }            // 同一批有成功也有失敗：失敗的這張才計數；留空，下一次只重傳它
        });
        if (writeIds(good)) res.uploaded += good.length; else stop = true;
        saveState();
      }
    }
    Object.keys(fails).forEach((k) => { if (!todo0.some((r) => keyOf(r) === k)) delete fails[k]; });   // 已不在待回填清單的計數丟掉
    saveState();

    // ---- 2. 鏡像：四份＋待回填清單在同一個讀交易（同一個快照）；COMMIT 之後才打橋接 ----
    let data, left;
    db.exec('BEGIN');
    try {
      data = { posts: J.rows(db, 'SELECT json FROM posts ORDER BY rowid').map((r) => JSON.parse(r.json)) };
      if (o._betweenReads) o._betweenReads();
      data.staff = J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => JSON.parse(r.json));
      data.reads = J.rows(db, 'SELECT postId, staffId, name, unit, at, sigId, driveSigId FROM reads ORDER BY rowid');
      data.log = J.rows(db, 'SELECT at, action, target, summary FROM log ORDER BY seq');
      left = J.rows(db, TODO_SQL);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
    const missing = left.filter((r) => !hasFile(r)), bad = left.filter((r) => hasFile(r) && isBad(r));
    res.pending = left.length - missing.length - bad.length;
    res.missing = missing.length; res.bad = bad.length;
    if (missing.length) res.missingIds = missing.slice(0, LIST_MAX).map(label);
    if (bad.length) res.badIds = bad.slice(0, LIST_MAX).map(label);
    // 還原防呆（#14 S5）：posts／staff／reads 任一比上次成功送出的少 → 不送（多半是剛從每日快照還原，試算表比本機新）。
    // 確認試算表可以被覆寫後，手動 --force（同時帶 force:true 給 Apps Script，越過 M2 的筆數防呆）。
    const n = { posts: data.posts.length, staff: data.staff.length, reads: data.reads.length, log: data.log.length };
    const L0 = res.lastSent;
    const shrunk = L0 ? ['posts', 'staff', 'reads'].filter((k) => n[k] < Number(L0[k] || 0)) : [];
    if (shrunk.length && !o.force) {
      errs.push('鏡像：本機筆數比上次鏡像少（可能剛還原）——' + shrunk.map((k) => `${k} ${n[k]}＜${L0[k]}`).join('、') + '；確認試算表可被覆寫後執行 node server/mirror.js --force');
    } else {
      try {
        await bridge.call('mirror', o.force ? { data, force: true } : { data }, 300);
        res.counts = n; res.lastSent = n;
        if (o.force) res.forced = true;
      } catch (e) { errs.push('鏡像：' + J.errText(e)); }
    }
  } catch (e) {
    errs.push(J.errText(e));
  } finally {
    try { if (db) db.close(); } catch (e) {}
    release();
  }
  if (warns.length) res.warnings = warns;
  res.ok = errs.length === 0;
  res.fails = res.ok ? 0 : (Number(prev && prev.fails) || 0) + 1;
  if (!res.ok) res.error = errs.join('；');
  J.writeLast(dir, LAST, res);
  J.logLine(dir, 'mirror.log', (res.ok ? '鏡像完成' : '鏡像失敗') + `：回填 ${res.uploaded} 張` + (res.carried ? `（另補寫上一輪已上傳的 ${res.carried} 張）` : '') + `、待回填 ${res.pending}` +
    (res.failed ? `、這輪上傳失敗 ${res.failed}` : '') + (res.counts ? '、' + J.countText(res.counts) : '') + (res.forced ? '（--force）' : '') +
    (res.ok ? '' : '；' + res.error) + (warns.length ? '；⚠ ' + warns.join('；') : ''));
  if (res.missing) J.logLine(dir, 'mirror.log', `⚠ 本機缺簽名圖 ${res.missing} 筆（無法上傳，需人工判斷）：` + res.missingIds.join('、') + (res.missing > LIST_MAX ? ' …' : ''));
  if (res.bad) J.logLine(dir, 'mirror.log', `⚠ 壞簽名圖 ${res.bad} 筆（連續上傳失敗 ${SIG_BAD_AFTER} 次，不再自動重試；從 logs/${STATE} 刪掉即重試）：` + res.badIds.join('、') + (res.bad > LIST_MAX ? ' …' : ''));
  return res;
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const dir = J.dataDir(process.env);
  const all = process.argv.includes('--all'), force = process.argv.includes('--force');
  const res = await runMirror({ dir, bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY),
    batch: process.env.SIG_BATCH, maxPerRun: process.env.SIG_MAX_PER_RUN, all, force });
  if (res.skipped) {   // 另一輪正在跑：手動執行（--all／--force）要讓人看得出被跳過，以非 0 結束
    if (all || force || process.stdout.isTTY) console.log('✗ 另一輪鏡像正在跑（或正在還原），這次已跳過，請等它結束後再執行');
    process.exit(all || force ? 1 : 0);
  }
  if (all || force || process.stdout.isTTY) {   // 手動執行：把結論印出來（回退步驟看這裡）
    console.log(`鏡像${res.ok ? '完成' : '失敗'}｜待回填 pending=${res.pending}｜本機缺圖 missing=${res.missing}｜壞圖 bad=${res.bad}` + (res.error ? '｜' + res.error : ''));
    if (res.missing) console.log('⚠ 本機缺圖：' + res.missingIds.join('、'));
    if (res.bad) console.log('⚠ 壞圖：' + res.badIds.join('、'));
  }
  process.exit(res.ok ? 0 : 1);                             // 非 0 讓 launchd 記錄失敗；真正的告警靠守門讀 /health
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runMirror, SIGS_MAX, SIG_BAD_AFTER };
