#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 一次性搬遷：Apps Script（Google 試算表＋Drive 簽名圖）→ Mac mini（SQLite＋硬碟）（#10 步驟 4）
 *
 * export 只能用一次（gas/Code.js：PRIMARY=mini 且 EXPORT_ONCE=1 才接受，成功一次就刪 EXPORT_ONCE）。
 * 所以第一次呼叫 export 時，結果**立刻存成本機 JSON 檔（權限 600）**，之後的 dry-run／正式匯入／重跑都用 `--from <檔>`，
 * 不會因為先跑 dry-run 就把唯一一次機會用掉。檔案內含全部同仁密碼雜湊＋登入簽章金鑰＋管理通行碼雜湊，搬完確認無誤要刪掉。
 *
 * 用法（在 Mac mini，repo 根目錄）：
 *   node server/migrate.js --dry-run                 # 呼叫 export（用掉一次）→ 存檔 → 印筆數、簽名圖張數、預估下載時間；不寫入資料庫
 *   node server/migrate.js --from <匯出檔>            # 正式匯入：下載簽名圖（sigs 批次 get，一批 20 張）→ 寫入 → 六項逐筆比對
 *   node server/migrate.js --from <匯出檔> --dry-run  # 用已存的檔再看一次（不打 Google）
 *   node server/migrate.js                           # 不先 dry-run、直接呼叫 export 並正式匯入（一樣會先存檔）
 * 選項：
 *   --save <路徑>   第一次 export 的存檔位置（預設 <DATA_DIR 的上一層>/dzy-bulletin-export-<台北時間>.json）
 *   --force         目標 DATA_DIR 已有資料時仍匯入（先用 VACUUM INTO 備份成 bulletin.db.before-migrate-<時間>）；回退後再切回用（ROLLBACK.md）
 *   --batch <n>     簽名圖每批張數（預設 20，上限 20＝gas/Code.js SIGS_MAX_）
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env；--from 時不需要 BRIDGE_*，除非有簽名圖要下載）
 *
 * 已讀重複（同一人同一則兩列）照 GAS 語意去重（見 dedupeReads）；簽名圖下載暫存在 DATA_DIR/.migrate-dl/，中斷後 --from 重跑只補沒下載的。
 * 比對有 ❌（exit 1）時資料已寫進庫，查明原因後重跑要加 --force。
 *
 * 結束碼：0＝六項全 ✅（或 dry-run 檢查通過）；1＝比對有 ❌；2＝用法錯誤／目標已有資料／檔案問題；
 *         3＝匯出內容不完整（缺 secret 或 admin.hash 等，拒絕寫入）；4＝export 呼叫失敗；5＝簽名圖下載中斷
 * 絕不印出金鑰、密碼雜湊、secret（只印筆數、id）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const J = require('./job-common.js');

const SIGS_MAX = 20;                                        // 與 gas/Code.js SIGS_MAX_ 相同
const EST_SEC = [5, 30];                                    // 每次 sigs 橋接呼叫估計秒數（Apps Script 排隊 1.7～72 秒，#5 實測）
const TABLES = ['posts', 'staff', 'reads', 'log'];

function parseArgs(argv) {
  const o = { dry: false, force: false, from: '', save: '', batch: SIGS_MAX, bad: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (!v || v.startsWith('--')) o.bad = a + ' 後面要接值'; return v || ''; };
    if (a === '--dry-run') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a === '--from') o.from = next();
    else if (a === '--save') o.save = next();
    else if (a === '--batch') { const n = Math.floor(Number(next())); o.batch = n >= 1 ? Math.min(n, SIGS_MAX) : SIGS_MAX; }
    else o.bad = '不認得的參數 ' + a;
  }
  return o;
}

