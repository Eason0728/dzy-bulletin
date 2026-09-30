#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 每小時鏡像工作（launchd com.dzy.bulletin.mirror，StartInterval 3600；同一個 job 不會重疊）
 *   1. 簽名回填：找出 driveSigId 空白、本機有圖的已讀，批次（一次 ≤20 張、一次橋接呼叫）經 `sigs` op 上傳到 Drive 簽名資料夾，
 *      回填 driveSigId（只寫這一欄）。每輪最多 SIG_MAX_PER_RUN 張，避免撞 Apps Script 6 分鐘上限。這同時是簽名圖的異地備份。
 *      M2 契約：saveSigs 逐張處理，失敗的那張回 null——拿到 id 的照常回填，null 的留到下一輪只重傳它（不整批作廢，#14 B1）。
 *   2. 鏡像：Mac mini 正本整份寫回試算表四分頁（走 `mirror` op；Apps Script 先寫暫存分頁再換名，見 gas/Store.js）。
 *      四份資料＋待回填清單在同一個讀交易裡取（同一個快照，#14 S1），COMMIT 之後才呼叫橋接（不在交易開著時等 Google，免得擋住 checkpoint）。
 *      已讀帶 driveSigId（Drive id），試算表「簽名檔 id」只寫它、還沒回填的留空——回退到 GAS 後 readSig(id) 才讀得到。
 *   先回填再鏡像：這一輪剛拿到的 Drive id 就跟著這一輪寫進試算表。
 *
 * 壞圖只由本機判定（#14 第 5 輪設計簡化，Eason 拍板的「直接驗證」）：
 *   0 位元組；PNG 開頭不是 89 50 4E 47 或結尾沒有 IEND chunk；JPEG 開頭不是 FF D8 FF 或結尾不是 FF D9 → 本機檔損毀，計入 bad、不上傳。
 *   本機驗過的圖，saveSigs 回 null 只剩「Drive 端出錯」（createFile 丟錯），所以 Drive 端失敗一律視為暫時故障：
 *   不計數、不判壞，留在 pending，下一輪自然重試。每小時模式有失敗就 ok:false（連續失敗 → /health 黃燈）。
 *   --all 重複掃描到 pending=0 才 exit 0；一整輪沒有任何進展（上傳成功 0 張而 pending>0）就停下、exit 1，
 *   印出「Drive 端有 N 張傳不上去，稍後再跑；多次重跑仍失敗請找 MacBook Claude」並列出是哪幾張。
 *   逃生門（只能人手動做，程式永遠不自動判定）：真的有某張本機驗過、Drive 卻永遠拒收（或本機壞圖／缺圖確認放棄），
 *   在 logs/sig-skip.json 加一筆 { "<postId>/<staffId>": "原因" }，mirror 就跳過它、另計 skipped（不算 bad／missing，/health 不因此轉黃）。
 *   檔案格式錯：照常上傳、這一輪不略過任何一張、ok:false 並寫原因。對不到任何已讀的鍵（打錯字）會列在警告裡。
 *
 * 待回填的四種狀態（#14 S2／S14；回退步驟「回填到 pending=0」的判準就是 pending）：
 *   pending＝本機有圖、驗過、還沒回填、沒被人工略過（mirror.js 還能處理的）
 *   missing＝有 sigId 但本機找不到圖檔、沒被人工略過（傳不了，列出清單讓人決定）
 *   bad    ＝本機檔損毀、沒被人工略過；列出清單並寫原因
 *   skipped＝寫在 sig-skip.json 的（人已判斷過）；列出清單，但不讓 /health 轉黃
 *   missing／bad 大於 0 時印警告並列出是哪幾筆，但不卡住；/health 亮黃。
 * 「已上傳、還沒寫進庫」的 Drive id 記在 logs/sig-state.json 的 unsaved，下一輪先寫、不重傳（避免孤兒檔）。
 *   不要手改或刪掉這個檔（刪掉會讓那些圖再傳一次、變成孤兒檔）；壞掉或型別不對會改名成 .corrupt-* 保留並 ok:false。
 * 結果寫 DATA_DIR/logs/mirror-last.json＝{ at, ok, uploaded, pending, missing, bad, skipped, failed, fails, …Ids }（--all 每輪更新 at 當心跳），
 *   每輪一行進 logs/mirror.log。fails＝連續失敗次數（守門規則「mirror.ok=false 連續 2 次 → 黃」用）；failed＝這一輪 Drive 端傳不上去的張數。
 * 還原防呆（#14 S5）：posts／staff／reads／log 任一比上次成功送出的筆數少就不送（多半是剛從快照還原，試算表比本機新）、ok:false。
 * 橋接出錯不在同一輪重試（橋接打的是會排隊的 Apps Script，重試只會更塞）。
 *
 * 用法：node server/mirror.js          （launchd 每小時）
 *       node server/mirror.js --all    （回退前手動跑：不設每輪上限、重複掃描；完成條件是印出 pending=0 並 exit 0，見 #10）
 *       node server/mirror.js --force  （還原後、確認試算表可被覆寫時手動跑：越過筆數防呆，並帶 force:true 給 Apps Script）
 *   手動執行撞到另一輪正在跑時印「已跳過」並以非 0 結束。
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env）；SIG_BATCH（每批張數，預設 15、上限 20）；SIG_MAX_PER_RUN（預設 60） */
'use strict';
const fs = require('fs');
const path = require('path');
const J = require('./job-common.js');

