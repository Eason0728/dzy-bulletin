// node test/server.test.js — 啟動真的 Mac mini 伺服器（server/index.js，子程序）＋假 async 橋接，驗 #6 的伺服器驗收：
// 只聽 127.0.0.1、正式模式沒有測試入口、413／503、READONLY、無憑證不打橋接、阻塞測試、並發 p95、Node 版本檢查、/health 格式。
// 自給自足：自己找空埠、自己建暫存 DATA_DIR、跑完自己關；不連任何外部網址。
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server/index.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];

function freePort() {
  return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); });
}
function cleanEnv(extra) {
  const e = Object.assign({}, process.env);
  ['E2E', 'ALLOW_ORIGIN', 'BRIDGE_URL', 'BRIDGE_KEY', 'MAX_INFLIGHT_MB', 'BRIDGE_FAKE_DELAY_MS', 'DZYB_NODE_VERSION', 'PORT', 'DATA_DIR'].forEach((k) => delete e[k]);
  return Object.assign(e, extra);
}
// 啟動伺服器；回傳 { port, dir, out(), stop() }。啟動失敗（程序結束）時回傳 { code, stderr }
async function start(env) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-srv-')); tmps.push(dir);
  const p = spawn(process.execPath, [SERVER_JS], { env: cleanEnv(Object.assign({ PORT: String(port), DATA_DIR: dir }, env)), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
  return new Promise((ok) => {
    const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok({ port, dir, proc: p, out: () => out, err: () => err, stop: () => p.kill() }); } }, 20);
    p.on('exit', (code) => { clearInterval(t); ok({ code, stderr: err, stdout: out }); });
  });
}
// HTTP 請求（每次新連線）；body 可為物件（JSON）、Buffer／字串；opts.chunked＝不帶 Content-Length
function request(port, method, p, body, opts) {
  opts = opts || {};
  return new Promise((ok, no) => {
    const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = Object.assign({ 'Content-Type': 'text/plain' }, opts.headers || {});
    if (buf && !opts.chunked) headers['Content-Length'] = buf.length;
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6, txt = Buffer.concat(cs).toString();
        let json = null; try { json = JSON.parse(txt); } catch (e) {}
        ok({ status: res.statusCode, headers: res.headers, json, ms });
      });
    });
    r.on('error', (e) => ok({ status: 0, error: e.code || e.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    if (buf) {
      if (opts.chunked) { for (let i = 0; i < buf.length; i += 1 << 20) r.write(buf.subarray(i, i + (1 << 20))); }
      else r.write(buf);
    }
    r.end();
  });
}
const api = (s, action, q) => request(s.port, 'POST', '/', Object.assign({}, q || {}, { action }));
const p95 = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a[Math.ceil(a.length * 0.95) - 1]; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function login(s) {   // 以 demo 資料建一個同仁憑證＋主管憑證
  await request(s.port, 'POST', '/__seed', { demo: true });
  const tok = (await api(s, 'setPin', { staffId: 'S-013', pin: '2580' })).json.data.token;
  const at = (await api(s, 'adminLogin', { pass: '1234' })).json.data.atoken;
  return { tok, at };
}
const calls = async (s) => (await request(s.port, 'GET', '/__bridgeCalls')).json.data;

