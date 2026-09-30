#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 每小時鏡像工作（launchd com.dzy.bulletin.mirror，StartInterval 3600；同一個 job 不會重疊）
 *   1. 簽名回填：找出 driveSigId 空白、本機有圖的已讀，批次（一次 ≤20 張、一次橋接呼叫）經 `sigs` op 上傳到 Drive 簽名資料夾，
 *      回填 driveSigId（只寫這一欄）。每輪最多 SIG_MAX_PER_RUN 張，避免撞 Apps Script 6 分鐘上限。這同時是簽名圖的異地備份。
 *      M2 契約：saveSigs 逐張處理，失敗的那張回 null——拿到 id 的照常回填，null 的留到下一輪只重傳它（不整批作廢，#14 B1）。
 *      壞圖的判定改成直接驗證、不從上傳成敗推測（#14 第 3 輪，Eason 拍板）：
 *        a. 本機先驗圖：0 位元組、開頭不是 PNG（89 50 4E 47）或 JPEG（FF D8 FF）→ 直接算壞圖（本機檔損毀），不上傳。
 *        b. Drive 拒收：同一批有別張成功＝Drive 當下正常；整批都 null 時先傳一張內建的極小測試圖（_canary.png，每次執行最多一張）：
 *           測試圖成功＝Drive 正常 → 這批失敗的每張算 1 次（每小時模式：同一張兩次計數至少隔 30 分鐘、一次執行最多 1 次，3 次成壞圖；
 *           --all：Drive 已被證明正常，直接判成壞圖）；測試圖也失敗＝Drive 故障 → 不計數、這一輪結束回填、ok:false（--all exit 1）。
 *        「其他時候有沒有成功」的間接證據已拿掉：測試圖是同一時間的直接證據，回退時（先 READONLY、不再有新簽名）也拿得到。
 *      --all 最後把「Drive 拒收」的壞圖再帶上重試一次（不計數）：成功就回填、失敗維持壞圖，減少好圖被冤枉。
 *      註：測試圖每次會在簽名資料夾留一個 _canary.png（橋接沒有刪簽名圖的 op）；只在整批失敗時才傳，量很小。
 *   2. 鏡像：Mac mini 正本整份寫回試算表四分頁（走 `mirror` op；Apps Script 先寫暫存分頁再換名，見 gas/Store.js）。
 *      四份資料＋待回填清單在同一個讀交易裡取（同一個快照，#14 S1），COMMIT 之後才呼叫橋接（不在交易開著時等 Google，免得擋住 checkpoint）。
 *      已讀帶 driveSigId（Drive id），試算表「簽名檔 id」只寫它、還沒回填的留空——回退到 GAS 後 readSig(id) 才讀得到。
 *   先回填再鏡像：這一輪剛拿到的 Drive id 就跟著這一輪寫進試算表。
 * 橋接出錯不在同一輪重試（橋接打的是會排隊的 Apps Script，重試只會更塞）；下一輪（一小時後）自然重做。
 *
 * 待回填的三種狀態（#14 S2；回退步驟「回填到 pending=0」的判準就是 pending）：
 *   pending＝本機有圖、還沒回填、不是壞圖（mirror.js 還能處理的）
 *   missing＝有 sigId 但本機找不到圖檔（傳不了，列出清單讓人決定）
 *   bad    ＝本機檔損毀（0 位元組／檔頭不對）＋Drive 拒收 3 次（--all 為 1 次）的壞圖；列出清單並寫原因，不再自動重試
 *   missing／bad 大於 0 時印警告並列出是哪幾筆，但不卡住；/health 亮黃。
 * 壞圖計數與「已上傳、還沒寫進庫」的 Drive id 記在 logs/sig-state.json（不寫進資料庫：背景工作只寫 reads.driveSigId 一欄，#8）。
 *   人工恢復某張「Drive 拒收」的壞圖：只刪 sig-state.json 裡 fails 的那一個 key，**不要刪整個檔**
 *   （整個刪掉會連 unsaved 一起刪，已上傳的圖會再傳一次、變成孤兒檔）。本機檔損毀的要先把圖檔換好或移走（移走就變 missing）。
 * 結果寫 DATA_DIR/logs/mirror-last.json＝{ at, ok, uploaded, pending, missing, bad, failed, fails, missingIds, badIds }，每輪一行進 logs/mirror.log。
 *   fails＝連續失敗次數（守門規則「mirror.ok=false 連續 2 次 → 黃」用）；failed＝這一輪回 null 的張數（不算整輪失敗）。
 *
 * 還原防呆（#14 S5）：posts／staff／reads／log 任一比上次成功送出的筆數少就不送（多半是剛從快照還原，試算表比本機新）、ok:false。
 * 用法：node server/mirror.js          （launchd 每小時）
 *       node server/mirror.js --all    （回退前手動跑：不設每輪上限、最後重試一次 Drive 拒收的壞圖；完成條件是印出 pending=0，見 #10）
 *       node server/mirror.js --force  （還原後、確認試算表可被覆寫時手動跑：越過筆數防呆，並帶 force:true 給 Apps Script）
 *   手動執行撞到另一輪正在跑時印「已跳過」並以非 0 結束。
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env）；SIG_BATCH（每批張數，預設 15、上限 20）；SIG_MAX_PER_RUN（預設 60） */
'use strict';
const fs = require('fs');
const path = require('path');
const J = require('./job-common.js');

