#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 還原腳本（還原演練與真正災難復原共用）
 * 用法：node server/restore.js <快照檔 bulletin-YYYY-MM-DD_HHmm.db.gz 或 .db> [--launchd]
 *   停伺服器 → 驗快照 → 換 DB（舊庫改名留著，不刪）→ 起伺服器 → 印筆數（與 logs/daily.log 那天的快照行同一個格式，直接比對）。
 *   --launchd：由本腳本 bootout／bootstrap ~/Library/LaunchAgents/com.dzy.bulletin.plist；沒加就要自己先停、事後自己起，
 *              本腳本只檢查 PORT 上沒有伺服器在回應（有就拒絕，不在伺服器開著時換檔）。
 * 【Fable r2】不依賴任何秘密：只讀 DATA_DIR／PORT（環境變數或 server/.env），不碰 BRIDGE_KEY；
 *   快照本身就含 kv.secret 與管理雜湊，還原後同仁不用重新登入。簽名圖：本機 sigs/ 有就直接看得到；
 *   在乾淨的 DATA_DIR 上還原時本機沒有圖，已回填 driveSigId 的可從 Drive 簽名資料夾取回（印出筆數供核對）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const J = require('./job-common.js');

const LABEL = 'com.dzy.bulletin';
const TABLES = ['posts', 'staff', 'reads', 'log', 'kv'];

async function serverUp(port) {
  try { const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1500) }); return r.status > 0; } catch (e) { return false; }
}
function launchctl(args) { try { execFileSync('launchctl', args, { stdio: 'ignore' }); return true; } catch (e) { return false; } }

// 驗快照：完整性檢查＋五張表都在；回傳筆數
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const chk = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(chk)[0] !== 'ok') throw new Error('快照完整性檢查失敗');
    const have = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const miss = TABLES.filter((t) => have.indexOf(t) < 0);
    if (miss.length) throw new Error('快照缺資料表：' + miss.join('、'));
    return J.counts(db);
  } finally { db.close(); }
}

async function restore(o) {
  const dir = o.dir, src = path.resolve(o.file), port = o.port, say = o.say || console.log;
  if (!fs.existsSync(src)) throw new Error('找不到快照檔 ' + src);
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'bulletin.db'), tmp = dbFile + '.restoring';
  try { fs.unlinkSync(tmp); } catch (e) {}
  const buf = fs.readFileSync(src);
  fs.writeFileSync(tmp, /\.gz$/i.test(src) ? zlib.gunzipSync(buf) : buf);
  let counts;
  try { counts = inspect(tmp); } catch (e) { fs.unlinkSync(tmp); throw e; }
  say('快照檢查通過：' + J.countText(counts));

  // 1. 停伺服器
  const uid = process.getuid ? process.getuid() : 0;
  const plist = path.join(process.env.HOME || '', 'Library/LaunchAgents', LABEL + '.plist');
  if (o.launchd) { launchctl(['bootout', `gui/${uid}/${LABEL}`]); for (let i = 0; i < 20 && await serverUp(port); i++) await new Promise((ok) => setTimeout(ok, 500)); }
  if (await serverUp(port)) {
    fs.unlinkSync(tmp);
    throw new Error(`127.0.0.1:${port} 上的伺服器還開著，請先停止（launchctl bootout gui/${uid}/${LABEL}）或加 --launchd`);
  }
  // 2. 換 DB：舊庫連同 -wal／-shm 改名留著（還原錯了還能換回來）
  const keep = dbFile + '.before-restore-' + J.taipeiStamp(new Date()) + '-' + process.pid;
  ['', '-wal', '-shm'].forEach((sfx) => { if (fs.existsSync(dbFile + sfx)) fs.renameSync(dbFile + sfx, keep + sfx); });
  fs.renameSync(tmp, dbFile);
  if (fs.existsSync(keep)) say('舊資料庫已改名保留：' + path.basename(keep));
  // 3. 起伺服器
  if (o.launchd) {
    launchctl(['bootstrap', `gui/${uid}`, plist]);
    let up = false;
    for (let i = 0; i < 60 && !(up = await serverUp(port)); i++) await new Promise((ok) => setTimeout(ok, 500));
    say(up ? '伺服器已重新啟動' : '✗ 伺服器 30 秒內沒有起來，請看 launchd 紀錄');
  } else say('請啟動伺服器（launchctl bootstrap gui/' + uid + ' ' + plist + '）');
  // 4. 印筆數＋簽名圖可見度
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let sig;
  try {
    const cols = db.prepare('PRAGMA table_info(reads)').all().map((c) => c.name);
    const rs = db.prepare('SELECT sigId' + (cols.indexOf('driveSigId') >= 0 ? ', driveSigId' : ", '' AS driveSigId") + " FROM reads WHERE sigId <> ''").all();
    sig = { total: rs.length, local: 0, drive: 0, lost: 0 };
    rs.forEach((r) => {
      if (fs.existsSync(path.join(dir, 'sigs', path.basename(r.sigId)))) sig.local++;
      else if (r.driveSigId) sig.drive++;
      else sig.lost++;
    });
    counts = J.counts(db);
  } finally { db.close(); }
  say('還原完成：' + J.countText(counts));
  say(`簽名圖 ${sig.total} 張：本機有 ${sig.local}、只在 Drive ${sig.drive}、兩邊都沒有 ${sig.lost}`);
  return { counts, sig, kept: fs.existsSync(keep) ? keep : null };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('用法：node server/restore.js <快照檔.db.gz> [--launchd]'); process.exit(2); }
  J.loadEnv(path.join(__dirname, '.env'));
  try {
    await restore({ dir: J.dataDir(process.env), file, port: Number(process.env.PORT || 8793), launchd: args.includes('--launchd') });
  } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
}

if (require.main === module) main();
module.exports = { restore, inspect };
