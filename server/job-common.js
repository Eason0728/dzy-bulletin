/* 鼎兆元｜電子佈告欄 — 背景工作共用（server/mirror.js 每小時、server/daily.js 每日、server/restore.js 還原）
 * 背景工作與伺服器是兩個程序同時開同一個 bulletin.db，所以這裡**不經 makeSqliteStore**（#8 審查發現）：
 *   makeSqliteStore 會跑 CREATE TABLE／ALTER TABLE／PRAGMA journal_mode，而且 kv.secret 缺的時候會寫入一把新 secret——
 *   在正式庫上、伺服器開著時，這是危險的副作用。背景工作自己開一般連線＋busy_timeout，只做 SELECT、VACUUM INTO
 *   與 `UPDATE reads SET driveSigId`（只寫那一欄）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BUSY_MS = 5000;                                       // 與 store-sqlite.js 相同：等伺服器的寫入交易最多 5 秒

// server/.env（只補沒設的變數）；與 index.js 同一個格式
function loadEnv(file) {
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
}
function dataDir(env) { return path.resolve((env.DATA_DIR || path.join(env.HOME || '', 'dzy-bulletin-data')).replace(/^~/, env.HOME || '')); }

// 開正式庫：檔案不存在就丟錯（DatabaseSync 預設會默默建一個空檔，背景工作不該建庫）
function openDb(dir, opts) {
  const file = path.join(dir, 'bulletin.db');
  if (!fs.existsSync(file)) throw new Error('找不到資料庫 ' + file);
  const db = new DatabaseSync(file, opts && opts.readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = ' + BUSY_MS);
  return db;
}
const rows = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => Object.assign({}, r));
function counts(db) {
  const n = (t) => Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n);
  return { posts: n('posts'), staff: n('staff'), reads: n('reads'), log: n('log') };
}
const countText = (c) => `公告 ${c.posts}、同仁 ${c.staff}、已讀 ${c.reads}、紀錄 ${c.log}`;

// 台北時間戳（檔名用）：伺服器其他地方用 L.today()（Asia/Taipei），這裡同樣用時區格式化，不手算 +8h（#8 審查發現）
function taipeiStamp(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d || new Date()).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
}

function logsDir(dir) { const d = path.join(dir, 'logs'); fs.mkdirSync(d, { recursive: true }); return d; }
// 紀錄只寫進 logs/*.log；終端機手動執行時才同時印出（launchd 下 stdout 另有 *.out.log，不重複一份）
function logLine(dir, file, s) {
  const line = new Date().toISOString() + ' ' + s;
  if (process.stdout.isTTY) console.log(line);
  fs.appendFileSync(path.join(logsDir(dir), file), line + '\n');
}
function readLast(dir, file) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'logs', file), 'utf8')); } catch (e) { return null; } }
// 結果檔先寫暫存再改名：/health 或守門不會讀到寫一半的 JSON
function writeLast(dir, file, obj) {
  const p = path.join(logsDir(dir), file), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
// 工作鎖（logs/<name>.lock，內容＝PID）：同一個 DATA_DIR 同時只有一個持有者。
// PID 已不在、或鎖檔超過 maxAgeMs（預設 6 小時；防 PID 被別的程序重用後永遠跳過）就當作殘留、清掉重拿。
// 拿到回傳釋放函式，拿不到回傳 null。mirror.js／daily.js 各拿自己的鎖；restore.js 兩把都拿，換檔期間背景工作不會開庫。
function takeLock(dir, name, maxAgeMs) {
  const f = path.join(dir, 'logs', name + '.lock');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return () => { try { if (fs.readFileSync(f, 'utf8') === String(process.pid)) fs.unlinkSync(f); } catch (e) {} }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0, age = 0;
      try { pid = Number(fs.readFileSync(f, 'utf8')) || 0; age = Date.now() - fs.statSync(f).mtimeMs; } catch (x) { continue; }
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch (x) { alive = x.code === 'EPERM'; }
      if (alive && age < (maxAgeMs || 6 * 3600e3)) return null;
      try { fs.unlinkSync(f); } catch (x) {}
    }
  }
  return null;
}
function diskFreeMB(dir) { try { const s = fs.statfsSync(dir); return Math.floor(s.bavail * s.bsize / 1048576); } catch (e) { return null; } }
// 錯誤只留代碼與短句（結果檔是本機檔，/health 不會帶出，但也不要把整個 stack 寫進去）
const errText = (e) => String((e && (e.code ? e.code + ' ' : '') + (e.detail || e.message)) || e).slice(0, 300);

module.exports = { BUSY_MS, loadEnv, dataDir, openDb, rows, counts, countText, taipeiStamp, logLine, readLast, writeLast, takeLock, diskFreeMB, errText };