async function main() {
  // ---- Node 版本檢查 ----
  const { nodeProblem, MIN_NODE } = require('../server/index.js');
  eq('MIN_NODE is 24', MIN_NODE, 24);
  eq('node 24 ok', [nodeProblem('24.0.0'), nodeProblem('v26.5.0')], ['', '']);
  eq('node 23/22 rejected', [!!nodeProblem('23.4.0'), !!nodeProblem('22.13.1')], [true, true]);
  { const r = await start({ E2E: '1', DZYB_NODE_VERSION: '22.13.1' });
    eq('old node exits with needed version', [r.code, /Node 24/.test(r.stderr || '')], [1, true]); }

  // ---- E2E 模式遇正式網域拒絕啟動 ----
  { const r = await start({ E2E: '1', ALLOW_ORIGIN: 'https://dzy-bulletin.github.io' });
    eq('E2E with prod ALLOW_ORIGIN refuses to start', [r.code, /拒絕啟動/.test(r.stderr || '')], [1, true]); }

  // ---- 正式模式（無 E2E）----
  const P = await start({});
  eq('prod server started', typeof P.port, 'number');
  { let lines = [];
    try { lines = execFileSync('lsof', ['-nP', '-iTCP:' + P.port, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean); } catch (e) {}
    eq('listens on 127.0.0.1 only (lsof)', [lines.length > 0, lines.every((l) => /127\.0\.0\.1:/.test(l))], [true, true]); }
  { const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (ext) {
      const refused = await new Promise((ok) => { const c = net.connect(P.port, ext.address); c.on('connect', () => { c.destroy(); ok(false); }); c.on('error', () => ok(true)); });
      eq('not reachable on LAN address', refused, true);
    } }
  eq('prod POST /__seed is 404', (await request(P.port, 'POST', '/__seed', { demo: true })).status, 404);
  eq('prod GET /__blob is 404', (await request(P.port, 'GET', '/__blob?id=x')).status, 404);
  { const h = await request(P.port, 'GET', '/health');
    eq('health shape', Object.keys(h.json).sort(), ['backup', 'bridge', 'disk', 'e2e', 'mirror', 'ok', 'uptime', 'v']);
    eq('health prod values', [h.json.ok, h.json.e2e, h.json.bridge, h.json.mirror, h.json.backup, typeof h.json.disk.freeMB], [true, false, 'missing', null, null, 'number']);
    eq('response has Content-Length', Number(h.headers['content-length']) > 0, true); }
  { fs.mkdirSync(path.join(P.dir, 'logs'));
    fs.writeFileSync(path.join(P.dir, 'logs/mirror-last.json'), JSON.stringify({ at: '2026-09-30T01:00:00Z', ok: false, sigPending: 3, error: '/Users/secret/path 失敗' }));
    fs.writeFileSync(path.join(P.dir, 'logs/backup-last.json'), JSON.stringify({ at: '2026-09-30T03:00:00Z', ok: true, file: '/Users/x/b.db' }));
    const h = (await request(P.port, 'GET', '/health')).json;
    eq('health mirror/backup status only', [h.mirror, h.backup], [{ at: '2026-09-30T01:00:00Z', ok: false, sigPending: 3 }, { at: '2026-09-30T03:00:00Z', ok: true }]); }
  { const big = Buffer.alloc(41 * 1024 * 1024, 0x41);
    eq('41MB body → 413', (await request(P.port, 'POST', '/', big)).status, 413);
    eq('41MB chunked body → 413', (await request(P.port, 'POST', '/', big, { chunked: true })).status, 413);
    eq('server alive after 413', (await api(P, 'roster')).status, 200); }
  { await api(P, 'login', { staffId: 'S-001', pin: '97531' });
    const lines = P.out().split('\n');
    eq('one log line per request: time action ms ok/code', [lines.some((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z roster \d+ms ok$/.test(l)), lines.some((l) => /^\S+Z login \d+ms NOT_FOUND$/.test(l))], [true, true]);
    eq('log has no parameters', /97531|S-001/.test(P.out()), false); }
  P.stop();

  // ---- E2E 伺服器（假橋接每個動作延遲 10 秒）----
  const A = await start({ E2E: '1', BRIDGE_FAKE_DELAY_MS: '10000' });
  const { tok, at } = await login(A);
  eq('e2e health flag', (await request(A.port, 'GET', '/health')).json.e2e, true);

  // 無有效管理憑證：不會打橋接
  { const c0 = await calls(A);
    const rs = await Promise.all([
      api(A, 'uploadFile', { name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'uploadFile', { atoken: 'A.1.99999999999999.bad', name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'uploadFile', { atoken: tok, name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'syncClock', {}),
      api(A, 'syncClock', { atoken: 'A.1.99999999999999.bad' }),
      api(A, 'savePost', { post: { title: 't', units: ['mala'], publishOn: '2026-09-30', files: [{ id: 'F-9', name: 'x.pdf' }] } }),
      api(A, 'uploadFile', { atoken: at, name: 'evil.exe', data: 'AAAA' }),                                   // 有憑證但格式錯：也不打橋接
      api(A, 'savePost', { atoken: at, post: { title: '', units: ['mala'], publishOn: '2026-09-30', files: [{ id: 'F-9', name: 'x.pdf' }] } })   // 格式錯的公告不先分享附件
    ]);
    eq('unauthorized codes', rs.map((r) => r.json.code), ['AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'BAD_TYPE', 'BAD_REQ']);
    eq('unauthorized all fast (no bridge wait)', rs.every((r) => r.ms < 1000), true);
    const c1 = await calls(A);
    eq('no bridge calls without valid admin token', [c1.upload - c0.upload, c1.clock - c0.clock, c1.share - c0.share], [0, 0, 0]); }

  // 阻塞測試：upload／share／clock 延遲 10 秒、quota 背景刷新也延遲 10 秒，期間 board 與 adminData 照常 1 秒內回
  { const c0 = await calls(A);
    const slow = [
      api(A, 'uploadFile', { atoken: at, name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'syncClock', { atoken: at }),
      api(A, 'savePost', { atoken: at, post: { title: '附件公告', units: ['mala'], publishOn: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), files: [{ id: 'F-77', name: 'x.pdf' }] } })
    ];
    await sleep(200);
    const fast = await Promise.all([api(A, 'board', { token: tok }), api(A, 'adminData', { atoken: at }), api(A, 'roster')]);
    eq('board < 1s while bridge busy', [fast[0].json.ok, fast[0].ms < 1000], [true, true]);
    eq('adminData < 1s while quota slow (reads cache)', [fast[1].json.ok, fast[1].ms < 1000], [true, true]);
    eq('roster < 1s while bridge busy', [fast[2].json.ok, fast[2].ms < 1000], [true, true]);
    const sl = await Promise.all(slow);
    eq('upload finished after delay', [sl[0].json.ok, sl[0].json.data && sl[0].json.data.type, sl[0].ms >= 9500], [true, 'pdf', true]);
    eq('syncClock finished after delay', [sl[1].json.ok, Array.isArray(sl[1].json.data && sl[1].json.data.added), sl[1].ms >= 9500], [true, true, true]);
    eq('savePost with file finished after share', [sl[2].json.ok, sl[2].ms >= 9500], [true, true]);
    const c1 = await calls(A);
    eq('adminData never calls quota on request path', c1.quota - c0.quota, 0);
    eq('each slow op hit bridge once', [c1.upload - c0.upload, c1.clock - c0.clock, c1.share - c0.share], [1, 1, 1]); }

  // READONLY 凍結開關
  { fs.writeFileSync(path.join(A.dir, 'READONLY'), '');
    const r1 = await api(A, 'ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/jpeg;base64,AA' });
    eq('READONLY: ack → MOVED', [r1.json.code, r1.json.message], ['MOVED', '系統搬家中，請稍後重新整理']);
    eq('READONLY: board still ok', (await api(A, 'board', { token: tok })).json.ok, true);
    eq('READONLY: login → MOVED', (await api(A, 'login', { staffId: 'S-013', pin: '2580' })).json.code, 'MOVED');
    fs.unlinkSync(path.join(A.dir, 'READONLY'));
    eq('READONLY removed: ack ok', (await api(A, 'ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/jpeg;base64,AA' })).json.ok, true); }

  // 並發 50 個 board
  { const rs = await Promise.all(Array.from({ length: 50 }, () => api(A, 'board', { token: tok })));
    const ms = rs.map((r) => r.ms);
    eq('50 concurrent board all 200 ok', rs.every((r) => r.status === 200 && r.json.ok), true);
    eq('50 concurrent board p95 < 300ms', p95(ms) < 300 ? true : p95(ms), true); }
  A.stop();

  // ---- 請求體總量上限 1MB：同時 3 個 600KB，至少 1 個 503 ----
  const B = await start({ E2E: '1', MAX_INFLIGHT_MB: '1', BRIDGE_FAKE_DELAY_MS: '2000' });
  { const { at: atB } = await login(B);
    const data = 'A'.repeat(600 * 1024);
    const rs = await Promise.all([0, 1, 2].map(() => api(B, 'uploadFile', { atoken: atB, name: 'a.pdf', data })));
    const busy = rs.filter((r) => r.status === 503);
    eq('inflight cap: at least one 503 BUSY', [busy.length >= 1, busy.every((r) => r.json && r.json.code === 'BUSY')], [true, true]);
    eq('inflight cap: at least one accepted', rs.some((r) => r.status === 200 && r.json.ok), true);
    eq('inflight released after response', (await api(B, 'uploadFile', { atoken: atB, name: 'a.pdf', data })).json.ok, true); }
  B.stop();

  // ---- 真橋接（async fetch）對本機假 Apps Script：302 轉址、錯誤碼、逾時 ----
  { const { makeBridge } = require('../server/bridge.js');
    let got = null;
    const gas = http.createServer((req, res) => {
      if (req.url === '/exec') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = JSON.parse(b); res.writeHead(302, { Location: '/echo?op=' + got.op }); res.end(); }); return; }
      const op = new URL(req.url, 'http://x').searchParams.get('op');
      if (op === 'slow') return;                                              // 永不回應 → 逾時
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(op === 'bad' ? { ok: false, code: 'BAD_REQ', message: '不行' } : { ok: true, data: { op, method: req.method } }));
    });
    await new Promise((ok) => gas.listen(0, '127.0.0.1', ok));
    const br = makeBridge('http://127.0.0.1:' + gas.address().port + '/exec', 'k');
    const r = await br.call('quota', { x: 1 });
    eq('real bridge follows 302 (POST→GET like curl -L)', [r, got.key, got.x], [{ op: 'quota', method: 'GET' }, 'k', 1]);
    let e1 = null; try { await br.call('bad'); } catch (e) { e1 = [e.code, e.message]; }
    eq('real bridge error code passthrough', e1, ['BAD_REQ', '不行']);
    const t0 = Date.now(); let e2 = null; try { await br.call('slow', {}, 0.3); } catch (e) { e2 = e.code; }
    eq('real bridge timeout via AbortSignal', [e2, Date.now() - t0 < 2000], ['SERVER', true]);
    let e3 = null; try { await makeBridge('', '').call('quota'); } catch (e) { e3 = e.message; }
    eq('real bridge missing config', e3, '未設定 Google 橋接');
    gas.closeAllConnections(); gas.close(); }

  // ---- store 單元：req:* 過期清除 ----
  { const { makeSqliteStore } = require('../server/store-sqlite.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-st-')); tmps.push(dir);
    const st = makeSqliteStore(dir);
    st.kvSet('req:old', JSON.stringify({ v: 'x', exp: Date.now() - 1000 }));
    st.putReq('new', 'y');
    eq('purgeReqs removes only expired', [st.purgeReqs(Date.now()), st.kvGet('req:old'), st.getReq('new')], [1, null, 'y']);
    st.close(); }
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`server: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
