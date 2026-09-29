#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — Mac mini 伺服器（Node.js，無第三方套件）
 * 商業邏輯沿用 gas/Service.js（與 Apps Script、本機假資料同一份），資料用 SQLite，簽名圖存硬碟，Google 動作走橋接。
 *
 * 環境變數（正式設定寫在 server/.env，不進 git）：
 *   PORT=8793  DATA_DIR=~/dzy-bulletin-data  BRIDGE_URL=<Apps Script 網址>  BRIDGE_KEY=<與 Apps Script 指令碼屬性相同>
 *   ALLOW_ORIGIN=https://dzy-bulletin.github.io   E2E=1（只在測試時開：/__seed、/__clock 等測試入口）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
loadEnv(path.join(__dirname, '.env'));
const L = require(path.join(ROOT, 'js/logic.js'));
const { makeAuth_ } = require(path.join(ROOT, 'gas/Auth.js'));
const { makeService_ } = require(path.join(ROOT, 'gas/Service.js'));
const { makeSqliteStore } = require('./store-sqlite.js');
const { makeBridge, makeFakeBridge } = require('./bridge.js');

const VERSION = (/VERSION: '([0-9.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')) || [])[1] || '?';
const PORT = Number(process.env.PORT || 8793);
const DATA_DIR = (process.env.DATA_DIR || path.join(process.env.HOME, 'dzy-bulletin-data')).replace(/^~/, process.env.HOME);
const E2E = process.env.E2E === '1';
const ALLOW = (process.env.ALLOW_ORIGIN || 'https://dzy-bulletin.github.io').split(',').map((s) => s.trim());
const MAX_BODY = 40 * 1024 * 1024;                          // 附件 20MB → base64 約 27MB

const nodeCrypto = {
  sha256Hex: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'),
  randomHex: (n) => crypto.randomBytes(n).toString('hex')
};
const auth = makeAuth_(nodeCrypto, L);
const store = makeSqliteStore(DATA_DIR);
const bridge = (process.env.BRIDGE_URL && !E2E) ? makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY) : makeFakeBridge();
let clockOffsetMs = 0;                                      // 只有 E2E 會改
const clock = { nowMs: () => Date.now() + clockOffsetMs, today: () => L.today(new Date(Date.now() + clockOffsetMs)) };
const svc = makeService_(L, store, bridge.files, auth, clock, bridge.clockSrc);

function loadEnv(file) {
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
}

function cors(req, res) {
  const o = req.headers.origin || '';
  const ok = ALLOW.includes(o) || (E2E && /^http:\/\/localhost(:\d+)?$/.test(o));
  if (ok) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { no(new Error('TOO_BIG')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', no);
  });
}

// ---- 測試入口（E2E=1 才有）：以帶入格式重設資料，密碼用真的雜湊 ----
function seed(d) {
  const staff = d.staff.map((x) => {
    const salt = x.pin ? auth.newSalt() : '';
    return { id: x.id, name: x.name, unit: x.unit, salt, pinHash: x.pin ? auth.hashPin(salt, x.pin) : '', pinVer: 1, fail: x.fail || 0,
      active: true, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: '', src: x.src || '', store: x.store || '' };
  });
  const posts = d.posts.map((p) => Object.assign({ body: '', expiresOn: '', pinned: false, published: true, offOn: '', files: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, p));
  const reads = d.reads.map((r) => { const s = staff.find((x) => x.id === r.staffId); return { postId: r.postId, staffId: r.staffId, name: s.name, unit: s.unit, at: r.at, sigId: '' }; });
  store.load({ posts, staff, reads, log: [], admin: {} });
  fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_INIT.txt'), d.adminPass);
  if (bridge.setClock) bridge.setClock(d.clock || []);
}

async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    let daily = null; try { daily = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs', 'daily-last.json'), 'utf8')); } catch (e) {}
    return send(res, 200, { ok: true, data: { app: 'dzy-bulletin-server', v: VERSION, uptime: Math.round(process.uptime()), daily } });
  }
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true, data: { app: 'dzy-bulletin-server', v: VERSION } });
  if (E2E && url.pathname.startsWith('/__')) {
    const body = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : {};
    if (url.pathname === '/__seed') { seed(body.demo ? require(path.join(ROOT, 'js/demo-data.js'))(L) : body); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__clock') { clockOffsetMs = (Number(body.offDays) || 0) * 86400e3; return send(res, 200, { ok: true, data: { today: clock.today() } }); }
    if (url.pathname === '/__clockActive') { const rows = bridge.clockSrc.read().rows; rows.forEach((r) => { if (r.empId === body.empId) r.active = !!body.on; }); bridge.setClock(rows); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__adminInit') { fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_INIT.txt'), String(body.pass)); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__blob') return send(res, 200, { ok: true, data: bridge.blobOf(url.searchParams.get('id')) });
    return send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'no' });
  }
  if (req.method !== 'POST') return send(res, 404, { ok: false, code: 'NOT_FOUND', message: '找不到' });
  let q;
  try { q = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.message === 'TOO_BIG' ? 413 : 400, { ok: false, code: e.message === 'TOO_BIG' ? 'TOO_BIG' : 'BAD_REQ', message: '格式錯誤' }); }
  const action = String(q && q.action || '');
  const t0 = Date.now();
  let out;
  try { out = store.tx(() => svc.call(action, q)); }
  catch (e) { console.error(action + ': ' + (e && e.stack || e)); out = { ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' }; }
  const ms = Date.now() - t0;
  if (ms > 2000) console.log(new Date().toISOString() + ' 慢請求 ' + action + ' ' + ms + 'ms');
  send(res, 200, out);
}

if (require.main === module) {
  http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { ok: false, code: 'SERVER', message: '系統忙碌' }); } catch (x) {} }); })
    .listen(PORT, '127.0.0.1', () => console.log(new Date().toISOString() + ` 佈告欄伺服器 v${VERSION} 啟動：127.0.0.1:${PORT}，資料 ${DATA_DIR}${E2E ? '（E2E 測試模式）' : ''}`));
}
module.exports = { handle, store, svc };
