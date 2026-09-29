#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 每小時鏡像工作（launchd com.dzy.bulletin.mirror，StartInterval 3600；同一個 job 不會重疊）
 *   1. 簽名回填：找出 driveSigId 空白的已讀，批次（一次 10～20 張、一次橋接呼叫）經 `sigs` op 上傳到 Drive 簽名資料夾，
 *      回填 driveSigId（只寫這一欄）。每輪最多 SIG_MAX_PER_RUN 張，避免撞 Apps Script 6 分鐘上限。這同時是簽名圖的異地備份。
 *   2. 鏡像：Mac mini 正本整份寫回試算表四分頁（走 `mirror` op；Apps Script 先寫暫存分頁再換名，見 gas/Store.js）。
 *      已讀帶 driveSigId（Drive id），試算表「簽名檔 id」只寫它、還沒回填的留空——回退到 GAS 後 readSig(id) 才讀得到。
 *   先回填再鏡像：這一輪剛拿到的 Drive id 就跟著這一輪寫進試算表。
 * 失敗不在同一輪重試（橋接打的是會排隊的 Apps Script，重試只會更塞）；下一輪（一小時後）自然重做。
 * 結果寫 DATA_DIR/logs/mirror-last.json＝{ at, ok, uploaded, pending, fails, missing }，每輪一行進 logs/mirror.log。
 *   fails＝連續失敗次數（守門規則「mirror.ok=false 連續 2 次 → 黃」用）；missing＝有 sigId 但本機找不到圖檔的筆數（算在 pending 裡）。
 * 伺服器掛掉或橋接失敗都不影響同仁簽名：這支是獨立程序，只讀庫＋寫一欄。告警靠守門讀 /health 的 mirror.at（#8 監看判定）。
 *
 * 用法：node server/mirror.js          （launchd 每小時）
 *       node server/mirror.js --all    （回退前手動跑：不設每輪上限，回填到 pending=0 為止，見 #10）
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env）；SIG_BATCH（每批張數，預設 15、上限 20）；SIG_MAX_PER_RUN（預設 60） */
'use strict';
const fs = require('fs');
const path = require('path');
const J = require('./job-common.js');

const SIGS_MAX = 20;                                        // 與 gas/Code.js SIGS_MAX_ 相同：Apps Script 一次最多收 20 張
const LAST = 'mirror-last.json';

function clampInt(v, dflt, lo, hi) { const n = Math.floor(Number(v)); return n >= lo ? Math.min(n, hi) : dflt; }

// 同一個 DATA_DIR 同時只跑一輪（launchd 不會重疊，但回退時會有人手動跑 --all）：鎖檔記 PID，PID 不在了就當作殘留
function takeLock(dir) {
  const f = path.join(dir, 'logs', 'mirror.lock');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return () => { try { fs.unlinkSync(f); } catch (e) {} }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(f, 'utf8')) || 0;
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch (x) { alive = x.code === 'EPERM'; }
      if (alive && pid !== process.pid) return null;
      try { fs.unlinkSync(f); } catch (x) {}
    }
  }
  return null;
}

