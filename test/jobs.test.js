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
  // nullIf(name)＝這張回 null（M2 saveSigs 逐張失敗）；onSigs(put)＝sigs 呼叫進行中（Apps Script 處理那幾分鐘）要做的事；names＝每張被送出的名稱
  const b = { calls: [], sizes: [], names: [], mirrored: null, backup: null, fail: fail || {}, idsShort: false, nullIf: null, onSigs: null, onMirror: null };
  b.call = async (op, p) => {
    b.calls.push(op);
    if (b.fail[op]) { const e = new Error('Google 雲端暫時連不上，請稍後再試'); e.code = 'BRIDGE'; e.detail = op + ': 假錯誤'; throw e; }
    if (op === 'sigs') {
      b.sizes.push(p.put.length); p.put.forEach((x) => b.names.push(x.name));
      if (b.onSigs) b.onSigs(p.put);
      const ids = p.put.map((x) => (b.nullIf && b.nullIf(x.name) ? null : 'DRV-' + x.name));
      return { ids: b.idsShort ? ids.slice(1) : ids };
    }
    if (op === 'mirror') { if (b.onMirror) b.onMirror(); b.mirrored = JSON.parse(JSON.stringify(p.data)); return { counts: {} }; }
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
    eq('缺圖：跳過不佔名額（仍上傳 2 張）、missing 1、pending 不算缺圖（0）、列出是哪一筆', [r.uploaded, r.missing, r.pending, r.ok, r.missingIds], [2, 1, 0, true, ['P-1/S-000']]); }

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

  // ---- #14 B1：saveSigs 逐張 null → 成功的照回填、null 的只重傳它、連續 3 次成壞圖後不再挑（不會每輪卡同一批） ----
  { const dir = tmp(); seedDb(dir, 25);
    const B = fakeBridge(); B.nullIf = (n) => n === 'P-1_S-000';     // 排在最前面的那張永遠失敗
    let T = Date.now(); const clk = () => T, hour = () => { T += 3600e3; };   // 每小時一輪（失敗計數要隔 30 分鐘）
    const r1 = await runMirror({ dir, bridge: B, batch: 10, maxPerRun: 10, nowMs: clk });
    eq('B1：一批 10 張裡 1 張 null → 其餘 9 張照回填、ok 仍是 true、failed 1', [r1.uploaded, r1.failed, r1.ok, r1.pending, r1.bad], [9, 1, true, 16, 0]);
    eq('B1：null 那張在庫裡仍空白', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-000' AND postId = 'P-1'")[0].driveSigId, '');
    hour(); const r2 = await runMirror({ dir, bridge: B, batch: 10, maxPerRun: 10, nowMs: clk });
    hour(); const r3 = await runMirror({ dir, bridge: B, batch: 10, maxPerRun: 10, nowMs: clk });
    eq('B1：後面的簽名照樣前進（不卡在同一批）；第 3 次失敗後成壞圖、pending 0', [r2.uploaded, r3.uploaded, r3.pending, r3.bad, r3.badIds], [9, 6, 0, 1, ['P-1/S-000']]);
    eq('B1：成功的每張只送一次（沒有重傳＝沒有孤兒檔），失敗的那張送了 3 次', [B.names.filter((n) => n === 'P-1_S-000').length, new Set(B.names).size, B.names.length], [3, 25, 27]);
    hour(); const r4 = await runMirror({ dir, bridge: B, batch: 10, maxPerRun: 10, nowMs: clk });
    eq('B1：壞圖之後不再挑（沒有 sigs 呼叫）、仍計入 bad、結果檔帶 bad', [B.n('sigs'), r4.bad, last(dir, 'mirror-last.json').bad], [3, 1, 1]);
    eq('B1：壞圖 → /health 規則亮黃', judgeHealth({ mirror: { at: r4.at, ok: true, sigPending: 0, bad: r4.bad, fails: 0 }, backup: { at: r4.at, ok: true }, disk: { freeMB: 99999 } }).why, ['有壞簽名圖']);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8'));
    delete st.fails[Object.keys(st.fails)[0]]; fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), JSON.stringify(st));
    B.nullIf = null;
    const r5 = await runMirror({ dir, bridge: B });
    eq('B1：從 sig-state.json 刪掉計數 → 下一輪重試成功', [r5.uploaded, r5.bad, r5.pending], [1, 0, 0]); }
  // 真的 gas saveSigs（fake-gas 注入「第 k 張失敗」與 0 位元組圖）：逐張契約端到端
  { const dir = tmp(); seedDb(dir, 5);
    fs.writeFileSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE staffId = 'S-002' AND postId = 'P-1'")[0].sigId), '');   // 0 位元組（磁碟滿時寫壞）
    const FG = makeFakeGas(); const files = require('vm').runInContext('makeFiles_()', FG.G);
    const bridge = { call: async (op, p) => (op === 'sigs' ? { ids: files.saveSigs(p.put) } : {}) };
    FG.st.failCreate = (name, k) => k === 0;                   // 第 1 輪：這批第 0 張 Drive 寫入失敗
    let T = Date.now(); const clk = () => T;
    const r1 = await runMirror({ dir, bridge, batch: 10, nowMs: clk });
    FG.st.failCreate = null;
    eq('真 saveSigs：第 0 張 Drive 失敗＋0 位元組 → 其餘 3 張照回填', [r1.ok, r1.uploaded, r1.failed, r1.pending], [true, 3, 2, 2]);
    T += 3600e3; const r2 = await runMirror({ dir, bridge, nowMs: clk });
    T += 3600e3; const r3 = await runMirror({ dir, bridge, all: true, nowMs: clk });
    const sigFiles = Object.values(FG.drive.files).filter((f) => f.parent === FG.props.SIG_FOLDER_ID).length;
    eq('真 saveSigs：第 2 輪補上 Drive 失敗那張（與 0 位元組同批→後者計數）', [r2.ok, r2.uploaded, r2.failed], [true, 1, 1]);
    eq('真 saveSigs：只剩 0 位元組單獨成批＝整批 null → 不計數、ok:false 附原因、仍 pending（已知限制，由人處理）',
      [r3.ok, r3.pending, r3.bad, /全部失敗/.test(r3.error), JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')).fails['P-1\tS-002\tP-1_S-002.png'].n], [false, 1, 0, true, 2]);
    eq('真 saveSigs：Drive 簽名資料夾只有 4 個檔（沒有重複的孤兒檔）', [sigFiles, q(dir, "SELECT COUNT(*) AS n FROM reads WHERE driveSigId LIKE 'G%'")[0].n], [4, 4]); }
  // UPDATE 的保護：上傳這幾分鐘裡別人已填 driveSigId（搬遷）→ 不覆蓋；sigId 被重建成別張圖 → 不套用舊圖的 id
  { const dir = tmp(); seedDb(dir, 3);
    const B = fakeBridge();
    B.onSigs = () => { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec("PRAGMA busy_timeout = 5000; UPDATE reads SET driveSigId = 'MIGRATED' WHERE staffId = 'S-000' AND postId = 'P-1'; UPDATE reads SET sigId = 'REBUILT.png' WHERE staffId = 'S-001' AND postId = 'P-1'"); w.close(); };
    await runMirror({ dir, bridge: B });
    eq('已有 driveSigId 的不覆蓋（AND driveSigId = \'\'）', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-000' AND postId = 'P-1'")[0].driveSigId, 'MIGRATED');
    eq('sigId 變了的不套用舊圖的 id（AND sigId = ?）', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-001' AND postId = 'P-1'")[0].driveSigId, '');
    eq('其他照常回填', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-002' AND postId = 'P-1'")[0].driveSigId, 'DRV-P-1_S-002'); }
  // #14 S1：四份資料是同一個快照；呼叫 mirror 時讀交易已結束（不擋 checkpoint）
  { const dir = tmp(); seedDb(dir, 2);
    const B = fakeBridge(); let ck = null;
    B.onMirror = () => { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); ck = Object.assign({}, w.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()); w.close(); };
    await runMirror({ dir, bridge: B, _betweenReads: () => {
      const w = new DatabaseSync(path.join(dir, 'bulletin.db'));
      w.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; INSERT INTO posts VALUES ('P-NEW', '{\"id\":\"P-NEW\"}'); INSERT INTO reads (postId, staffId, name, unit, at, sigId) VALUES ('P-NEW', 'S-005', 'n', 'mala', 'x', ''); COMMIT"); w.close(); } });
    const m = B.mirrored;
    eq('S1：讀的中途伺服器提交的新公告與已讀都不在這一份（同一個快照、沒有孤兒已讀）', [m.posts.map((p) => p.id), m.reads.filter((r) => !m.posts.some((p) => p.id === r.postId)).length], [['P-1', 'P-2'], 0]);
    eq('S1：呼叫 mirror 時沒有開著的讀交易（checkpoint TRUNCATE 不 busy）', ck && ck.busy, 0);
    const B2 = fakeBridge();
    await runMirror({ dir, bridge: B2 });
    eq('S1：下一輪就帶上新公告', B2.mirrored.posts.map((p) => p.id), ['P-1', 'P-2', 'P-NEW']); }
  // #14 S2：--all 的完成條件是 pending=0；缺圖與壞圖另外計、列出清單、不卡住
  { const dir = tmp(); seedDb(dir, 6);
    fs.unlinkSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE staffId = 'S-001' AND postId = 'P-1'")[0].sigId));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), JSON.stringify({ fails: { 'P-1\tS-004\tP-1_S-004.png': { n: 3, at: 0 } }, unsaved: {} }));   // 已是壞圖
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('S2：--all 一次跑到 pending 0（缺圖 1、壞圖 1 另計），ok', [r.ok, r.pending, r.missing, r.bad, r.uploaded, r.missingIds, r.badIds], [true, 0, 1, 1, 4, ['P-1/S-001'], ['P-1/S-004']]);
    const log = fs.readFileSync(path.join(dir, 'logs/mirror.log'), 'utf8');
    eq('S2：mirror.log 印出缺圖與壞圖警告並列出是哪幾筆', [/⚠ 本機缺簽名圖 1 筆.*P-1\/S-001/.test(log), /⚠ 壞簽名圖 1 筆.*P-1\/S-004/.test(log)], [true, true]);
    const c = await runJob('mirror.js', ['--all'], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('S2：mirror.js --all 在終端印出 pending／missing／bad 與清單', [/pending=0｜本機缺圖 missing=1｜壞圖 bad=1/.test(c.out), /⚠ 本機缺圖：P-1\/S-001/.test(c.out)], [true, true]); }

  // ---- #14 B2：Drive 暫時故障（整批 null）不能算壞圖 ----
  { const dir = tmp(); seedDb(dir, 30);
    const B = fakeBridge(); B.nullIf = () => true;           // Drive 配額用完／5xx：每一張都回 null
    let T = Date.now(); const clk = () => T;
    const ra = await runMirror({ dir, bridge: B, all: true, nowMs: clk });
    eq('B2：30 張整批 null，--all → bad 0、ok:false 附原因、只打 1 次 sigs 就停', [ra.bad, ra.ok, /全部失敗/.test(ra.error), B.n('sigs'), ra.pending], [0, false, true, 1, 30]);
    const hourly = [];
    for (let i = 0; i < 5; i++) { T += 3600e3; const r = await runMirror({ dir, bridge: B, nowMs: clk }); hourly.push(r.bad); }
    eq('B2：接著 5 個每小時輪都整批 null → bad 始終 0', hourly, [0, 0, 0, 0, 0]);
    eq('B2：整批 null 不留任何失敗計數', Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')).fails).length, 0);
    B.nullIf = null; T += 3600e3;
    const rb = await runMirror({ dir, bridge: B, all: true, nowMs: clk });
    eq('B2：Drive 恢復後 --all 全部上傳、pending 0', [rb.ok, rb.uploaded, rb.pending, rb.bad], [true, 30, 0, 0]); }
  { const dir = tmp(); seedDb(dir, 3);                       // 同一批有成功有失敗才計數；--all 重掃同一張、30 分鐘內再跑都不重複計
    const B = fakeBridge(); B.nullIf = (n) => n === 'P-1_S-000';
    let T = Date.now(); const clk = () => T;
    const n = () => JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')).fails['P-1\tS-000\tP-1_S-000.png'].n;
    await runMirror({ dir, bridge: B, all: true, nowMs: clk });
    eq('B2：--all 重掃同一張（送了 2 次）只計 1 次', [B.names.filter((x) => x === 'P-1_S-000').length, n()], [2, 1]);
    B.nullIf = (x) => x === 'P-1_S-000' || x === 'P-2_S-000x';
    const st = makeSqliteStore(dir); st.addRead({ postId: 'P-2', staffId: 'S-001', name: 'n', unit: 'mala', at: 'x', sig: PNG('new') }); st.close();   // 讓下一批仍是混合批
    T += 10 * 60e3; await runMirror({ dir, bridge: B, nowMs: clk });
    const n10 = n();
    const st2 = makeSqliteStore(dir); st2.addRead({ postId: 'P-2', staffId: 'S-002', name: 'n', unit: 'mala', at: 'x', sig: PNG('new2') }); st2.close();
    T += 25 * 60e3; await runMirror({ dir, bridge: B, nowMs: clk });
    eq('B2：距上次計數不到 30 分鐘不加、超過才加', [n10, n()], [1, 2]); }

  // ---- #14 S5：還原後不讓鏡像用舊資料蓋掉試算表 ----
  { const dir = tmp(); seedDb(dir, 5);
    const B = fakeBridge();
    const r0 = await runMirror({ dir, bridge: B });
    eq('S5：成功鏡像記下送出的筆數（lastSent）', [r0.ok, last(dir, 'mirror-last.json').lastSent.reads], [true, 7]);
    { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec("DELETE FROM reads WHERE staffId IN ('S-003', 'S-004') AND postId = 'P-1'"); w.close(); }   // 模擬從較舊的快照還原
    const B2 = fakeBridge();
    const r1 = await runMirror({ dir, bridge: B2 });
    eq('S5：本機 reads 比上次鏡像少 → 不送、ok:false、原因寫明', [r1.ok, B2.n('mirror'), /本機筆數比上次鏡像少（可能剛還原）/.test(r1.error), /reads 5＜7/.test(r1.error)], [false, 0, true, true]);
    const r2 = await runMirror({ dir, bridge: B2 });
    eq('S5：失敗那輪不改 lastSent，下一輪照樣擋', [r2.ok, B2.n('mirror'), last(dir, 'mirror-last.json').lastSent.reads], [false, 0, 7]);
    let sent = null; const B3 = fakeBridge(); const call0 = B3.call; B3.call = (op, p) => { if (op === 'mirror') sent = p; return call0(op, p); };
    const r3 = await runMirror({ dir, bridge: B3, force: true });
    eq('S5：--force → 送出、帶 force:true 給 Apps Script、lastSent 更新', [r3.ok, sent && sent.force, r3.forced, last(dir, 'mirror-last.json').lastSent.reads], [true, true, true, 5]);
    const B4 = fakeBridge(); let sent4 = null; const c4 = B4.call; B4.call = (op, p) => { if (op === 'mirror') sent4 = p; return c4(op, p); };
    const r4 = await runMirror({ dir, bridge: B4 });
    eq('S5：之後一般輪照常、不帶 force', [r4.ok, sent4 && 'force' in sent4], [true, false]);
    const c = await runJob('mirror.js', ['--force'], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('S5：mirror.js 接受 --force 參數（橋接連不上 → exit 1、印結論）', [c.code, /鏡像失敗｜/.test(c.out)], [1, true]); }

  // ---- #14 S7：已上傳未寫庫的 carry；鎖檔 6 小時上限 ----
  { const dir = tmp(); seedDb(dir, 4);
    const B = fakeBridge(); let w = null;
    B.onSigs = () => { w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('BEGIN IMMEDIATE'); };   // 上傳期間伺服器拿著寫鎖 → 回填寫不進去
    const r1 = await runMirror({ dir, bridge: B, busyMs: 50 });
    w.exec('ROLLBACK'); w.close(); B.onSigs = null;
    const un = JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')).unsaved;
    eq('S7：寫庫失敗 → ok:false、已上傳的 id 記在 unsaved', [r1.ok, /回填寫入/.test(r1.error), Object.keys(un).length, r1.uploaded], [false, true, 4, 0]);
    const r2 = await runMirror({ dir, bridge: B });
    eq('S7：下一輪直接寫入上一輪的 id、不重傳（sigs 總共 1 次）、pending 0', [r2.ok, r2.carried, r2.uploaded, B.n('sigs'), r2.pending, q(dir, "SELECT COUNT(*) AS n FROM reads WHERE driveSigId LIKE 'DRV-P-1%'")[0].n], [true, 4, 0, 1, 0, 4]); }
  { const dir = tmp(); seedDb(dir, 1);
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e5)'], { stdio: 'ignore' }); procs.push(sleeper);
    const lf = path.join(dir, 'logs/mirror.lock'); fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, String(sleeper.pid));
    eq('S7：鎖由活著的程序持有、未過期 → 跳過', (await runMirror({ dir, bridge: fakeBridge() })).skipped, true);
    const c = await runJob('mirror.js', ['--all'], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('建議 1：--all 撞到鎖 → exit 1、印「已跳過」', [c.code, /另一輪鏡像正在跑.*已跳過/.test(c.out)], [1, true]);
    const old = (Date.now() - 7 * 3600e3) / 1000; fs.utimesSync(lf, old, old);   // PID 被重用的情形：程序活著，但鎖檔已 7 小時沒更新
    const r = await runMirror({ dir, bridge: fakeBridge() });
    eq('S7：鎖檔超過 6 小時 → 視為殘留、照常跑', [r.skipped, r.ok], [undefined, true]);
    sleeper.kill(); }
  // ---- 建議 2／3：sig-state.json 損毀改名保留並 ok:false；存狀態失敗只記警告、鏡像照做 ----
  { const dir = tmp(); seedDb(dir, 1);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), '{"fails":{');
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B });
    eq('建議 2：sig-state.json 損毀 → 改名 .corrupt-* 保留、ok:false 說明、這一輪不上傳（免得重傳成孤兒）、鏡像照做', [r.ok, /損毀/.test(r.error), fs.readdirSync(path.join(dir, 'logs')).some((f) => /^sig-state\.json\.corrupt-/.test(f)), B.n('mirror')], [false, true, true, 1]);
    fs.mkdirSync(path.join(dir, 'logs/sig-state.json.tmp'));   // 暫存檔路徑被佔（模擬寫不進去）
    const st = makeSqliteStore(dir); st.addRead({ postId: 'P-2', staffId: 'S-005', name: 'n', unit: 'mala', at: 'x', sig: PNG('w') }); st.close();
    const B2 = fakeBridge();
    const r2 = await runMirror({ dir, bridge: B2 });
    eq('建議 3：存狀態失敗 → 只記 warning、回填與鏡像照做、ok', [r2.ok, !!(r2.warnings && /sig-state/.test(r2.warnings[0])), r2.uploaded, B2.n('mirror')], [true, true, 2, 1]); }

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
  // #14 S3：換檔前 lsof／工作鎖／改名前殘留檢查；拿不到條件就拒絕並說明原因
  { const src = tmp(); seedDb(src, 2);
    const d0 = await quiet(() => runDaily({ dir: src, bridge: fakeBridge() }));
    const snapFile = path.join(src, 'backups', d0.file);
    const target = tmp(); seedDb(target, 5);
    const staffN = () => q(target, 'SELECT COUNT(*) AS n FROM reads')[0].n;
    const n0 = staffN();
    const tryRestore = (extra) => freePort().then((port) => restore(Object.assign({ dir: target, file: snapFile, port, say: () => {} }, extra)).then(() => 'ok', (e) => e.message));
    // (a) 另一個程序開著資料庫（例如伺服器卡住、或跑在別的 PORT、或 mirror／daily 拿著連線）
    const holder = spawn(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('SELECT 1');console.log('ready');setInterval(()=>{},1e5)", path.join(target, 'bulletin.db')], { stdio: ['ignore', 'pipe', 'ignore'] });
    procs.push(holder);
    await new Promise((ok) => holder.stdout.once('data', ok));
    const ra = await tryRestore();
    eq('S3：別的程序開著資料庫 → lsof 查到、拒絕並列出 PID、資料庫不動', [/還有程序開著資料庫（PID /.test(ra) && ra.includes(String(holder.pid)), staffN(), fs.existsSync(path.join(target, 'bulletin.db.restoring'))], [true, n0, false]);
    // (b) 伺服器卡住不回 /health（只收連線不回應）＋同一個程序還拿著連線（審查重現）
    const hung = net.createServer(() => {}); await new Promise((ok) => hung.listen(0, '127.0.0.1', ok));
    holder.kill(); await new Promise((ok) => holder.on('exit', ok));
    const live = new DatabaseSync(path.join(target, 'bulletin.db')); live.exec('SELECT 1');
    const rb = await restore({ dir: target, file: snapFile, port: hung.address().port, say: () => {} }).then(() => 'ok', (e) => e.message);
    live.close(); hung.close();
    eq('S3：/health 沒回應但有連線開著 → 仍拒絕', [/還有程序開著資料庫/.test(rb), staffN()], [true, n0]);
    // (c) mirror 工作正在跑（鎖由活著的程序持有）
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e5)'], { stdio: 'ignore' }); procs.push(sleeper);
    fs.mkdirSync(path.join(target, 'logs'), { recursive: true }); fs.writeFileSync(path.join(target, 'logs/mirror.lock'), String(sleeper.pid));
    const rc = await tryRestore();
    eq('S3：mirror 正在跑（mirror.lock）→ 拒絕', [/mirror 工作正在跑/.test(rc), staffN()], [true, n0]);
    eq('鎖由活著的程序持有時 mirror／daily 自己跳過（不寫結果檔、不開庫）', [(await runMirror({ dir: target, bridge: fakeBridge() })).skipped], [true]);
    sleeper.kill(); await new Promise((ok) => sleeper.on('exit', ok));
    // 建議 5：lsof 被 signal 殺掉或異常結束 → 一律「無法確認」、拒絕
    const fakeBin = tmp('dzyb-bin-');
    fs.writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    const rk = await runJob('restore.js', [snapFile], { DATA_DIR: target, PORT: String(await freePort()), PATH: fakeBin + ':' + process.env.PATH });
    fs.writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const r2x = await runJob('restore.js', [snapFile], { DATA_DIR: target, PORT: String(await freePort()), PATH: fakeBin + ':' + process.env.PATH });
    eq('建議 5：lsof 被 signal 殺掉／exit 2 → 拒絕（無法確認）、資料庫不動', [rk.code, /lsof 無法執行或異常結束/.test(rk.err), r2x.code, /lsof 無法執行或異常結束/.test(r2x.err), staffN()], [1, true, 1, true, n0]);
    // S5：同一個 DATA_DIR 還原前鏡像過（lastSent 較大）→ 還原後 mirror 自己擋；restore 印出「mirror 沒有載回」
    await runMirror({ dir: target, bridge: fakeBridge() });
    // (d) 舊庫改名後、新庫就位前被重新建了 -wal（例如 KeepAlive 把伺服器拉起來）→ 改名前檢查到、拒絕，舊庫保留
    const rd = await tryRestore({ _afterMove: () => fs.writeFileSync(path.join(target, 'bulletin.db-wal'), 'x') });
    eq('S3：換檔途中出現 -wal → 拒絕、說明舊庫保留在哪、新庫沒有被放上去', [/換檔途中有程序重新開了資料庫（bulletin\.db-wal）/.test(rd), fs.existsSync(path.join(target, 'bulletin.db')), fs.readdirSync(target).some((f) => /^bulletin\.db\.before-restore-.*\d$/.test(f))], [true, false, true]);
    eq('拒絕後鎖都有放掉', [fs.existsSync(path.join(target, 'logs/mirror.lock')), fs.existsSync(path.join(target, 'logs/daily.lock'))], [false, false]);
    fs.unlinkSync(path.join(target, 'bulletin.db-wal'));
    const lines = [];
    const ro = await freePort().then((port) => restore({ dir: target, file: snapFile, port, say: (s) => lines.push(s) }).then(() => 'ok', (e) => e.message));
    eq('條件都滿足時照常還原', [ro, q(target, 'SELECT COUNT(*) AS n FROM reads')[0].n], ['ok', 4]);
    eq('S5：restore 不載回 mirror、印出確認後手動 --force 的提示', [lines.some((l) => /mirror 沒有載回/.test(l) && /mirror\.js --force/.test(l)), lines.some((l) => /bootstrap[^；]*com\.dzy\.bulletin\.mirror\.plist；/.test(l))], [true, false]);
    const rm = await runMirror({ dir: target, bridge: fakeBridge() });
    eq('S5：還原後第一輪鏡像被擋（本機筆數比上次鏡像少）', [rm.ok, /可能剛還原/.test(rm.error)], [false, true]); }
  { const dir = tmp(); seedDb(dir, 1);
    const bk = path.join(dir, 'backups'); fs.mkdirSync(bk);
    fs.writeFileSync(path.join(bk, 'bulletin-2026-09-29_0330.db.gz.tmp'), 'half');
    const r0 = await runDaily({ dir, bridge: fakeBridge() });
    eq('.gz 先寫暫存再改名：備份資料夾沒有 .tmp 以外的半成品、本輪沒留 .tmp', [r0.ok, fs.readdirSync(bk).filter((f) => f.endsWith('.tmp') && f.includes(r0.file)).length], [true, 0]);
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
    eq('從沒跑過 → red', H(null, null).level, 'red');
    eq('備份資料夾有共用者 → yellow；0／-1（讀不到）／沒回報不判', [H(okM, Object.assign({}, okB, { sharedWith: 1 })).why, H(okM, Object.assign({}, okB, { sharedWith: 0 })).level, H(okM, Object.assign({}, okB, { sharedWith: -1 })).level, H(okM, Object.assign({}, okB, { sharedWith: null })).level],
      [['備份資料夾有共用者'], 'green', 'yellow', 'green']);
    eq('sharedWith=-1 → 黃「備份資料夾權限讀不到」', H(okM, Object.assign({}, okB, { sharedWith: -1 })).why, ['備份資料夾權限讀不到']);
    eq('時間戳比現在晚 5 分鐘以上 → 黃（4 分鐘不判）', [H(Object.assign({}, okM, { at: ago(-24 * 30) }), okB).why, H(okM, Object.assign({}, okB, { at: ago(-0.1) })).level, H(okM, Object.assign({}, okB, { at: ago(-4 / 60) })).level],
      [['時間戳異常（比現在還晚）'], 'yellow', 'green']);
    eq('mirror.bad／missing > 0 → 黃', [H(Object.assign({}, okM, { bad: 1 }), okB).why, H(Object.assign({}, okM, { missing: 2 }), okB).why], [['有壞簽名圖'], ['本機缺簽名圖']]);
    eq('結果檔讀不到（at 為 null）→ 紅、寫「結果檔讀不到」', H({ at: null, ok: false }, { at: null, ok: false }).why.slice(0, 2), ['鏡像結果檔讀不到', '快照結果檔讀不到']); }

  // ================= launchd 範本：三個 job、佔位字串、不含金鑰 =================
  { const { execFileSync } = require('child_process');
    const L = path.join(ROOT, 'server/launchd');
    const pl = (f) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(L, f)], { encoding: 'utf8' }));
    const s = pl('com.dzy.bulletin.plist'), m = pl('com.dzy.bulletin.mirror.plist'), d = pl('com.dzy.bulletin.daily.plist');
    eq('launchd：三個 Label', [s.Label, m.Label, d.Label], ['com.dzy.bulletin', 'com.dzy.bulletin.mirror', 'com.dzy.bulletin.daily']);
    eq('launchd：伺服器 KeepAlive、mirror StartInterval 3600、daily 每天一次', [s.KeepAlive, s.RunAtLoad, m.StartInterval, m.RunAtLoad, d.StartCalendarInterval], [true, true, 3600, true, { Hour: 3, Minute: 30 }]);
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
    eq('備份資料夾僅 owner：sharedWith 0 記進結果檔、/health 帶出', [bl.sharedWith, h.backup.sharedWith], [0, 0]);
    eq('/health 兩個 job 剛跑完：沒有紅燈、沒有鏡像／快照相關的黃燈', [h.level !== 'red', h.why.filter((w) => /鏡像|快照|回填/.test(w))], [true, []]);

    FG.drive.folders[bkFolder].editors = [{ email: 'x' }];      // 有人把備份資料夾加了共用者 → 下一次快照回報、/health 黃燈
    r = await runJob('daily.js', [], JOB);
    h = (await request(S.port, 'GET', '/health')).json;
    eq('備份資料夾被加共用者：sharedWith 1、/health 黃燈原因含「備份資料夾有共用者」', [r.code, last(dir, 'backup-last.json').sharedWith, h.backup.sharedWith, h.why.includes('備份資料夾有共用者'), h.level === 'red' ? 'red' : 'not-red'], [0, 1, 1, true, 'not-red']);
    delete FG.drive.folders[bkFolder].editors;

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

    // #14 S6（配合 M2 316ef4e）：分頁有重複列＋空白列（搬遷自 GAS 的 append 殘留），鏡像仍被接受
    const sh = FG.book.getSheetByName('已讀'); sh.data.push(sh.data[1].slice(), sh.data[2].slice(), ['', '', '', '', '', '']); FG.bumpGen();
    r = await runJob('mirror.js', [], JOB);
    eq('S6：分頁已讀有 2 列重複＋1 列空白 → mirror.js 鏡像仍被接受、分頁換成去重後的資料', [r.code, last(dir, 'mirror-last.json').ok, FG.sheetRows('已讀').length], [0, true, q(dir, 'SELECT COUNT(*) AS n FROM reads')[0].n]);
    // S5 端到端：本機已讀變少（模擬還原）→ mirror.js 自己擋；--force → 帶 force:true，Apps Script 放行、試算表跟著本機
    { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('PRAGMA busy_timeout = 5000'); w.exec('DELETE FROM reads WHERE rowid = (SELECT MAX(rowid) FROM reads)'); w.close(); }
    const nLocal = q(dir, 'SELECT COUNT(*) AS n FROM reads')[0].n, sheetBefore = FG.sheetRows('已讀').length;
    FG.st.hits = {};
    r = await runJob('mirror.js', [], JOB);
    eq('S5：本機已讀少 1 → mirror.js 不送（沒有 mirror 呼叫）、exit 1、試算表不動', [r.code, FG.st.hits.mirror || 0, FG.sheetRows('已讀').length], [1, 0, sheetBefore]);
    r = await runJob('mirror.js', ['--force'], JOB);
    eq('S5：--force → Apps Script 放行（M2 已讀不減防呆靠 force:true 越過）、試算表＝本機', [r.code, FG.sheetRows('已讀').length, /鏡像完成/.test(r.out)], [0, nLocal, true]);
    await S.stop(); await FG.close(); }
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { if (p.exitCode === null) p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`jobs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
