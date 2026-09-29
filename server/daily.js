#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 每日 DB 快照（launchd com.dzy.bulletin.daily，每天 03:30；錯過的班 launchd 會在喚醒後補跑）
 *   VACUUM INTO 取一致性快照（伺服器開著也安全：WAL＋busy_timeout）→ gzip → 經橋接 `backup` op 上傳雲端「鼎兆元｜電子佈告欄備份」資料夾。
 *   保留策略【#8 定案 r2】：本機 DATA_DIR/backups 留 14 天（這裡清）、雲端留 30 天（Apps Script saveBackup_ 清）。不加密（金鑰與備份同生共死）。
 *   不再每天打包簽名圖：簽名圖的異地備份是 mirror.js 的 Drive 回填（driveSigId）。
 * 不經 makeSqliteStore（見 job-common.js）：只開一般連線做 VACUUM INTO，不建表、不動 kv.secret。
 * 結果寫 DATA_DIR/logs/backup-last.json＝{ at, ok, file, sizeKB, diskFreeMB, counts, sharedWith }；每次一行進 logs/daily.log，
 * 行內的筆數（公告／同仁／已讀／紀錄）就是還原演練要比對的數字（server/restore.js 印同一個格式）。
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env） */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const J = require('./job-common.js');

const LAST = 'backup-last.json';
const KEEP_LOCAL_DAYS = 14;
// 上傳上限 14MB（gzip 後）：Apps Script Web App 的 POST 本體實際上限約 50MB（官方未明寫），檔案經 base64 會膨脹 4/3、
// doPost 裡 JSON.parse 與 Utilities.base64Decode 又各佔一份記憶體，保守取 14MB。DB 本身只有幾 MB，一般碰不到；
// 真的超過就 ok:false（守門會黃燈），不再像草稿那樣默默「只留本機」。
const MAX_UPLOAD = 14 * 1024 * 1024;
const SNAP_RE = /^bulletin-\d{4}-\d{2}-\d{2}_\d{4}\.db(\.gz)?$/;

// 本機保留：只清自己產生的快照檔名（bulletin-YYYY-MM-DD_HHmm.db.gz），依修改時間，超過 keepDays 天就刪
function pruneLocal(bkDir, keepDays, nowMs) {
  const cut = (nowMs || Date.now()) - keepDays * 86400e3;
  let removed = 0;
  fs.readdirSync(bkDir).filter((f) => SNAP_RE.test(f)).forEach((f) => {
    const p = path.join(bkDir, f);
    try { if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); removed++; } } catch (e) {}
  });
  return removed;
}

async function runDaily(o) {
  const dir = o.dir, bridge = o.bridge, now = o.now || new Date();
  const bkDir = path.join(dir, 'backups'); fs.mkdirSync(bkDir, { recursive: true });
  const base = 'bulletin-' + J.taipeiStamp(now) + '.db';
  const raw = path.join(bkDir, base), gz = raw + '.gz';
  const res = { at: new Date().toISOString(), ok: false, file: null, sizeKB: null, diskFreeMB: null };
  const errs = [];
  try {
    try { fs.unlinkSync(raw); } catch (e) {}
    const db = J.openDb(dir);
    try { db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`); } finally { db.close(); }   // 一致性快照（WAL 裡已提交的也在內）
    const snap = new DatabaseSync(raw, { readOnly: true });
    try {
      const chk = snap.prepare('PRAGMA quick_check').get();
      if (Object.values(chk)[0] !== 'ok') throw new Error('快照檢查失敗');
      res.counts = J.counts(snap);
    } finally { snap.close(); }
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }));
    fs.unlinkSync(raw);
    const size = fs.statSync(gz).size;
    res.file = path.basename(gz); res.sizeKB = Math.ceil(size / 1024);
    J.logLine(dir, 'daily.log', `快照 ${res.file} ${res.sizeKB}KB：${J.countText(res.counts)}`);
    if (size > MAX_UPLOAD) throw new Error(`快照 ${Math.round(size / 1048576)}MB 超過上傳上限 14MB，只留本機`);
    const up = await bridge.call('backup', { name: res.file, data: fs.readFileSync(gz).toString('base64') }, 300);
    if (up && up.id) res.driveId = up.id;
    // 備份資料夾的共用者人數（M2 saveBackup_ 回傳；-1＝讀不到）。備份內含密碼雜湊與 TOKEN_SECRET，必須僅 owner（M6 權限清單）
    if (up && typeof up.sharedWith === 'number') res.sharedWith = up.sharedWith;
  } catch (e) {
    errs.push(J.errText(e));
    try { fs.unlinkSync(raw); } catch (x) {}               // 快照做到一半：不留未壓縮的暫存檔
  }
  try { res.removed = pruneLocal(bkDir, KEEP_LOCAL_DAYS, Date.now()); } catch (e) { errs.push('本機清理：' + J.errText(e)); }   // 上傳失敗也照樣清本機舊檔
  res.diskFreeMB = J.diskFreeMB(dir);
  res.ok = errs.length === 0;
  if (!res.ok) res.error = errs.join('；');
  J.writeLast(dir, LAST, res);
  J.logLine(dir, 'daily.log', (res.ok ? '備份完成' : '備份失敗') + `：${res.file || '（無檔）'}，本機清掉 ${res.removed || 0} 個舊快照，剩餘磁碟 ${res.diskFreeMB}MB` + (res.ok ? '' : '；' + res.error));
  return res;
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const res = await runDaily({ dir: J.dataDir(process.env), bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY) });
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runDaily, pruneLocal, KEEP_LOCAL_DAYS, MAX_UPLOAD };