const SIGS_MAX = 20;                                        // 與 gas/Code.js SIGS_MAX_ 相同：Apps Script 一次最多收 20 張
const LAST = 'mirror-last.json', STATE = 'sig-state.json', SKIP = 'sig-skip.json';
const LIST_MAX = 50;                                        // 結果檔與警告最多列幾筆
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47]), PNG_TAIL = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);   // IEND＋CRC
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff]), JPG_TAIL = Buffer.from([0xff, 0xd9]);

// 本機驗圖：開頭與結尾都對才算完整（前端只產生 PNG／JPEG；寫到一半就截斷的圖結尾會缺）。讀不到＝缺圖，由 hasFile 判
function localDamaged(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) { return false; }
  const at = (sig, i) => b.length >= sig.length && b.subarray(i, i + sig.length).equals(sig);
  if (at(PNG_HEAD, 0)) return !at(PNG_TAIL, b.length - PNG_TAIL.length);
  if (at(JPG_HEAD, 0)) return !at(JPG_TAIL, b.length - JPG_TAIL.length);
  return true;                                               // 0 位元組或不是 PNG／JPEG
}
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const allStrings = (o) => Object.values(o).every((x) => typeof x === 'string' && x);
function clampInt(v, dflt, lo, hi) { const n = Math.floor(Number(v)); return n >= lo ? Math.min(n, hi) : dflt; }
const keyOf = (r) => r.postId + '\t' + r.staffId + '\t' + r.sigId;   // 含 sigId：同一格被重建成別張圖時，舊的 unsaved id 不沿用
const label = (r) => r.postId + '/' + r.staffId;

