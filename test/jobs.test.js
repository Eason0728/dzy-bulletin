// node test/jobs.test.js — M3（#8）：每小時鏡像與簽名回填（server/mirror.js）、每日快照（server/daily.js）、還原（server/restore.js）、/health 判定。
// A～C 段在程序內用假橋接物件（算呼叫次數）；D 段端到端：假 Google 載入 gas/*.js（test/fake-gas.js）＋真的 E2E 伺服器（子程序）
// ＋以子程序跑 mirror.js／daily.js／restore.js，經 server/bridge.js 真的打過去。自己找空埠、自己建暫存資料夾、只關自己開的程序；不連任何外部網址。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const { runMirror } = require('../server/mirror.js');
const { runDaily } = require('../server/daily.js');
const { restore } = require('../server/restore.js');
const { judgeHealth } = require('../server/health-rules.js');
const { makeFakeGas } = require('./fake-gas.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-job-')); tmps.push(d); return d; };
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
const last = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, 'logs', f), 'utf8'));
const q = (dir, sql) => { const db = new DatabaseSync(path.join(dir, 'bulletin.db'), { readOnly: true }); try { return db.prepare(sql).all().map((r) => Object.assign({}, r)); } finally { db.close(); } };
const PNG = (s) => 'data:image/png;base64,' + Buffer.from('簽名-' + s).toString('base64');
function freePort() { return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); }); }

// 假橋接物件：sigs 依序回 Drive id、mirror／backup 記下收到的內容；fail[op]＝這個 op 一律丟錯
function fakeBridge(fail) {
  const b = { calls: [], sizes: [], mirrored: null, backup: null, fail: fail || {}, idsShort: false };
  b.call = async (op, p) => {
    b.calls.push(op);
    if (b.fail[op]) { const e = new Error('Google 雲端暫時連不上，請稍後再試'); e.code = 'BRIDGE'; e.detail = op + ': 假錯誤'; throw e; }
    if (op === 'sigs') { b.sizes.push(p.put.length); const ids = p.put.map((x) => 'DRV-' + x.name); return { ids: b.idsShort ? ids.slice(1) : ids }; }
    if (op === 'mirror') { b.mirrored = JSON.parse(JSON.stringify(p.data)); return { counts: {} }; }
    if (op === 'backup') { b.backup = p; return { id: 'BK-1', size: 1, trashed: 0 }; }
    throw new Error('未知 op ' + op);
  };
  b.n = (op) => b.calls.filter((x) => x === op).length;
  return b;
}
// 建一個有資料的正式庫：同仁 30、公告 2；nSig 筆帶簽名圖的已讀＋1 筆沒簽名圖＋1 筆搬遷來的（已有 Drive id）
function seedDb(dir, nSig) {
  const st = makeSqliteStore(dir);
  const staff = Array.from({ length: 30 }, (_, i) => ({ id: 'S-' + String(i).padStart(3, '0'), name: '同仁' + i, unit: 'mala', active: true }));
  st.load({
    posts: [{ id: 'P-1', title: '公告一', units: ['mala'] }, { id: 'P-2', title: '公告二', units: ['mala'] }],
    staff,
    reads: [{ postId: 'P-2', staffId: 'S-029', name: '同仁29', unit: 'mala', at: '2026-09-29T01:00:00.000Z', sigId: 'OLD_S-029.png', driveSigId: 'DRV-OLD' }],
    log: [{ at: '2026-09-30T01:00:00.000Z', action: 'ack', target: 'P-1', summary: '簽名' }]
  });
  fs.writeFileSync(path.join(st.sigDir, 'OLD_S-029.png'), 'old');
  for (let i = 0; i < nSig; i++) st.addRead({ postId: 'P-1', staffId: staff[i].id, name: staff[i].name, unit: 'mala', at: '2026-09-30T02:00:0' + (i % 10) + '.000Z', sig: PNG(i) });
  st.addRead({ postId: 'P-2', staffId: 'S-000', name: '同仁0', unit: 'mala', at: '2026-09-30T03:00:00.000Z', sig: '' });   // 沒簽名圖
  st.close();
}