// 穩定序列化（鍵排序）：逐筆比對內容用，不受欄位順序影響
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const str = (v) => (v === null || v === undefined ? '' : String(v));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readKey = (r) => str(r.postId) + '|' + str(r.staffId);
// 檔頭魔術數字：PNG 89 50 4E 47、JPEG FF D8 FF
const magicOk = (b, type) => (type === 'png' ? b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 : b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

// 目標資料夾狀態：四張表的筆數（沒有庫＝全 0）。只數資料表，不算 kv（伺服器第一次啟動就會自己產生 secret）
function targetCounts(dir) {
  const file = path.join(dir, 'bulletin.db'), c = { posts: 0, staff: 0, reads: 0, log: 0 };
  if (!fs.existsSync(file)) return c;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = ' + J.BUSY_MS);
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    TABLES.forEach((t) => { if (have.has(t)) c[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n); });
  } finally { db.close(); }
  return c;
}
const isEmpty = (c) => TABLES.every((t) => !c[t]);

// 匯出內容檢查：結構不對或缺 secret／admin.hash → 拒絕寫入（草稿只印警告仍 exit 0，會讓「不用重新登入」默默失敗，#10）
function problems(d) {
  const p = [];
  if (!d || typeof d !== 'object') return ['匯出內容不是物件'];
  TABLES.forEach((t) => { if (!Array.isArray(d[t])) p.push('缺 ' + t); });
  if (!d.secret || typeof d.secret !== 'string') p.push('缺 secret（TOKEN_SECRET）：搬過去後所有同仁都要重新登入');
  if (!d.admin || !d.admin.hash) p.push('缺 admin.hash（管理通行碼雜湊）：搬過去後主管進不去');
  // 公告／同仁 id 重複：GAS 自己的語意就不一致——看板（boardFor）與名單（roster）逐列列出、兩筆都顯示；
  // findPost／findStaff／upsert 卻用 filter()[0] 只認第一列。SQLite 主鍵只能留一筆，搬過去無論留哪筆都會跟 GAS 畫面不同，
  // 所以不自動去重：列出重複的 id、拒絕寫入（dry-run 也停），由 Eason 確認後在試算表刪掉多的那列、重設 EXPORT_ONCE 重來（CUTOVER.md 第 3 步）。
  [['posts', '公告'], ['staff', '同仁']].forEach(([t, label]) => {
    if (!Array.isArray(d[t])) return;
    const seen = new Set(), dup = new Set();
    d[t].forEach((x) => { const id = str(x && x.id); if (!id) return; if (seen.has(id)) dup.add(id); seen.add(id); });
    if (dup.size) p.push(`${label} id 重複 ${dup.size} 個：${[...dup].slice(0, 10).join('、')}（GAS 畫面會顯示兩筆、編輯只認第一列，無法自動判斷保留哪筆）`);
  });
  return p;
}
// 重複的已讀（同一人同一則兩列，只有手動改過試算表才會發生）照 GAS 的語意去重，否則 SQLite 的主鍵會吃掉一筆、比對永遠 ❌：
//   gas/Service.js myReadAt 逐列覆寫 → 簽名時間、姓名、單位取「最後一列」；Store.getSigs 只看有簽名檔 id 的列、同樣後蓋前
//   → 簽名取「最後一張有簽名檔 id 的」（最後一列沒簽名檔 id 時沿用前面的）。位置保留第一次出現的地方（rowid 順序與試算表一致）。
// 比對（verify）拿去重後的結果當標準，所以重複列不會造成 ❌；去重了幾筆會印出來。
function dedupeReads(reads) {
  const m = new Map(), dups = [];
  reads.forEach((r) => {
    const k = readKey(r), prev = m.get(k);
    if (!prev) { m.set(k, Object.assign({}, r)); return; }
    dups.push(k);
    m.set(k, Object.assign({}, r, { sigId: str(r.sigId) || str(prev.sigId) }));   // Map.set 覆寫不改變位置
  });
  return { reads: [...m.values()], dups };
}
// 不擋但要讓人看到的：缺 id
function warnings(d) {
  const w = [];
  const noId = d.posts.filter((p) => !p.id).length + d.staff.filter((s) => !s.id).length;
  if (noId) w.push(`公告／同仁有 ${noId} 筆沒有 id`);
  return w;
}

function writeSecretFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600, flag: 'wx' });   // wx：不覆蓋既有的檔（那可能是唯一一份 export）
  fs.chmodSync(file, 0o600);
}

async function runMigrate(o) {
  const say = o.say || console.log;
  const dir = o.dir, batch = Math.min(Math.max(1, Math.floor(o.batch) || SIGS_MAX), SIGS_MAX);
  const done = (code, extra) => {
    const r = Object.assign({ code }, extra || {});
    // 非 0 結束時匯出檔一樣已經存了（內含密碼雜湊與登入金鑰）：提醒處理完要刪（成功路徑在最後另外提醒）
    if (code !== 0 && r.file && fs.existsSync(r.file)) say(`⚠️ 匯出檔仍在 ${r.file}（含密碼雜湊與登入金鑰）：重跑用 --from 它；整件事處理完後請刪除（rm ${r.file}）`);
    return r;
  };
  const t0 = Date.now();

  // ---- 0. 正式匯入：先確認目標是空的（在呼叫 export 之前，免得白白用掉一次）----
  let tc = targetCounts(dir);
  if (!o.dry && !isEmpty(tc) && !o.force) {
    say(`✗ 目標 ${dir} 已有資料（${J.countText(tc)}），拒絕匯入。確定要覆蓋請加 --force（會先備份現有資料庫）。`);
    return done(2);
  }

  // ---- 1. 取得匯出 ----
  let d, file = o.from;
  if (o.from) {
    try {
      const st = fs.statSync(o.from);
      if (st.mode & 0o077) { fs.chmodSync(o.from, 0o600); say(`⚠️ 匯出檔權限太寬，已改成 600：${o.from}`); }
      d = JSON.parse(fs.readFileSync(o.from, 'utf8'));
    } catch (e) { say(`✗ 讀不到匯出檔 ${o.from}：${e.code || e.message}`); return done(2); }
    say(`1/5 使用已存的匯出檔 ${o.from}（不打 Google export）`);
  } else {
    if (!o.bridge) { say('✗ 沒有設定 BRIDGE_URL／BRIDGE_KEY（server/.env），無法呼叫 export'); return done(2); }
    file = o.save || path.join(path.dirname(dir), 'dzy-bulletin-export-' + J.taipeiStamp() + '.json');
    if (fs.existsSync(file)) { say(`✗ 存檔位置已有檔案 ${file}（可能是上一次的 export），不覆蓋。要用它請加 --from ${file}`); return done(2); }
    say('1/5 呼叫 Google export（一次性：成功後 EXPORT_ONCE 會被刪掉）…');
    try { d = await o.bridge.call('export', {}, 300); }
    catch (e) {
      say('✗ export 失敗：' + J.errText(e));
      say('   · 回 AUTH：EXPORT_ONCE 已用過（之前存的檔請用 --from）、或 PRIMARY 不是 mini、或 BRIDGE_KEY 不符');
      say('   · 逾時：EXPORT_ONCE 可能已被刪掉而結果沒收到 → 請 Eason 重新設 EXPORT_ONCE=1 再跑');
      return done(4);
    }
    try { writeSecretFile(file, d); }
    catch (e) { say(`✗ export 成功但存檔失敗（${e.code || e.message}）。EXPORT_ONCE 已用掉，請 Eason 重新設 EXPORT_ONCE=1`); return done(2); }
    say(`   已存檔（權限 600，內含密碼雜湊與登入金鑰）：${file}`);
  }

  // ---- 2. 內容檢查 ----
  const bad = problems(d);
  if (bad.length) {
    bad.forEach((x) => say('✗ ' + x));
    say('✗ 匯出內容不完整或有重複 id，拒絕寫入（資料庫沒有動）。id 重複：請 Eason 確認後在試算表刪掉多的那列，重設 EXPORT_ONCE=1，從 --dry-run 重來');
    return done(3, { file });
  }
  const nRaw = d.reads.length, dd = dedupeReads(d.reads);
  d = Object.assign({}, d, { reads: dd.reads });            // 之後一律用去重後的已讀（寫入與比對同一份）
  const sigReads = d.reads.filter((r) => str(r.sigId));
  const driveIds = [...new Set(sigReads.map((r) => str(r.sigId)))];
  const nBatch = Math.ceil(driveIds.length / batch);
  const est = (s) => (s < 90 ? Math.round(s) + ' 秒' : Math.round(s / 60) + ' 分鐘');
  say(`2/5 匯出內容：公告 ${d.posts.length}、同仁 ${d.staff.length}、已讀 ${nRaw}${dd.dups.length ? `（去重後 ${d.reads.length}）` : ''}、操作紀錄 ${d.log.length}；登入金鑰 ✓、管理通行碼雜湊 ✓`);
  say(`   簽名圖 ${driveIds.length} 張 → ${nBatch} 次 sigs 橋接呼叫（每批 ${batch} 張），預估下載 ${est(nBatch * EST_SEC[0])}～${est(nBatch * EST_SEC[1])}`);
  if (dd.dups.length) say(`⚠️ 已讀有 ${dd.dups.length} 列重複（同一人同一則，例如 ${dd.dups.slice(0, 3).join('、')}）：照 GAS 語意去重（時間取最後一列、簽名取最後一張有簽名的），比對以去重後為準`);
  warnings(d).forEach((x) => say('⚠️ ' + x));

  if (o.dry) {
    say(isEmpty(tc) ? `   目標 ${dir}：空的，可以正式匯入` : `   目標 ${dir}：已有資料（${J.countText(tc)}），正式匯入要加 --force（會先備份）`);
    say('（--dry-run：沒有寫入資料庫、沒有下載簽名圖）');
    say(`下一步：node server/migrate.js --from ${file}`);
    return done(0, { file });
  }

  // ---- 3. 目標已有資料且 --force：先備份（VACUUM INTO：伺服器開著也拿得到一致的快照）----
  tc = targetCounts(dir);
  if (!isEmpty(tc)) {
    if (!o.force) { say(`✗ 目標 ${dir} 已有資料，拒絕匯入（加 --force 會先備份）`); return done(2, { file }); }
    const bak = path.join(dir, 'bulletin.db.before-migrate-' + J.taipeiStamp() + '-' + process.pid);
    const db = J.openDb(dir, { readOnly: true });
    try { db.exec("VACUUM INTO '" + bak.replace(/'/g, "''") + "'"); } finally { db.close(); }
    say(`   --force：現有資料（${J.countText(tc)}）已備份到 ${bak}`);
  }

  // ---- 4. 下載簽名圖（sigs 批次 get）----
  // 下載到的圖先依 Drive id 存進 DATA_DIR/.migrate-dl/（暫存、可續跑）：中途斷掉用 --from 重跑時跳過已下載的，
  // 不必在 GAS 凍結的窗口裡從第 1 批重來。六項全 ✅ 後刪掉暫存資料夾。讀不到（null）的不存，重跑會再試。
  fs.mkdirSync(path.join(dir, 'sigs'), { recursive: true });
  const dl = path.join(dir, '.migrate-dl');
  fs.mkdirSync(dl, { recursive: true });
  // 暫存格式：<sha1(Drive id)>.img＝圖、<同名>.json＝manifest { type, sha, len }（sha／len＝GAS 回傳的 dataUrl 解碼後的來源值）。
  // 兩個檔都 fsync＋暫存檔改名；續跑時圖檔要與 manifest 的 sha／長度相同、長度 > 0、檔頭是 PNG／JPEG 魔術數字，否則刪掉重下
  // （斷電可能留下 0 byte 或截斷的檔）。最後的比對拿 manifest 的來源值跟寫進 sigs/ 的檔比，不是跟暫存自己比。
  const base = (id) => path.join(dl, crypto.createHash('sha1').update(id).digest('hex'));
  const writeSync = (f, data) => { const fd = fs.openSync(f + '.tmp', 'w'); try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(f + '.tmp', f); };
  const got = {};                                           // Drive id → { type, buf, sha, len } | null
  let dropped = 0;
  driveIds.forEach((id) => {
    const b = base(id);
    let m = null, buf = null;
    try { m = JSON.parse(fs.readFileSync(b + '.json', 'utf8')); buf = fs.readFileSync(b + '.img'); } catch (e) { if (!fs.existsSync(b + '.img') && !fs.existsSync(b + '.json')) return; }
    if (m && buf && (m.type === 'png' || m.type === 'jpeg') && buf.length > 0 && buf.length === m.len && magicOk(buf, m.type) && sha(buf) === m.sha) { got[id] = { type: m.type, buf, sha: m.sha, len: m.len }; return; }
    dropped++; [b + '.img', b + '.json'].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
  });
  if (dropped) say(`⚠️ 暫存裡有 ${dropped} 張簽名圖不完整（0 byte、截斷、格式或 sha 不符），已刪掉、這次重新下載`);
  const todo = driveIds.filter((id) => !got[id]), nTodo = Math.ceil(todo.length / batch);
  if (todo.length && !o.bridge) { say('✗ 有簽名圖要下載，但沒有設定 BRIDGE_URL／BRIDGE_KEY'); return done(2, { file }); }
  say(`3/5 下載簽名圖 ${driveIds.length} 張` + (todo.length < driveIds.length ? `（上次已下載 ${driveIds.length - todo.length} 張，這次補 ${todo.length} 張）` : '') + '…');
  const tDl = Date.now();
  let badFmt = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch), k = i / batch + 1;
    let out = null, lastErr = null;
    for (let tries = 0; tries < 3 && !out; tries++) {         // 搬遷只做一次，值得重試；每批最多 3 次
      try {
        const r = await o.bridge.call('sigs', { get: part }, 300);
        if (!r || !r.sigs || typeof r.sigs !== 'object') throw new Error('sigs 回傳格式不符');
        out = r.sigs;
      } catch (e) { lastErr = e; }
    }
    if (!out) { say(`✗ 第 ${k}/${nTodo} 批下載失敗 3 次（${J.errText(lastErr)}），中斷；資料庫沒有動、已下載的圖留在暫存可續跑。用 --from ${file} 重跑`); return done(5, { file }); }
    part.forEach((id) => {
      // sigs.get 讀不到（不在簽名資料夾、不是 png/jpeg、檔案不見）回 null → 這張當作讀不到，比對時列入「簽名圖」失敗清單。
      // 宣稱是 png／jpeg 但解碼後是空的或檔頭不對，也當作讀不到。
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(str(out[id]));
      const buf = m ? Buffer.from(m[2], 'base64') : null;
      if (m && !(buf.length > 0 && magicOk(buf, m[1]))) badFmt++;
      got[id] = m && buf.length > 0 && magicOk(buf, m[1]) ? { type: m[1], buf, sha: sha(buf), len: buf.length } : null;
      if (got[id]) { const b = base(id); writeSync(b + '.img', buf); writeSync(b + '.json', JSON.stringify({ type: m[1], sha: got[id].sha, len: buf.length })); }
    });
    const sec = (Date.now() - tDl) / 1000, left = (nTodo - k) * sec / k;
    if (k === nTodo || k % 5 === 0 || nTodo <= 10) say(`   第 ${k}/${nTodo} 批完成（${Math.min(i + batch, todo.length)} 張），已用 ${est(sec)}${k < nTodo ? '，估計還要 ' + est(left) : ''}`);
  }
  if (badFmt) say(`⚠️ ${badFmt} 張簽名圖內容不是有效的 PNG／JPEG（空的或檔頭不對），當作讀不到`);
  // 每筆已讀：sigId＝Mac mini 本機檔名（與伺服器新簽的同一套命名），driveSigId＝GAS 原本的 Drive id（回退後 readSig 讀得到，#7）
  const want = {};                                          // readKey → { sha, len }（下載當下的內容，比對用）
  const reads = d.reads.map((r) => {
    const drive = str(r.sigId), g = drive ? got[drive] : null;
    let local = '';
    if (g) {
      local = require('./store-sqlite.js').sigFileName(r.postId, r.staffId, g.type);
      fs.writeFileSync(path.join(dir, 'sigs', local), g.buf);
      want[readKey(r)] = { sha: g.sha, len: g.len };      // 來源值（下載當下由 GAS 的 dataUrl 算的，續跑時來自 manifest）
    }
    return { postId: str(r.postId), staffId: str(r.staffId), name: str(r.name), unit: str(r.unit), at: str(r.at), sigId: local, driveSigId: drive };
  });
  const miss = driveIds.filter((id) => !got[id]).length;
  if (miss) say(`⚠️ ${miss} 張簽名圖從 Drive 讀不到（Drive id 仍保留，回退後照舊）`);

  // ---- 5. 寫入（一筆交易：清空四張表後寫入；admin／secret 一起寫）----
  say('4/5 寫入 Mac mini 資料庫…');
  const { makeSqliteStore } = require('./store-sqlite.js');
  const store = makeSqliteStore(dir);
  try { store.load({ posts: d.posts, staff: d.staff, reads, log: d.log, admin: d.admin, secret: d.secret }); }
  finally { store.close(); }
  if (o.afterLoad) o.afterLoad(dir);                        // 只給測試：模擬寫入後被竄改，驗證比對抓得到

  // ---- 6. 逐筆比對（另開唯讀連線讀回來，跟匯出檔比）----
  say('5/5 逐筆比對…');
  const checks = verify(dir, d, want);
  checks.forEach((c) => say(`   ${c.ok ? '✅' : '❌'} ${c.name}：${c.detail}`));
  const nBad = checks.filter((c) => !c.ok).length;
  if (nBad) {
    say(`✗ 搬遷完成但有 ${nBad} 項不一致（exit 1）。不要切換前端，先回報。資料已寫進庫：查明原因後重跑要加 --force（會先備份）`);
    return done(1, { file, checks });
  }
  try { fs.rmSync(dl, { recursive: true, force: true }); } catch (e) {}
  say(`✓ 六項全部一致（${est((Date.now() - t0) / 1000)}）`);
  say(`⚠️ 匯出檔含全部密碼雜湊與登入金鑰：切換驗證完成後請刪除 → rm ${file}`);
  return done(0, { file, checks });
}

function verify(dir, d, want) {
  const db = new DatabaseSync(path.join(dir, 'bulletin.db'), { readOnly: true });
  try {
    const q = (sql) => db.prepare(sql).all().map((r) => Object.assign({}, r));
    const kv = (k) => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; };
    // 依 key 逐筆比：筆數＋每一筆內容。mismatch 只列 key，不列內容（同仁那份有密碼雜湊）
    const byKey = (name, exp, back, key, norm) => {
      const m = new Map(back.map((x) => [key(x), canon(norm(x))])), bad = [];
      const keys = new Set();
      exp.forEach((x) => { const k = key(x); keys.add(k); if (m.get(k) !== canon(norm(x))) bad.push(k); });
      back.forEach((x) => { if (!keys.has(key(x))) bad.push(key(x)); });
      const ok = exp.length === back.length && !bad.length;
      return { name, ok, detail: `${back.length}/${exp.length} 筆` + (bad.length ? `，不一致 ${bad.length} 筆（${bad.slice(0, 3).join('、')}${bad.length > 3 ? '…' : ''}）` : '，逐筆相同') };
    };
    const posts = q('SELECT json FROM posts ORDER BY rowid').map((r) => JSON.parse(r.json));
    const staff = q('SELECT json FROM staff ORDER BY rowid').map((r) => JSON.parse(r.json));
    const reads = q('SELECT postId, staffId, name, unit, at, sigId, driveSigId FROM reads ORDER BY rowid');
    const log = q('SELECT at, action, target, summary FROM log ORDER BY seq');
    const out = [];
    out.push(byKey('公告', d.posts, posts, (x) => str(x.id), (x) => x));
    out.push(byKey('同仁（含密碼雜湊）', d.staff, staff, (x) => str(x.id), (x) => x));
    out.push(byKey('已讀（含 Drive 簽名 id）', d.reads, reads, readKey,
      (x) => ({ postId: str(x.postId), staffId: str(x.staffId), name: str(x.name), unit: str(x.unit), at: str(x.at), drive: str(x.driveSigId !== undefined ? x.driveSigId : x.sigId) })));
    // 操作紀錄沒有 id：依順序逐筆比
    const L4 = (x) => canon([str(x.at), str(x.action), str(x.target), str(x.summary)]);
    const badLog = []; d.log.forEach((x, i) => { if (!log[i] || L4(log[i]) !== L4(x)) badLog.push(i + 1); });
    out.push({ name: '操作紀錄', ok: log.length === d.log.length && !badLog.length,
      detail: `${log.length}/${d.log.length} 筆` + (badLog.length ? `，第 ${badLog.slice(0, 3).join('、')} 筆不一致` : '，逐筆相同') });
    // 簽名圖逐張：匯出有簽名的每一筆，本機檔存在且 sha256＋長度與下載當下相同
    const bk = new Map(reads.map((r) => [readKey(r), r])), badSig = [];
    const exp = d.reads.filter((r) => str(r.sigId));
    exp.forEach((r) => {
      const k = readKey(r), w = want[k], b = bk.get(k);
      let buf = null;
      try { if (b && b.sigId) buf = fs.readFileSync(path.join(dir, 'sigs', path.basename(b.sigId))); } catch (e) {}
      if (!w || !buf || buf.length !== w.len || sha(buf) !== w.sha) badSig.push(k);
    });
    out.push({ name: '簽名圖（逐張 sha256）', ok: !badSig.length,
      detail: `${exp.length - badSig.length}/${exp.length} 張相同` + (badSig.length ? `，有問題 ${badSig.length} 張（${badSig.slice(0, 3).join('、')}${badSig.length > 3 ? '…' : ''}）` : '') });
    let admin = {}; try { admin = JSON.parse(kv('admin') || '{}'); } catch (e) {}
    const secOk = kv('secret') === d.secret, admOk = admin.hash === d.admin.hash && str(admin.salt) === str(d.admin.salt) && Number(admin.ver || 1) === Number(d.admin.ver || 1);
    out.push({ name: '登入金鑰＋管理通行碼雜湊', ok: secOk && admOk, detail: (secOk ? 'secret 相同' : 'secret 不同') + '、' + (admOk ? '通行碼雜湊／版本相同' : '通行碼雜湊或版本不同') });
    return out;
  } finally { db.close(); }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.bad) { console.log('✗ ' + o.bad + '\n用法：node server/migrate.js [--dry-run] [--from <匯出檔>] [--save <路徑>] [--force] [--batch <n>]'); process.exit(2); }
  J.loadEnv(path.join(__dirname, '.env'));
  const dir = J.dataDir(process.env);
  let bridge = null;
  if (process.env.BRIDGE_URL && process.env.BRIDGE_KEY) bridge = require('./bridge.js').makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY);
  const r = await runMigrate(Object.assign(o, { dir, bridge }));
  process.exit(r.code);
}

if (require.main === module) main().catch((e) => { console.error('✗ 搬遷出錯：' + J.errText(e)); process.exit(1); });
module.exports = { runMigrate, verify, problems, dedupeReads, parseArgs, targetCounts, SIGS_MAX };
