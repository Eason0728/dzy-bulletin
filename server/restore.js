#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 還原腳本（還原演練與真正災難復原共用）
 * 用法：node server/restore.js <快照檔 bulletin-YYYY-MM-DD_HHmm.db.gz 或 .db> [--launchd]
 *   停伺服器 → 驗快照 → 換 DB（舊庫改名留著，不刪）→ 起伺服器 → 印筆數（與 logs/daily.log 那天的快照行同一個格式，直接比對）。
 *   --launchd：由本腳本 bootout／bootstrap 三個 job（com.dzy.bulletin、.mirror、.daily，~/Library/LaunchAgents/*.plist）；
 *              沒加就要自己先 bootout 三個 job、事後自己 bootstrap。
 *   不論哪種，換檔前一律確認：PORT 上沒有伺服器回應、lsof 查不到任何程序開著 bulletin.db／-wal／-shm、拿得到 mirror 與 daily 工作鎖；
 *   改名前再查一次沒有殘留的 -wal／-shm。任一條不成立就拒絕並說明原因（#14 S3）。
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

const JOBS = ['com.dzy.bulletin', 'com.dzy.bulletin.mirror', 'com.dzy.bulletin.daily'];

// 開著資料庫檔的 PID（lsof）；找不到 lsof 回 null。只查存在的檔（bulletin.db 本身與 -wal／-shm）。
// lsof 沒找到任何程序時 exit 1，那是正常情況。
function holders(base) {
  const files = ['', '-wal', '-shm'].map((s) => base + s).filter((f) => fs.existsSync(f));
  if (!files.length) return [];
  try { return execFileSync('lsof', ['-t', '--'].concat(files), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map(Number); }
  catch (e) { if (e.code === 'ENOENT') return null; return e.status === 1 ? [] : String(e.stdout || '').split('\n').filter(Boolean).map(Number); }
}
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

  // 1. 停伺服器與兩個背景工作。只看 PORT 不夠（伺服器卡住不回、跑在別的 PORT、mirror／daily 正拿著連線，#14 S3）：
  //    --launchd 時 bootout 三個 job；然後一律用 lsof 確認沒有任何程序開著 bulletin.db／-wal／-shm，並拿到 mirror 與 daily 兩把工作鎖。
  //    沒加 --launchd：手冊要求先手動 bootout 三個 job（伺服器有 KeepAlive，用 kill 停會被 launchd 10 秒內拉回來），這裡用 lsof 驗證。
  const uid = process.getuid ? process.getuid() : 0;
  const plistOf = (l) => path.join(process.env.HOME || '', 'Library/LaunchAgents', l + '.plist');
  const bootoutHint = JOBS.map((l) => `launchctl bootout gui/${uid}/${l}`).join('；');
  const locks = [];
  const refuse = (why) => { locks.forEach((r) => r()); try { fs.unlinkSync(tmp); } catch (e) {} throw new Error(why); };
  if (o.launchd) {
    JOBS.forEach((l) => launchctl(['bootout', `gui/${uid}/${l}`]));
    for (let i = 0; i < 20 && (await serverUp(port) || holders(dbFile).length); i++) await new Promise((ok) => setTimeout(ok, 500));
  }
  if (await serverUp(port)) refuse(`127.0.0.1:${port} 上的伺服器還開著，請先停止（${bootoutHint}）或加 --launchd`);
  const h1 = holders(dbFile);
  if (h1 === null) refuse('找不到 lsof，無法確認資料庫沒有被開著，拒絕還原');
  if (h1.length) refuse(`還有程序開著資料庫（PID ${h1.join(', ')}）：伺服器或 mirror／daily 還在跑，請先停止（${bootoutHint}）或加 --launchd`);
  for (const name of ['mirror', 'daily']) {
    const r = J.takeLock(dir, name);
    if (!r) refuse(`${name} 工作正在跑（logs/${name}.lock），請等它結束或先 bootout 再還原`);
    locks.push(r);
  }
  // 2. 換 DB：舊庫連同 -wal／-shm 改名留著（還原錯了還能換回來）
  const keep = dbFile + '.before-restore-' + J.taipeiStamp(new Date()) + '-' + process.pid;
  try {
    ['', '-wal', '-shm'].forEach((sfx) => { if (fs.existsSync(dbFile + sfx)) fs.renameSync(dbFile + sfx, keep + sfx); });
    if (o._afterMove) o._afterMove();                        // 測試用鉤子：模擬「舊庫改名後、新庫就位前」伺服器被拉起來
    // 改名前再檢查一次：這段空檔若有人（例如被 KeepAlive 拉起的伺服器）建了新庫或 -wal／-shm，套到還原的庫上會壞掉 → 拒絕
    const stray = ['', '-wal', '-shm'].filter((sfx) => fs.existsSync(dbFile + sfx));
    const h2 = holders(keep);
    if (stray.length || (h2 && h2.length)) {
      refuse(`換檔途中有程序重新開了資料庫（${stray.map((s) => 'bulletin.db' + s).join('、') || 'PID ' + h2.join(', ')}），拒絕還原；` +
        `舊庫保留在 ${path.basename(keep)}，請先停止所有 job 再處理`);
    }
    fs.renameSync(tmp, dbFile);
    if (fs.existsSync(keep)) say('舊資料庫已改名保留：' + path.basename(keep));
  } finally { locks.forEach((r) => r()); locks.length = 0; }
  // 3. 起伺服器與兩個背景工作
  if (o.launchd) {
    JOBS.forEach((l) => launchctl(['bootstrap', `gui/${uid}`, plistOf(l)]));
    let up = false;
    for (let i = 0; i < 60 && !(up = await serverUp(port)); i++) await new Promise((ok) => setTimeout(ok, 500));
    say(up ? '伺服器與 mirror／daily 已重新載入' : '✗ 伺服器 30 秒內沒有起來，請看 launchd 紀錄');
  } else say('請重新載入三個 job：' + JOBS.map((l) => `launchctl bootstrap gui/${uid} ${plistOf(l)}`).join('；'));
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