// 跑一輪；回傳結果物件（也寫進 mirror-last.json）。bridge 只需要 call(op, payload, timeoutSec)。
async function runMirror(o) {
  const dir = o.dir, bridge = o.bridge;
  const batch = clampInt(o.batch, 15, 1, SIGS_MAX);
  const maxPerRun = o.all ? Infinity : clampInt(o.maxPerRun, 60, 1, 100000);
  const prev = J.readLast(dir, LAST);
  const res = { at: new Date().toISOString(), ok: false, uploaded: 0, pending: null, fails: 0, missing: 0 };
  const errs = [];
  const release = takeLock(dir);
  if (!release) {   // 另一輪還在跑：不寫結果檔（那一輪會寫），也不算失敗
    J.logLine(dir, 'mirror.log', '另一輪鏡像還在跑，這次跳過');
    return Object.assign(res, { ok: true, skipped: true });
  }
  let db = null;
  try {
    db = J.openDb(dir);
    if (!db.prepare('PRAGMA table_info(reads)').all().some((c) => c.name === 'driveSigId')) throw new Error('資料庫還沒有 driveSigId 欄（伺服器升級後重新啟動一次即會補上）');
    const sigDir = path.join(dir, 'sigs');
    const PENDING_SQL = "FROM reads WHERE sigId <> '' AND driveSigId = ''";

    // ---- 1. 簽名回填 ----
    const todo = J.rows(db, 'SELECT postId, staffId, sigId ' + PENDING_SQL + ' ORDER BY rowid');
    const picked = [];
    for (const r of todo) {
      if (picked.length >= maxPerRun) break;
      const file = path.basename(r.sigId);                   // sigId 由 store-sqlite.js 產生（只有安全字元），basename 是多一道保險
      let b;
      try { b = fs.readFileSync(path.join(sigDir, file)); } catch (e) { res.missing++; continue; }   // 圖檔不見：跳過、不佔名額，但仍算 pending
      const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
      picked.push({ r, name: file.replace(/\.(png|jpe?g)$/i, ''), data: 'data:' + mime + ';base64,' + b.toString('base64') });
    }
    const upd = db.prepare("UPDATE reads SET driveSigId = ? WHERE postId = ? AND staffId = ? AND driveSigId = ''");   // 只寫這一欄；已有 id 的不覆蓋
    for (let i = 0; i < picked.length; i += batch) {
      const part = picked.slice(i, i + batch);
      let ids;
      try {
        const out = await bridge.call('sigs', { put: part.map((x) => ({ name: x.name, data: x.data })) }, 300);
        ids = out && out.ids;
        if (!Array.isArray(ids) || ids.length !== part.length || !ids.every((x) => typeof x === 'string' && x)) throw new Error('sigs 回傳的 Drive id 筆數不符');
      } catch (e) { errs.push('簽名回填：' + J.errText(e)); break; }   // 同一輪不重試，剩下的批次留給下一輪
      db.exec('BEGIN IMMEDIATE');
      try { part.forEach((x, k) => upd.run(ids[k], x.r.postId, x.r.staffId)); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} errs.push('回填寫入：' + J.errText(e)); break; }
      res.uploaded += part.length;
    }

    // ---- 2. 鏡像（四份一次送；缺任一份 Apps Script 會回 BAD_REQ）----
    const data = {
      posts: J.rows(db, 'SELECT json FROM posts ORDER BY rowid').map((r) => JSON.parse(r.json)),
      staff: J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => JSON.parse(r.json)),
      reads: J.rows(db, 'SELECT postId, staffId, name, unit, at, sigId, driveSigId FROM reads ORDER BY rowid'),
      log: J.rows(db, 'SELECT at, action, target, summary FROM log ORDER BY seq')
    };
    try {
      await bridge.call('mirror', { data }, 300);
      res.counts = { posts: data.posts.length, staff: data.staff.length, reads: data.reads.length, log: data.log.length };
    } catch (e) { errs.push('鏡像：' + J.errText(e)); }
    res.pending = Number(db.prepare('SELECT COUNT(*) AS n ' + PENDING_SQL).get().n);
  } catch (e) {
    errs.push(J.errText(e));
  } finally {
    try { if (db) db.close(); } catch (e) {}
    release();
  }
  res.ok = errs.length === 0;
  res.fails = res.ok ? 0 : (Number(prev && prev.fails) || 0) + 1;
  if (!res.ok) res.error = errs.join('；');
  J.writeLast(dir, LAST, res);
  J.logLine(dir, 'mirror.log', (res.ok ? '鏡像完成' : '鏡像失敗') + `：回填 ${res.uploaded} 張、待回填 ${res.pending}` +
    (res.missing ? `（其中本機缺圖 ${res.missing}）` : '') + (res.counts ? '、' + J.countText(res.counts) : '') + (res.ok ? '' : '；' + res.error));
  return res;
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const dir = J.dataDir(process.env);
  const res = await runMirror({ dir, bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY),
    batch: process.env.SIG_BATCH, maxPerRun: process.env.SIG_MAX_PER_RUN, all: process.argv.includes('--all') });
  process.exit(res.ok ? 0 : 1);                             // 非 0 讓 launchd 記錄失敗；真正的告警靠守門讀 /health
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runMirror, SIGS_MAX };