const SIGS_MAX = 20;                                        // 與 gas/Code.js SIGS_MAX_ 相同：Apps Script 一次最多收 20 張
const SIG_BAD_AFTER = 3;                                    // Drive 拒收幾次算壞圖（每小時模式）
const LAST = 'mirror-last.json', STATE = 'sig-state.json';
const LIST_MAX = 50;                                        // 結果檔與警告最多列幾筆
const FAIL_GAP_MS = 30 * 60e3;                              // 同一張兩次失敗計數至少隔 30 分鐘（每小時模式）
// 測試圖：1×1 的合法 PNG
const CANARY = { name: '_canary', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' };
// 本機檔頭：PNG 89 50 4E 47、JPEG FF D8 FF；0 位元組或都不是＝本機檔損毀
function localDamaged(file) {
  try {
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(4);
    let n; try { n = fs.readSync(fd, b, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (n >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return false;
    if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return false;
    return true;
  } catch (e) { return false; }                              // 讀不到＝缺圖，由 hasFile 判
}
// sig-state.json 的型別檢查（#14 S8）：fails 是物件、值是次數或 { n, at } 數字；unsaved 是物件、值是字串
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function stateOk(v) {
  if (v.fails !== undefined && !(plain(v.fails) && Object.values(v.fails).every((f) => typeof f === 'number' || (plain(f) && typeof f.n === 'number' && typeof f.at === 'number')))) return false;
  if (v.unsaved !== undefined && !(plain(v.unsaved) && Object.values(v.unsaved).every((x) => typeof x === 'string' && x))) return false;
  return true;
}

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
  if (!st.corrupt && st.v && !stateOk(st.v)) st.corrupt = true;   // 合法 JSON 但型別不對（例如手改出錯）：跟損毀一樣處理
  if (st.corrupt) {
    const bak = STATE + '.corrupt-' + J.taipeiStamp(new Date()) + '-' + process.pid;
    try { fs.renameSync(path.join(dir, 'logs', STATE), path.join(dir, 'logs', bak)); } catch (e) {}
    errs.push(`logs/${STATE} 損毀，已改名保留為 ${bak}（裡面已上傳未寫庫的 Drive id 需人工核對，這一輪起重新計數）`);
  }
  const state = (!st.corrupt && st.v) || {};
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
    const dmg = new Map();
    const isDamaged = (r) => { const k = keyOf(r); if (!dmg.has(k)) dmg.set(k, localDamaged(path.join(sigDir, path.basename(r.sigId)))); return dmg.get(k); };
    // Drive 拒收計數：只在 Drive 已被證明正常（同批有成功、或測試圖成功）時呼叫。--all 直接判成壞圖；每小時模式 +1（30 分鐘間隔、一次執行最多 1 次）
    const counted = new Set();
    const countFail = (r) => {
      const k = keyOf(r), f = fails[k] || { n: 0, at: 0 }, now = nowMs();
      if (counted.has(k) || (!o.all && now - f.at < FAIL_GAP_MS)) return false;
      counted.add(k); fails[k] = { n: o.all ? SIG_BAD_AFTER : f.n + 1, at: now };
      return true;
    };
    // 測試圖：每次執行最多傳一張，結果沿用（'ok'／'fail'；橋接本身出錯就丟出去，當作橋接錯誤）
    let canary = null;
    const probe = async () => {
      if (canary) return canary;
      const out = await bridge.call('sigs', { put: [CANARY] }, 120);
      canary = out && Array.isArray(out.ids) && typeof out.ids[0] === 'string' && out.ids[0] ? 'ok' : 'fail';
      res.canary = canary;
      return canary;
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
    if (carry.length && writeIds(carry)) res.carried = carry.length;   // （carry 是上一輪的成功，已在那一輪記過 lastSuccess）
    // 1b. 逐批上傳（--all 不設上限）
    const done = new Set();                                  // 這一輪已成功的不再重傳
    const rejected = [];                                     // Drive 正常卻拒收的（寫進 mirror.log／終端機）
    let budget = maxPerRun, stop = errs.length > 0;          // 前面已出錯（sig-state 損毀、carry 寫不進去）這一輪就不上傳，免得重傳成孤兒檔
    const readPart = (rows) => rows.map((r) => {             // 傳這一批時才讀這一批的圖（--all 不會一次把全部圖讀進記憶體）
      const file = path.basename(r.sigId);
      let data = '';
      try { data = 'data:' + (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(path.join(sigDir, file)).toString('base64'); } catch (e) {}
      return { r, name: file.replace(/\.(png|jpe?g)$/i, ''), data };
    });
    const put = async (part) => {
      const out = await bridge.call('sigs', { put: part.map((x) => ({ name: x.name, data: x.data })) }, 300);
      const ids = out && out.ids;
      if (!Array.isArray(ids) || ids.length !== part.length) throw new Error('sigs 回傳筆數不符');
      return ids.map((id) => (typeof id === 'string' && id ? id : null));
    };
    let pick = J.rows(db, TODO_SQL).filter((r) => !unsaved[keyOf(r)] && !isBad(r) && hasFile(r) && !isDamaged(r));
    if (budget !== Infinity) pick = pick.slice(0, budget);
    for (let i = 0; i < pick.length && !stop; i += batch) {
      const part = readPart(pick.slice(i, i + batch));
      if (o.all) release.touch();                            // --all 可能跑很久：每批更新鎖檔 mtime，不被當成殘留鎖
      let ids;
      try {
        ids = await put(part);
        if (!ids.some(Boolean) && (await probe()) !== 'ok') {   // 整批 null：先用測試圖驗 Drive
          res.driveDown = true; res.failed += part.length;
          errs.push(`簽名回填：這批 ${part.length} 張全部失敗，測試圖也上傳失敗——Drive 暫時故障，未計入壞圖，稍後再跑`);
          stop = true; break;
        }
      } catch (e) { errs.push('簽名回填：' + J.errText(e)); stop = true; break; }   // 橋接出錯：同一輪不重試，剩下的留給下一輪
      const good = [];
      part.forEach((x, k) => {
        if (ids[k]) { good.push({ r: x.r, id: ids[k] }); done.add(keyOf(x.r)); return; }
        res.failed++;                                        // Drive 正常（同批有成功或測試圖成功）卻拒收這張
        countFail(x.r);
        rejected.push(label(x.r) + `（${(fails[keyOf(x.r)] || {}).n || 0}/${SIG_BAD_AFTER}）`);
      });
      if (writeIds(good)) res.uploaded += good.length; else stop = true;
      saveState();
    }
    // 1c. --all 收尾：「Drive 拒收」的壞圖（這次執行之前就標壞的）再重試一次、不計數——成功就回填，失敗維持壞圖
    if (o.all && !stop) {
      const again = J.rows(db, TODO_SQL).filter((r) => isBad(r) && !counted.has(keyOf(r)) && !unsaved[keyOf(r)] && hasFile(r) && !isDamaged(r));
      for (let i = 0; i < again.length && !stop; i += batch) {
        const part = readPart(again.slice(i, i + batch));
        release.touch();
        let ids;
        try { ids = await put(part); } catch (e) { warns.push('壞圖重試：' + J.errText(e)); break; }   // 重試失敗不影響本輪結果
        const good = part.map((x, k) => (ids[k] ? { r: x.r, id: ids[k] } : null)).filter(Boolean);
        if (good.length && writeIds(good)) { res.uploaded += good.length; res.recovered = (res.recovered || 0) + good.length; }
        saveState();
      }
    }
    if (rejected.length) res.rejectedIds = rejected.slice(0, LIST_MAX);
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
    const missing = left.filter((r) => !hasFile(r));
    const damaged = left.filter((r) => hasFile(r) && isDamaged(r)), rejectedBad = left.filter((r) => hasFile(r) && !isDamaged(r) && isBad(r));
    res.pending = left.length - missing.length - damaged.length - rejectedBad.length;
    res.missing = missing.length; res.bad = damaged.length + rejectedBad.length;
    if (missing.length) res.missingIds = missing.slice(0, LIST_MAX).map(label);
    if (res.bad) res.badIds = damaged.map((r) => label(r) + '（本機檔損毀）').concat(rejectedBad.map((r) => label(r) + '（Drive 拒收）')).slice(0, LIST_MAX);
    // 還原防呆（#14 S5）：posts／staff／reads 任一比上次成功送出的少 → 不送（多半是剛從每日快照還原，試算表比本機新）。
    // 確認試算表可以被覆寫後，手動 --force（同時帶 force:true 給 Apps Script，越過 M2 的筆數防呆）。
    const n = { posts: data.posts.length, staff: data.staff.length, reads: data.reads.length, log: data.log.length };
    const L0 = res.lastSent;
    // 前提（審查第 3 輪確認）：公告不刪（只下架）、同仁軟刪除、已讀與操作紀錄只增，只有 load()（搬遷／還原）會讓筆數變少。
    // 以後若加硬刪（例如「清除離職同仁」），這裡要改成只比其他幾份，或硬刪時同步下修 lastSent。
    const shrunk = L0 ? ['posts', 'staff', 'reads', 'log'].filter((k) => L0[k] !== undefined && n[k] < Number(L0[k])) : [];
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
  if (res.rejectedIds) J.logLine(dir, 'mirror.log', `⚠ Drive 正常（${res.canary === 'ok' ? '測試圖上傳成功' : '同批有成功'}）卻拒收 ${res.rejectedIds.length} 張（已計次數/${SIG_BAD_AFTER}${o.all ? '；--all 直接判成壞圖' : ''}）：` + res.rejectedIds.join('、'));
  if (res.bad) J.logLine(dir, 'mirror.log', `⚠ 壞簽名圖 ${res.bad} 筆（不再自動重試；本機檔損毀的先換好圖檔，Drive 拒收的只刪 logs/${STATE} 裡 fails 的那個 key 即重試，不要刪整個檔）：` + res.badIds.join('、') + (res.bad > LIST_MAX ? ' …' : ''));
  return res;
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const dir = J.dataDir(process.env);
  const all = process.argv.includes('--all'), force = process.argv.includes('--force');
  const res = await runMirror({ dir, bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY),
    batch: process.env.SIG_BATCH, maxPerRun: process.env.SIG_MAX_PER_RUN, all, force });
  if (res.driveDown && (all || force || process.stdout.isTTY)) console.log('✗ Drive 暫時故障，稍後再跑（整批上傳失敗、測試圖也失敗，未計入壞圖）');
  if (res.skipped) {   // 另一輪正在跑：手動執行（--all／--force）要讓人看得出被跳過，以非 0 結束
    if (all || force || process.stdout.isTTY) console.log('✗ 另一輪鏡像正在跑（或正在還原），這次已跳過，請等它結束後再執行');
    process.exit(all || force ? 1 : 0);
  }
  if (all || force || process.stdout.isTTY) {   // 手動執行：把結論印出來（回退步驟看這裡）
    console.log(`鏡像${res.ok ? '完成' : '失敗'}｜待回填 pending=${res.pending}｜本機缺圖 missing=${res.missing}｜壞圖 bad=${res.bad}` + (res.error ? '｜' + res.error : ''));
    if (res.missing) console.log('⚠ 本機缺圖：' + res.missingIds.join('、'));
    if (res.rejectedIds) console.log(`⚠ Drive 正常${res.canary === 'ok' ? '（測試圖上傳成功）' : ''}卻拒收：` + res.rejectedIds.join('、'));
    if (res.recovered) console.log(`✓ 壞圖重試成功 ${res.recovered} 張，已回填`);
    if (res.bad) console.log('⚠ 壞圖：' + res.badIds.join('、'));
  }
  process.exit(res.ok ? 0 : 1);                             // 非 0 讓 launchd 記錄失敗；真正的告警靠守門讀 /health
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runMirror, SIGS_MAX, SIG_BAD_AFTER };
