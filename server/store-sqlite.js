/* 鼎兆元｜電子佈告欄 — Mac mini 伺服器的資料層（Service.js 的 store 介面，SQLite＋簽名圖存硬碟）
 * 與 gas/Store.js 同一套介面：getPosts savePost getStaff saveStaff getReads addRead getSigs addLog getAdmin setAdmin secret getReq putReq
 * 另有 tx(fn)：一個寫入請求包成一筆交易（只有 Service.WRITE_ACTIONS 會用）；purgeReqs()：清過期的冪等紀錄；
 * kvGet／kvSet：伺服器自用的小快取（例如雲端空間）；dump()／load()：搬遷與鏡像用。 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function makeSqliteStore(dir) {
  const sigDir = path.join(dir, 'sigs');
  fs.mkdirSync(sigDir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'bulletin.db'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reads (postId TEXT NOT NULL, staffId TEXT NOT NULL, name TEXT, unit TEXT, at TEXT, sigId TEXT,
                                      PRIMARY KEY (postId, staffId));
    CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, action TEXT, target TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
  const kvGet = db.prepare('SELECT v FROM kv WHERE k = ?');
  const kvSet = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  const kvDel = db.prepare('DELETE FROM kv WHERE k = ?');
  // req:* 的過期只在被讀到時才刪 → 每次寫入交易順手清（#6 審查發現 5）
  const reqPurge = db.prepare("DELETE FROM kv WHERE k LIKE 'req:%' AND json_extract(v, '$.exp') < ?");
  const get = (k) => { const r = kvGet.get(k); return r ? r.v : null; };
  const set = (k, v) => kvSet.run(k, String(v));
  const upsertPost = db.prepare('INSERT INTO posts (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  const upsertStaff = db.prepare('INSERT INTO staff (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  const insRead = db.prepare('INSERT OR IGNORE INTO reads (postId, staffId, name, unit, at, sigId) VALUES (?, ?, ?, ?, ?, ?)');
  const insLog = db.prepare('INSERT INTO log (at, action, target, summary) VALUES (?, ?, ?, ?)');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  const adminInitFile = path.join(dir, 'ADMIN_INIT.txt');      // Eason 更換通行碼：在 Mac mini 建這個檔（內容＝新通行碼）

  if (!get('secret')) set('secret', crypto.randomBytes(32).toString('hex'));

  const store = {
    getPosts: () => db.prepare('SELECT json FROM posts ORDER BY rowid').all().map((r) => JSON.parse(r.json)),
    savePost: (p) => { upsertPost.run(p.id, JSON.stringify(p)); },
    getStaff: () => db.prepare('SELECT json FROM staff ORDER BY rowid').all().map((r) => JSON.parse(r.json)),
    saveStaff: (s) => { upsertStaff.run(s.id, JSON.stringify(s)); },
    getReads: () => db.prepare('SELECT postId, staffId, name, unit, at, sigId FROM reads ORDER BY rowid').all().map((r) => Object.assign({}, r)),
    addRead: (r) => {
      let sigId = '';
      const m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(String(r.sig || ''));
      if (m) {
        sigId = safe(r.postId) + '_' + safe(r.staffId) + (m[2] === 'png' ? '.png' : '.jpg');
        fs.writeFileSync(path.join(sigDir, sigId), Buffer.from(m[3], 'base64'));
      }
      insRead.run(r.postId, r.staffId, r.name, r.unit, r.at, sigId);
    },
    getSigs: (postId) => {
      const out = {};
      db.prepare('SELECT staffId, sigId FROM reads WHERE postId = ?').all(postId).forEach((r) => {
        if (!r.sigId) return;
        try {
          const b = fs.readFileSync(path.join(sigDir, path.basename(r.sigId)));
          out[r.staffId] = 'data:image/' + (r.sigId.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + b.toString('base64');
        } catch (e) { out[r.staffId] = null; }
      });
      return out;
    },
    addLog: (e) => { insLog.run(e.at, e.action, e.target || '', e.summary || ''); },
    getAdmin: () => {
      const a = JSON.parse(get('admin') || '{}');
      let init = '';
      try { init = fs.readFileSync(adminInitFile, 'utf8').trim(); } catch (e) {}
      return { hash: a.hash || '', salt: a.salt || '', init, ver: Number(a.ver) || 1, fail: Number(a.fail) || 0, lockUntil: Number(a.lockUntil) || 0 };
    },
    setAdmin: (a) => {
      set('admin', JSON.stringify({ hash: a.hash || '', salt: a.salt || '', ver: a.ver || 1, fail: a.fail || 0, lockUntil: a.lockUntil || 0 }));
      if (!a.init) { try { fs.unlinkSync(adminInitFile); } catch (e) {} }   // 轉成雜湊後刪掉明碼檔
    },
    secret: () => get('secret'),
    getReq: (rid) => {
      const v = get('req:' + rid); if (!v) return null;
      const o = JSON.parse(v); if (o.exp < Date.now()) { kvDel.run('req:' + rid); return null; }
      return o.v;
    },
    putReq: (rid, v) => { set('req:' + rid, JSON.stringify({ v, exp: Date.now() + 6 * 3600e3 })); },
    purgeReqs: (nowMs) => Number(reqPurge.run(nowMs || Date.now()).changes),
    kvGet: get,
    kvSet: set,

    // 一個寫入請求一筆交易（Service 的寫入全部成功或全部不寫；Service 自己會把錯誤轉成回應，所以一律 COMMIT）
    // 只包同步的程式碼：橋接（await）一律在 tx 外做完，寫鎖不會被 Google 佔住。
    tx: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    // 搬遷／鏡像
    dump: () => ({
      posts: store.getPosts(), staff: store.getStaff(), reads: store.getReads(),
      log: db.prepare('SELECT at, action, target, summary FROM log ORDER BY seq').all().map((r) => Object.assign({}, r)),
      admin: JSON.parse(get('admin') || '{}')
    }),
    load: (d) => {                                            // 匯入（清空後寫入）；簽名圖另外放進 sigs/
      store.tx(() => {
        db.exec("DELETE FROM posts; DELETE FROM staff; DELETE FROM reads; DELETE FROM log; DELETE FROM kv WHERE k LIKE 'req:%';");
        (d.posts || []).forEach((p) => upsertPost.run(p.id, JSON.stringify(p)));
        (d.staff || []).forEach((s) => upsertStaff.run(s.id, JSON.stringify(s)));
        (d.reads || []).forEach((r) => insRead.run(r.postId, r.staffId, r.name, r.unit, r.at, r.sigId || ''));
        (d.log || []).forEach((e) => insLog.run(e.at, e.action, e.target || '', e.summary || ''));
        if (d.admin) set('admin', JSON.stringify(d.admin));
        if (d.secret) set('secret', d.secret);
      });
    },
    sigDir,
    close: () => db.close()
  };
  return store;
}

module.exports = { makeSqliteStore };