// 跑一輪；回傳結果物件（也寫進 mirror-last.json）。bridge 只需要 call(op, payload, timeoutSec)。
// o.force：還原後手動覆寫（越過筆數防呆，並帶 force:true 給 Apps Script）。o.busyMs／o.backoffMs：測試用。
// o._betweenReads：測試用鉤子，在讀交易的第一個 SELECT 之後呼叫（驗四份是同一個快照）。
async function runMirror(o) {
  const dir = o.dir, bridge = o.bridge;
  const batch = clampInt(o.batch, 15, 1, SIGS_MAX);
  const maxPerRun = o.all ? Infinity : clampInt(o.maxPerRun, 60, 1, 100000);
  const envBackoff = process.env.MIRROR_BACKOFF_MS === undefined ? NaN : Number(process.env.MIRROR_BACKOFF_MS);   // 只給測試縮短
  const backoffMs = o.backoffMs >= 0 ? o.backoffMs : envBackoff >= 0 ? envBackoff : 30000;
  const prev = J.readLast(dir, LAST);
  const res = { at: new Date().toISOString(), ok: false, uploaded: 0, carried: 0, pending: null, missing: 0, bad: 0, skipped: 0, failed: 0, fails: 0 };
  const errs = [], warns = [];
  const release = J.takeLock(dir, 'mirror');
  if (!release) {   // 另一輪還在跑（或正在還原）：不寫結果檔、不算失敗（--all 由 main() 以非 0 結束並印原因）
    J.logLine(dir, 'mirror.log', '另一輪鏡像還在跑（或正在還原），這次跳過');
    return Object.assign(res, { ok: true, busy: true });
  }
  // 上一次「成功送出」的筆數（還原防呆用）：失敗的那輪沒有 counts，沿用更早的
  res.lastSent = (prev && (prev.counts || prev.lastSent)) || null;
  // sig-state.json：壞掉或 unsaved 型別不對 → 改名保留成 .corrupt-時間、記 ok:false（不默默歸零——裡面已上傳的 Drive id 會跟著不見）
  const st = J.readState(dir, STATE);
  if (!st.corrupt && st.v && st.v.unsaved !== undefined && !(plain(st.v.unsaved) && allStrings(st.v.unsaved))) st.corrupt = true;
  if (st.corrupt) {
    const bak = STATE + '.corrupt-' + J.taipeiStamp(new Date()) + '-' + process.pid;
    try { fs.renameSync(path.join(dir, 'logs', STATE), path.join(dir, 'logs', bak)); } catch (e) {}
    errs.push(`logs/${STATE} 損毀，已改名保留為 ${bak}（裡面已上傳未寫庫的 Drive id 需人工核對）`);
  }
  const unsaved = (!st.corrupt && st.v && st.v.unsaved) || {};
  // 人工略過清單（逃生門，只有人會寫）：格式錯就 ok:false、這一輪不略過任何一張（上傳照常）
  const sk = J.readState(dir, SKIP);
  let skip = {};
  if (sk.corrupt || (sk.v && !(plain(sk.v) && allStrings(sk.v)))) errs.push(`logs/${SKIP} 格式錯誤（應為 { "公告id/同仁id": "原因" }），這一輪不略過任何一張`);
  else if (sk.v) skip = sk.v;
  // 存狀態失敗（例如磁碟滿）只記警告，鏡像照做
  const saveState = () => { try { J.writeLast(dir, STATE, { unsaved }); } catch (e) { if (!warns.length) warns.push(`${STATE} 寫不進去：` + J.errText(e)); } };
  let db = null;
  try {
    db = J.openDb(dir, { busyMs: o.busyMs });
    if (!db.prepare('PRAGMA table_info(reads)').all().some((c) => c.name === 'driveSigId')) throw new Error('資料庫還沒有 driveSigId 欄（伺服器升級後重新啟動一次即會補上）');
    const sigDir = path.join(dir, 'sigs');
    const TODO_SQL = "SELECT postId, staffId, sigId FROM reads WHERE sigId <> '' AND driveSigId = '' ORDER BY rowid";
    const fileOf = (r) => path.join(sigDir, path.basename(r.sigId));   // sigId 由 store-sqlite.js 產生（只有安全字元），basename 是多一道保險
    const hasFile = (r) => fs.existsSync(fileOf(r));
    const dmg = new Map();
    const isDamaged = (r) => { const k = keyOf(r); if (!dmg.has(k)) dmg.set(k, localDamaged(fileOf(r))); return dmg.get(k); };
    const isSkipped = (r) => Object.prototype.hasOwnProperty.call(skip, label(r));
    // 只寫 driveSigId 一欄；已有 id 的不覆蓋、sigId 變了（上傳這幾分鐘裡被 load() 重建）的不套用
    const upd = db.prepare("UPDATE reads SET driveSigId = ? WHERE postId = ? AND staffId = ? AND sigId = ? AND driveSigId = ''");
    const writeIds = (pairs) => {   // pairs: [{ r, id }]；寫不進去（busy 逾時等）就把 id 記在 sig-state.json，下一輪先用、不重傳
      if (!pairs.length) return true;
      try {
        db.exec('BEGIN IMMEDIATE');
        try { pairs.forEach((x) => upd.run(x.id, x.r.postId, x.r.staffId, x.r.sigId)); db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
        pairs.forEach((x) => { delete unsaved[keyOf(x.r)]; });
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
    let carryFailed = false;
    if (carry.length) { if (writeIds(carry)) res.carried = carry.length; else carryFailed = true; }
    // 人工略過清單裡對不到任何已讀的鍵（打錯字、大小寫不對）：列在警告裡，免得人以為已經略過了
    const allLabels = new Set(J.rows(db, 'SELECT postId, staffId FROM reads').map(label));
    const unmatched = Object.keys(skip).filter((k) => !allLabels.has(k));
    if (unmatched.length) { res.skipUnmatched = unmatched.slice(0, LIST_MAX); warns.push(`${SKIP} 有 ${unmatched.length} 個鍵對不到任何已讀：` + res.skipUnmatched.join('、')); }
    // 1b. 逐批上傳。Drive 端失敗（null）一律是暫時故障：留在 pending。--all 重複掃描到 pending=0，一整輪沒進展就停
    let budget = maxPerRun, stop = !!st.corrupt || carryFailed;   // sig-state 損毀、carry 寫不進去：這一輪不上傳，免得重傳成孤兒檔（sig-skip 格式錯不擋上傳）
    let pass = 0;
    const failedNow = new Map();                             // 最後一輪仍傳不上去的
    while (!stop && budget > 0) {
      let pick = J.rows(db, TODO_SQL).filter((r) => !unsaved[keyOf(r)] && hasFile(r) && !isDamaged(r) && !isSkipped(r));
      if (budget !== Infinity) pick = pick.slice(0, budget);
      if (!pick.length) break;
      let progress = 0;
      failedNow.clear();
      for (let i = 0; i < pick.length && !stop; i += batch) {
        const part = pick.slice(i, i + batch).map((r) => {   // 傳這一批時才讀這一批的圖（--all 不會一次把全部圖讀進記憶體）
          const file = path.basename(r.sigId);
          return { r, name: file.replace(/\.(png|jpe?g)$/i, ''), data: 'data:' + (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(fileOf(r)).toString('base64') };
        });
        budget -= part.length;
        if (o.all) release.touch();                          // --all 可能跑很久：每批更新鎖檔 mtime，不被當成殘留鎖
        let ids;
        try {
          const out = await bridge.call('sigs', { put: part.map((x) => ({ name: x.name, data: x.data })) }, 300);
          ids = out && out.ids;
          if (!Array.isArray(ids) || ids.length !== part.length) throw new Error('sigs 回傳筆數不符');
        } catch (e) { errs.push('簽名回填：' + J.errText(e)); stop = true; break; }   // 橋接出錯：同一輪不重試，剩下的留給下一輪
        const good = [];
        part.forEach((x, k) => {
          if (typeof ids[k] === 'string' && ids[k]) good.push({ r: x.r, id: ids[k] });
          else failedNow.set(keyOf(x.r), x.r);               // Drive 端失敗：暫時故障，留在 pending
        });
        if (!writeIds(good)) { stop = true; break; }
        res.uploaded += good.length; progress += good.length;
        saveState();
      }
      if (!o.all || progress === 0) break;                   // 每小時模式只掃一次；--all 一整輪沒有進展就停
      // --all 長時間回填：每輪更新結果檔的 at（其餘欄位沿用上一次），守門才不會把「正在補」誤判成「鏡像很久沒跑」
      pass++;
      try { J.writeLast(dir, LAST, Object.assign({}, prev || {}, { at: new Date().toISOString(), running: true, pass })); } catch (e) {}
      // 退避：這一輪失敗超過一半就先等一下再掃（Drive 限流時不要一直打）
      if (failedNow.size * 2 > pick.length) await new Promise((ok) => setTimeout(ok, backoffMs));
    }
    res.failed = failedNow.size;
    if (failedNow.size) {
      res.failedIds = [...failedNow.values()].slice(0, LIST_MAX).map(label);
      errs.push(`簽名回填：Drive 端有 ${failedNow.size} 張傳不上去（暫時故障，不判壞圖）` +
        (o.all ? '，稍後再跑；多次重跑仍失敗請找 MacBook Claude' : '，下一輪再試'));
    }
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
    const skipped = left.filter(isSkipped), rest = left.filter((r) => !isSkipped(r));   // 人工略過優先（缺圖、壞圖寫進 sig-skip 也算 skipped）
    const missing = rest.filter((r) => !hasFile(r)), damaged = rest.filter((r) => hasFile(r) && isDamaged(r));
    res.pending = rest.length - missing.length - damaged.length;
    res.missing = missing.length; res.bad = damaged.length; res.skipped = skipped.length;
    if (missing.length) res.missingIds = missing.slice(0, LIST_MAX).map(label);
    if (res.bad) res.badIds = damaged.slice(0, LIST_MAX).map((r) => label(r) + '（本機檔損毀）');
    if (res.skipped) res.skippedIds = skipped.slice(0, LIST_MAX).map((r) => label(r) + '（' + skip[label(r)] + '）');
    // 還原防呆（#14 S5）：任一份比上次成功送出的少 → 不送（多半是剛從每日快照還原，試算表比本機新）。
    // 確認試算表可以被覆寫後，手動 --force（同時帶 force:true 給 Apps Script，越過 M2 的筆數防呆）。
    // 前提（審查第 3 輪確認）：公告不刪（只下架）、同仁軟刪除、已讀與操作紀錄只增，只有 load()（搬遷／還原）會讓筆數變少。
    // 以後若加硬刪（例如「清除離職同仁」），這裡要改成只比其他幾份，或硬刪時同步下修 lastSent。
    const n = { posts: data.posts.length, staff: data.staff.length, reads: data.reads.length, log: data.log.length };
    const L0 = res.lastSent;
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
    (res.counts ? '、' + J.countText(res.counts) : '') + (res.forced ? '（--force）' : '') +
    (res.ok ? '' : '；' + res.error) + (warns.length ? '；⚠ ' + warns.join('；') : ''));
  if (res.failedIds) J.logLine(dir, 'mirror.log', `⚠ Drive 端傳不上去 ${res.failed} 張：` + res.failedIds.join('、') + (res.failed > LIST_MAX ? ' …' : ''));
  if (res.missing) J.logLine(dir, 'mirror.log', `⚠ 本機缺簽名圖 ${res.missing} 筆（無法上傳，需人工判斷）：` + res.missingIds.join('、') + (res.missing > LIST_MAX ? ' …' : ''));
  if (res.bad) J.logLine(dir, 'mirror.log', `⚠ 壞簽名圖 ${res.bad} 筆（本機檔損毀；換好圖檔，或確認放棄後寫進 logs/${SKIP}）：` + res.badIds.join('、') + (res.bad > LIST_MAX ? ' …' : ''));
  if (res.skipped) J.logLine(dir, 'mirror.log', `人工略過 ${res.skipped} 筆（logs/${SKIP}）：` + res.skippedIds.join('、'));
  return res;
}

// 結束碼：非 0 讓 launchd 記錄失敗（真正的告警靠守門讀 /health）；--all 只要還有 pending（或算不出來）就不 exit 0
function exitCode(res, all) { return !res.ok || (all && res.pending !== 0) ? 1 : 0; }

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const dir = J.dataDir(process.env);
  const all = process.argv.includes('--all'), force = process.argv.includes('--force');
  const res = await runMirror({ dir, bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY),
    batch: process.env.SIG_BATCH, maxPerRun: process.env.SIG_MAX_PER_RUN, all, force });
  if (res.busy) {   // 另一輪正在跑：手動執行（--all／--force）要讓人看得出被跳過，以非 0 結束
    if (all || force || process.stdout.isTTY) console.log('✗ 另一輪鏡像正在跑（或正在還原），這次已跳過，請等它結束後再執行');
    process.exit(all || force ? 1 : 0);
  }
  if (all || force || process.stdout.isTTY) {   // 手動執行：把結論印出來（回退步驟看這裡）
    console.log(`鏡像${res.ok ? '完成' : '失敗'}｜待回填 pending=${res.pending}｜本機缺圖 missing=${res.missing}｜壞圖 bad=${res.bad}` + (res.error ? '｜' + res.error : ''));
    if (res.failedIds) console.log(`✗ Drive 端有 ${res.failed} 張傳不上去，稍後再跑；多次重跑仍失敗請找 MacBook Claude：` + res.failedIds.join('、'));
    if (res.missing) console.log('⚠ 本機缺圖：' + res.missingIds.join('、'));
    if (res.bad) console.log('⚠ 壞圖：' + res.badIds.join('、'));
    if (res.skipped) console.log('人工略過：' + res.skippedIds.join('、'));
    if (res.warnings) console.log('⚠ ' + res.warnings.join('；'));
  }
  process.exit(exitCode(res, all));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runMirror, SIGS_MAX, localDamaged, exitCode };