// 子程序：跑一支 server/*.js（只帶指定的環境變數＋PATH／HOME，不繼承 BRIDGE_* 等）
function runJob(script, args, env) {
  return new Promise((ok) => {
    const e = Object.assign({ PATH: process.env.PATH, HOME: env.HOME || tmp('dzyb-home-') }, env);
    const p = spawn(process.execPath, [path.join(ROOT, 'server', script)].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => ok({ code, out, err }));
  });
}
async function startServer(dir, extra) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: Object.assign({ PATH: process.env.PATH, HOME: tmp('dzyb-home-'), PORT: String(port), DATA_DIR: dir }, extra || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', () => {});
  await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
  return { port, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.on('exit', () => ok()); p.kill(); }) };
}
function request(port, method, p, body) {
  return new Promise((ok) => {
    const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: buf ? { 'Content-Type': 'text/plain', 'Content-Length': buf.length } : {}, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {} ok({ status: res.statusCode, json }); });
    });
    r.on('error', (e) => ok({ status: 0, error: e.code }));
    if (buf) r.write(buf);
    r.end();
  });
}
const api = (port, action, body) => request(port, 'POST', '/', Object.assign({}, body || {}, { action }));

async function main() {
  // ================= A. 鏡像與簽名回填（程序內、假橋接物件） =================
  { const dir = tmp(); seedDb(dir, 25);
    const before = q(dir, 'SELECT postId, staffId, name, unit, at, sigId FROM reads ORDER BY rowid');
    const B = fakeBridge();
    const r = await quiet(() => runMirror({ dir, bridge: B, batch: 10, maxPerRun: 20 }));
    eq('回填：每輪上限 20 張、每批 ≤10 張（2 次 sigs 呼叫）', [r.uploaded, B.sizes], [20, [10, 10]]);
    eq('回填：pending＝剩下還沒回填的（25－20）', r.pending, 5);
    eq('鏡像：先回填再鏡像，mirror 1 次、ok、fails 0', [B.calls, r.ok, r.fails], [['sigs', 'sigs', 'mirror'], true, 0]);
    const mr = B.mirrored.reads;
    eq('鏡像內容：四份都有、筆數與庫一致', [Object.keys(B.mirrored), B.mirrored.posts.length, B.mirrored.staff.length, mr.length, B.mirrored.log.length], [['posts', 'staff', 'reads', 'log'], 2, 30, 27, 1]);
    eq('鏡像保留 driveSigId：搬遷來的原 Drive id 不變', mr.find((x) => x.staffId === 'S-029').driveSigId, 'DRV-OLD');
    eq('鏡像保留 driveSigId：這一輪剛回填的 id 已帶上（前 20 張）', mr.filter((x) => x.postId === 'P-1').slice(0, 20).every((x) => x.driveSigId === 'DRV-' + x.sigId.replace(/\.png$/, '')), true);
    eq('鏡像：還沒回填的 driveSigId 送空白、沒簽名圖的也空白', [mr.filter((x) => x.postId === 'P-1' && !x.driveSigId).length, mr.find((x) => x.postId === 'P-2' && x.staffId === 'S-000').driveSigId], [5, '']);
    eq('鏡像：公告／同仁是原本的物件', [B.mirrored.posts[0].title, B.mirrored.staff[3].name], ['公告一', '同仁3']);
    eq('回填只寫 driveSigId 一欄（其他欄位與順序完全沒變）', q(dir, 'SELECT postId, staffId, name, unit, at, sigId FROM reads ORDER BY rowid'), before);
    eq('回填：庫裡 20 筆拿到 Drive id', q(dir, "SELECT COUNT(*) AS n FROM reads WHERE driveSigId LIKE 'DRV-P-1%'")[0].n, 20);
    eq('結果檔 mirror-last.json＝{ at, ok, uploaded, pending, … }', (({ at, ok, uploaded, pending }) => [typeof at, ok, uploaded, pending])(last(dir, 'mirror-last.json')), ['string', true, 20, 5]);
    const B2 = fakeBridge();
    const r2 = await quiet(() => runMirror({ dir, bridge: B2, batch: 10, maxPerRun: 20 }));
    eq('下一輪：補完剩下 5 張、pending 0', [r2.uploaded, r2.pending, B2.sizes], [5, 0, [5]]);
    const B3 = fakeBridge();
    const r3 = await quiet(() => runMirror({ dir, bridge: B3 }));
    eq('沒有待回填時不打 sigs，只鏡像', [B3.calls, r3.uploaded, r3.pending], [['mirror'], 0, 0]);
    // 批次上限夾在 20（Apps Script SIGS_MAX_）；--all 不設每輪上限
    const dir2 = tmp(); seedDb(dir2, 25);
    const B4 = fakeBridge();
    await quiet(() => runMirror({ dir: dir2, bridge: B4, batch: 99, all: true }));
    eq('批次大小最多 20；--all 一輪補完', B4.sizes, [20, 5]); }

  // 本機缺圖：跳過、不佔名額、算在 pending 與 missing
  { const dir = tmp(); seedDb(dir, 3);
    fs.unlinkSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE postId = 'P-1' ORDER BY rowid LIMIT 1")[0].sigId));
    const B = fakeBridge();
    const r = await quiet(() => runMirror({ dir, bridge: B, maxPerRun: 2 }));
    eq('缺圖：跳過不佔名額（仍上傳 2 張）、missing 1、pending 1', [r.uploaded, r.missing, r.pending, r.ok], [2, 1, 1, true]); }

  // 橋接失敗：ok:false，同一輪不重試；連續失敗計數
  { const dir = tmp(); seedDb(dir, 25);
    const B = fakeBridge({ sigs: true });
    const r = await quiet(() => runMirror({ dir, bridge: B, batch: 10, maxPerRun: 60 }));
    eq('sigs 失敗：只打 1 次 sigs（剩下的批次不再送）、鏡像照做 1 次、ok:false', [B.n('sigs'), B.n('mirror'), r.ok, r.uploaded, r.pending], [1, 1, false, 0, 25]);
    eq('失敗結果檔帶時間戳與 ok:false、fails 1', (({ at, ok, fails }) => [!!Date.parse(at), ok, fails])(last(dir, 'mirror-last.json')), [true, false, 1]);
    const B2 = fakeBridge({ mirror: true });
    const r2 = await quiet(() => runMirror({ dir, bridge: B2, batch: 10, maxPerRun: 10 }));
    eq('mirror 失敗：mirror 只打 1 次、回填照做、ok:false、fails 連續 2', [B2.n('mirror'), r2.uploaded, r2.ok, r2.fails], [1, 10, false, 2]);
    const B3 = fakeBridge(); B3.idsShort = true;
    const r3 = await quiet(() => runMirror({ dir, bridge: B3, batch: 10, maxPerRun: 10 }));
    eq('sigs 回傳 id 筆數不符：不回填、ok:false', [r3.uploaded, r3.pending, r3.ok, r3.fails], [0, 15, false, 3]);
    const r4 = await quiet(() => runMirror({ dir, bridge: fakeBridge(), maxPerRun: 100 }));
    eq('恢復後 fails 歸 0', [r4.ok, r4.fails, r4.pending], [true, 0, 0]); }

  // ================= B. 背景工作不經 makeSqliteStore：不寫 secret、不改表 =================
  { const dir = tmp(); seedDb(dir, 2);
    const s0 = q(dir, "SELECT v FROM kv WHERE k = 'secret'")[0].v;
    for (let i = 0; i < 10; i++) { await quiet(() => runDaily({ dir, bridge: fakeBridge() })); await quiet(() => runMirror({ dir, bridge: fakeBridge() })); }
    eq('daily／mirror 各跑 10 次，kv.secret 不變', q(dir, "SELECT v FROM kv WHERE k = 'secret'")[0].v, s0);
    { const db = new DatabaseSync(path.join(dir, 'bulletin.db')); db.exec("DELETE FROM kv WHERE k = 'secret'"); db.close(); }
    for (let i = 0; i < 3; i++) { await quiet(() => runDaily({ dir, bridge: fakeBridge() })); await quiet(() => runMirror({ dir, bridge: fakeBridge() })); }
    eq('庫裡缺 secret 時 daily／mirror 都不會寫入新的 secret', q(dir, "SELECT COUNT(*) AS n FROM kv WHERE k = 'secret'")[0].n, 0);
    const r = await runJob('daily.js', [], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('（子程序）缺 secret 時 daily.js 也不寫 secret', [r.code, q(dir, "SELECT COUNT(*) AS n FROM kv WHERE k = 'secret'")[0].n], [1, 0]); }
  { const dir = tmp();   // M1 舊庫（沒有 driveSigId 欄）：mirror 不自己改表，回 ok:false
    const db = new DatabaseSync(path.join(dir, 'bulletin.db'));
    db.exec("CREATE TABLE posts (id TEXT PRIMARY KEY, json TEXT); CREATE TABLE staff (id TEXT PRIMARY KEY, json TEXT); CREATE TABLE reads (postId TEXT, staffId TEXT, name TEXT, unit TEXT, at TEXT, sigId TEXT); CREATE TABLE log (seq INTEGER PRIMARY KEY, at TEXT, action TEXT, target TEXT, summary TEXT); CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);");
    db.close();
    const r = await quiet(() => runMirror({ dir, bridge: fakeBridge() }));
    eq('舊庫沒有 driveSigId：mirror ok:false、不自己 ALTER TABLE', [r.ok, q(dir, 'PRAGMA table_info(reads)').some((c) => c.name === 'driveSigId')], [false, false]);
    makeSqliteStore(dir).close();
    eq('伺服器（makeSqliteStore）啟動時補上 driveSigId 欄', q(dir, 'PRAGMA table_info(reads)').some((c) => c.name === 'driveSigId'), true); }
  { const dir = tmp();   // 沒有資料庫：背景工作不建空庫
    const r = await quiet(() => runMirror({ dir, bridge: fakeBridge() }));
    const d = await quiet(() => runDaily({ dir, bridge: fakeBridge() }));
    eq('沒有資料庫：mirror／daily 都 ok:false、不建 bulletin.db', [r.ok, d.ok, fs.existsSync(path.join(dir, 'bulletin.db'))], [false, false, false]); }

  // ================= C. 每日快照、保留天數、還原 =================
  { const dir = tmp(); seedDb(dir, 4);
    const bk = path.join(dir, 'backups'); fs.mkdirSync(bk);
    const old = (name, days) => { const p = path.join(bk, name); fs.writeFileSync(p, 'x'); const t = (Date.now() - days * 86400e3) / 1000; fs.utimesSync(p, t, t); return p; };
    const o20 = old('bulletin-2026-09-10_0330.db.gz', 20), o13 = old('bulletin-2026-09-17_0330.db.gz', 13), other = old('其他檔案.txt', 20);
    const B = fakeBridge();
    const r = await quiet(() => runDaily({ dir, bridge: B, now: new Date('2026-09-30T19:30:00Z') }));
    eq('快照：ok、檔名用台北時間、backup 1 次', [r.ok, r.file, B.n('backup')], [true, 'bulletin-2026-10-01_0330.db.gz', 1]);
    eq('保留策略：20 天前的假快照被清、13 天的留著、不是快照的檔案不動', [fs.existsSync(o20), fs.existsSync(o13), fs.existsSync(other), r.removed], [false, true, true, 1]);
    eq('backup-last.json＝{ at, ok, file, sizeKB, diskFreeMB }', (({ at, ok, file, sizeKB, diskFreeMB }) => [!!Date.parse(at), ok, file, sizeKB > 0, typeof diskFreeMB])(last(dir, 'backup-last.json')), [true, true, r.file, true, 'number']);
    eq('本機只留 .gz、沒有未壓縮暫存檔', fs.readdirSync(bk).filter((f) => /\.db$/.test(f)), []);
    eq('上傳內容＝本機 .gz 原檔（base64）', Buffer.from(B.backup.data, 'base64').equals(fs.readFileSync(path.join(bk, r.file))), true);
    const logLine = fs.readFileSync(path.join(dir, 'logs/daily.log'), 'utf8').split('\n').find((l) => l.includes('快照 ' + r.file));
    const logged = (/：(公告 \d+、同仁 \d+、已讀 \d+、紀錄 \d+)/.exec(logLine) || [])[1];
    eq('daily.log 記下快照筆數', logged, '公告 2、同仁 30、已讀 6、紀錄 1');

    // 還原演練：拿「雲端」那份（上傳的 base64）還原到乾淨的 DATA_DIR
    const cloud = path.join(tmp(), r.file); fs.writeFileSync(cloud, Buffer.from(B.backup.data, 'base64'));
    const clean = tmp('dzyb-restore-');
    const lines = [];
    const rr = await restore({ dir: clean, file: cloud, port: await freePort(), say: (s) => lines.push(s) });
    eq('還原後筆數＝daily.log 當日記的筆數', (/還原完成：(.*)$/.exec(lines.find((l) => l.startsWith('還原完成')) || '') || [])[1], logged);
    eq('還原：kv.secret 與原庫相同（同仁不用重新登入）', q(clean, "SELECT v FROM kv WHERE k = 'secret'")[0].v, q(dir, "SELECT v FROM kv WHERE k = 'secret'")[0].v);
    eq('乾淨目錄沒有 sigs/：已讀簽名圖都算「只在 Drive／兩邊都沒有」', [rr.sig.total, rr.sig.local], [5, 0]);
    fs.cpSync(path.join(dir, 'sigs'), path.join(clean, 'sigs'), { recursive: true });
    const S = await startServer(clean);
    eq('還原後起伺服器：/health 200、roster 正常', [(await request(S.port, 'GET', '/health')).status, (await api(S.port, 'roster')).json.ok], [200, true]);
    eq('還原的伺服器不能被第二次還原蓋掉（伺服器開著 → 拒絕）', await restore({ dir: clean, file: cloud, port: S.port, say: () => {} }).then(() => 'ok', (e) => /還開著/.test(e.message)), true);
    eq('拒絕時不留 .restoring 暫存檔', fs.existsSync(path.join(clean, 'bulletin.db.restoring')), false);
    await S.stop();
    const st = makeSqliteStore(clean);
    eq('還原後回條簽名圖看得到（本機 sigs/）', Object.values(st.getSigs('P-1')).filter((x) => x && x.startsWith('data:image/png')).length, 4);
    st.close();
    // 子程序：不帶任何秘密（沒有 BRIDGE_*、沒有 .env）也能還原；舊庫改名保留
    const r2 = await runJob('restore.js', [cloud], { DATA_DIR: clean, PORT: String(await freePort()) });
    eq('restore.js 不依賴秘密：exit 0、印出同樣筆數', [r2.code, (/還原完成：(.*)/.exec(r2.out) || [])[1]], [0, logged]);
    eq('舊庫改名保留、不刪', fs.readdirSync(clean).some((f) => /^bulletin\.db\.before-restore-/.test(f)), true);
    const bad = path.join(tmp(), 'bad.db.gz'); fs.writeFileSync(bad, zlib.gzipSync(Buffer.from('not sqlite')));
    const r3 = await runJob('restore.js', [bad], { DATA_DIR: clean, PORT: String(await freePort()) });
    eq('壞快照：拒絕還原、現有資料庫不動', [r3.code, q(clean, 'SELECT COUNT(*) AS n FROM staff')[0].n], [1, 30]);
    eq('沒給快照檔：用法說明、exit 2', (await runJob('restore.js', [], { DATA_DIR: clean })).code, 2); }
  { const dir = tmp(); seedDb(dir, 1);
    const r = await quiet(() => runDaily({ dir, bridge: fakeBridge({ backup: true }) }));
    eq('上傳失敗：ok:false、本機快照仍在、結果檔有時間戳', [r.ok, fs.existsSync(path.join(dir, 'backups', r.file)), !!Date.parse(last(dir, 'backup-last.json').at)], [false, true, true]); }

  // ================= /health 判定（純函式） =================
  { const now = Date.parse('2026-09-30T12:00:00Z'), ago = (h) => new Date(now - h * 3600e3).toISOString();
    const H = (m, b, free) => judgeHealth({ mirror: m, backup: b, disk: { freeMB: free === undefined ? 50000 : free } }, now);
    const okM = { at: ago(0.5), ok: true, sigPending: 0, fails: 0 }, okB = { at: ago(5), ok: true };
    eq('全部正常 → green', H(okM, okB), { level: 'green', why: [] });
    eq('mirror.at > 3h → yellow；> 6h → red', [H(Object.assign({}, okM, { at: ago(3.5) }), okB).level, H(Object.assign({}, okM, { at: ago(6.5) }), okB).level], ['yellow', 'red']);
    eq('backup.at > 26h → red（25h 還是 green）', [H(okM, { at: ago(26.5), ok: true }).level, H(okM, { at: ago(25), ok: true }).level], ['red', 'green']);
    eq('mirror 連續失敗 1 次不黃、2 次黃', [H(Object.assign({}, okM, { ok: false, fails: 1 }), okB).level, H(Object.assign({}, okM, { ok: false, fails: 2 }), okB).level], ['green', 'yellow']);
    eq('backup.ok=false → yellow；disk < 5000 → yellow；pending > 200 → yellow', [H(okM, { at: ago(1), ok: false }).why, H(okM, okB, 4999).why, H(Object.assign({}, okM, { sigPending: 201 }), okB).why],
      [['快照失敗'], ['磁碟剩餘不足 5GB'], ['待回填簽名超過 200 張']]);
    eq('從沒跑過 → red', H(null, null).level, 'red'); }

  // ================= launchd 範本：三個 job、佔位字串、不含金鑰 =================
  { const { execFileSync } = require('child_process');
    const L = path.join(ROOT, 'server/launchd');
    const pl = (f) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(L, f)], { encoding: 'utf8' }));
    const s = pl('com.dzy.bulletin.plist'), m = pl('com.dzy.bulletin.mirror.plist'), d = pl('com.dzy.bulletin.daily.plist');
    eq('launchd：三個 Label', [s.Label, m.Label, d.Label], ['com.dzy.bulletin', 'com.dzy.bulletin.mirror', 'com.dzy.bulletin.daily']);
    eq('launchd：伺服器 KeepAlive、mirror StartInterval 3600、daily 每天一次', [s.KeepAlive, s.RunAtLoad, m.StartInterval, d.StartCalendarInterval], [true, true, 3600, { Hour: 3, Minute: 30 }]);
    eq('launchd：指到對的腳本、路徑用佔位字串', [s, m, d].map((x) => [x.ProgramArguments[0], x.ProgramArguments[1].replace('__REPO__/server/', ''), x.EnvironmentVariables.DATA_DIR]),
      [['__NODE__', 'index.js', '__DATA_DIR__'], ['__NODE__', 'mirror.js', '__DATA_DIR__'], ['__NODE__', 'daily.js', '__DATA_DIR__']]);
    eq('launchd：範本不含金鑰（金鑰只在 server/.env）', fs.readdirSync(L).some((f) => /BRIDGE_KEY<\/key>|BRIDGE_URL<\/key>/.test(fs.readFileSync(path.join(L, f), 'utf8'))), false); }

  // ================= D. 端到端：假 Google（gas/*.js）＋ E2E 伺服器＋子程序 job =================
  { const FG = makeFakeGas();
    const URL0 = await FG.listen();
    const KEY = 'k'.repeat(40);                              // 測試用假金鑰（非正式）
    Object.assign(FG.props, { BRIDGE_KEY: KEY, PRIMARY: 'mini', TOKEN_SECRET: 'test-secret' });
    const dir = tmp('dzyb-e2e-');
    const S = await startServer(dir, { E2E: '1' });
    const JOB = { DATA_DIR: dir, BRIDGE_URL: URL0, BRIDGE_KEY: KEY };
    const BAD = { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:' + (await freePort()) + '/exec', BRIDGE_KEY: KEY };
    await request(S.port, 'POST', '/__seed', { demo: true });
    const tok = (await api(S.port, 'setPin', { staffId: 'S-013', pin: '2580' })).json.data.token;
    const board = (await api(S.port, 'board', { token: tok })).json.data;
    const todo = board.posts.map((p) => p.id).filter((id) => !board.myReads[id]);
    const acks = []; for (const id of todo) { if (acks.length >= 3) break; if ((await api(S.port, "ack", { token: tok, postId: id, sig: PNG(id) })).json.ok) acks.push(id); }
    // 之後再簽的用其他同仁（S-013 能簽的公告已簽完）：回傳第一筆簽成功的回應
    const signAs = async (tag) => {
      let last = null;
      for (let i = 1; i <= 12; i++) {
        const t = (await api(S.port, 'login', { staffId: 'S-' + String(i).padStart(3, '0'), pin: '0000' })).json.data.token;
        const b = (await api(S.port, 'board', { token: t })).json.data;
        for (const id of b.posts.map((p) => p.id).filter((id) => !b.myReads[id])) { last = await api(S.port, 'ack', { token: t, postId: id, sig: PNG(tag + id) }); if (last.json.ok) return last; }
      }
      return last;
    };
    eq('（前提）簽 3 筆', q(dir, "SELECT COUNT(*) AS n FROM reads WHERE sigId <> ''")[0].n, 3);

    let r = await runJob('mirror.js', [], JOB);
    const ml = last(dir, 'mirror-last.json');
    eq('簽 3 筆 → 下一輪 3 筆都有 driveSigId、pending 0', [r.code, ml.ok, ml.uploaded, ml.pending, q(dir, "SELECT COUNT(*) AS n FROM reads WHERE sigId <> '' AND driveSigId <> ''")[0].n], [0, true, 3, 0, 3]);
    const sigFolder = FG.props.SIG_FOLDER_ID;
    eq('Drive 簽名資料夾多 3 個檔、1 次 sigs 呼叫', [Object.values(FG.drive.files).filter((f) => f.parent === sigFolder).length, FG.st.hits.sigs], [3, 1]);
    const rows = FG.sheetRows('已讀'), db = q(dir, 'SELECT postId, staffId, name, unit, at, sigId, driveSigId FROM reads ORDER BY rowid');
    eq('鏡像後「已讀」筆數與 Mac mini 一致', rows.length, db.length);
    const signedRows = db.filter((x) => x.sigId);
    eq('抽 3 筆簽名：試算表的簽名檔 id＝Drive id（不是 Mac mini 檔名）', signedRows.map((x) => { const row = rows.find((y) => y[0] === x.postId && y[1] === x.staffId); return [row[4] === x.at, row[5] === x.driveSigId, !!FG.drive.files[row[5]]]; }), [[true, true, true], [true, true, true], [true, true, true]]);
    eq('Drive 上的簽名圖內容＝本機簽名圖', signedRows.every((x) => Buffer.from(FG.drive.files[x.driveSigId].bytes.map((b) => b & 255)).equals(fs.readFileSync(path.join(dir, 'sigs', x.sigId)))), true);
    eq('鏡像後公告／同仁筆數一致', [FG.sheetRows('公告').length, FG.sheetRows('同仁').length], [q(dir, 'SELECT COUNT(*) AS n FROM posts')[0].n, q(dir, 'SELECT COUNT(*) AS n FROM staff')[0].n]);
    r = await runJob('daily.js', [], JOB);
    const bl = last(dir, 'backup-last.json');
    const bkFolder = FG.props.BACKUP_FOLDER_ID;
    eq('daily.js：ok、備份檔落在獨立備份資料夾、分享「限制」', [r.code, bl.ok, !!FG.drive.files[bl.driveId], FG.drive.files[bl.driveId].parent === bkFolder, FG.drive.files[bl.driveId].sharing], [0, true, true, true, 'PRIVATE']);
    let h = (await request(S.port, 'GET', '/health')).json;
    eq('/health 讀兩個檔：mirror／backup 的 at 與結果檔一致', [h.mirror.at, h.mirror.ok, h.mirror.sigPending, h.mirror.fails, h.backup.at, h.backup.ok], [ml.at, true, 0, 0, bl.at, true]);
    eq('/health 兩個 job 剛跑完：沒有紅燈、沒有鏡像／快照相關的黃燈', [h.level !== 'red', h.why.filter((w) => /鏡像|快照|回填/.test(w))], [true, []]);

    // 驗收 1：BRIDGE_URL 改錯 → *-last.json ok:false 帶時間戳；/health 仍 200、同仁照樣能簽名
    r = await runJob('mirror.js', [], BAD);
    const r2 = await runJob('mirror.js', [], BAD);
    const rd = await runJob('daily.js', [], BAD);
    const mf = last(dir, 'mirror-last.json'), bf = last(dir, 'backup-last.json');
    eq('BRIDGE_URL 錯：mirror.js／daily.js exit 1、ok:false 帶時間戳', [r.code, r2.code, rd.code, mf.ok, !!Date.parse(mf.at), bf.ok, !!Date.parse(bf.at)], [1, 1, 1, false, true, false, true]);
    const hr = await request(S.port, 'GET', '/health');
    eq('BRIDGE_URL 錯：/health 仍 200、mirror 連續失敗 2 次＋快照失敗 → 黃燈', [hr.status, hr.json.mirror.fails, hr.json.why.includes('鏡像連續失敗'), hr.json.why.includes('快照失敗'), hr.json.level === 'red' ? 'red' : 'not-red'], [200, 2, true, true, 'not-red']);
    const ack = await signAs('after');
    eq('BRIDGE_URL 錯：同仁照樣能簽名', ack.json.ok, true);
    eq('/health 不帶錯誤原文', /127\.0\.0\.1|BRIDGE|fetch/.test(JSON.stringify(hr.json)), false);

    // 同一輪不重試：sigs 那次 Google 回 500 → 只打 1 次 sigs，下一輪才補
    FG.st.hits = {}; FG.st.failNext = 'sigs';
    r = await runJob('mirror.js', [], JOB);
    eq('sigs 失敗：同一輪只打 1 次 sigs、鏡像照做、pending 1', [r.code, FG.st.hits.sigs, FG.st.hits.mirror, last(dir, 'mirror-last.json').pending], [1, 1, 1, 1]);
    r = await runJob('mirror.js', [], JOB);
    eq('下一輪補上：pending 0、fails 歸 0', [r.code, last(dir, 'mirror-last.json').pending, last(dir, 'mirror-last.json').fails], [0, 0, 0]);

    // 鏡像寫到一半丟錯（M2 暫存分頁）：正式四分頁仍是上一輪；PRIMARY=gas 時 mirror 被拒、試算表不動
    const snap = () => JSON.stringify(['公告', '同仁', '已讀', '操作紀錄'].map((n) => FG.book.getSheetByName(n).data));
    const good = snap();
    eq('（前提）再簽 1 筆', (await signAs('x')).json.ok, true);
    FG.st.throwOnWrite = '操作紀錄__鏡像中';
    r = await runJob('mirror.js', [], JOB);
    eq('mirror 寫到一半丟錯：ok:false、正式四分頁仍是上一輪', [r.code, last(dir, 'mirror-last.json').ok, snap() === good], [1, false, true]);
    FG.st.throwOnWrite = null; FG.props.PRIMARY = 'gas';
    r = await runJob('mirror.js', [], JOB);
    eq('PRIMARY=gas：mirror 被拒（ok:false）、試算表不動', [r.code, snap() === good], [1, true]);
    FG.props.PRIMARY = 'mini';
    r = await runJob('mirror.js', [], JOB);
    eq('恢復後鏡像成功、新簽名進試算表', [r.code, FG.sheetRows('已讀').length], [0, q(dir, 'SELECT COUNT(*) AS n FROM reads')[0].n]);
    await S.stop(); await FG.close(); }
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { if (p.exitCode === null) p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`jobs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
