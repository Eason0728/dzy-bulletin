// node test/migrate.test.js — M5（#10）：server/migrate.js 一次性搬遷。
// 假 Google（test/fake-gas.js：gas/*.js 原封不動載進 vm＋本機假 Web App）先用真的 doPost 做出資料（主管上架、新增同仁、
// 同仁設密碼、簽名 45 張 → Drive），再切 PRIMARY=mini、EXPORT_ONCE=1，以子程序跑 migrate.js 經 server/bridge.js 真的打過去。
// 搬完用真伺服器（子程序、暫存埠、暫存資料夾）拿**搬遷前**發的同仁 token／主管 atoken 直接用，驗證 secret 真的搬過去。
// 不連任何外部網址；只關自己開的程序；暫存資料夾結束時刪掉。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { makeFakeGas } = require('./fake-gas.js');
const { makeBridge } = require('../server/bridge.js');
const { runMigrate, parseArgs } = require('../server/migrate.js');
const { runMirror } = require('../server/mirror.js');
const { makeSqliteStore } = require('../server/store-sqlite.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-mig-')); tmps.push(d); return d; };
const q = (dir, sql) => { const db = new DatabaseSync(path.join(dir, 'bulletin.db'), { readOnly: true }); try { return db.prepare(sql).all().map((r) => Object.assign({}, r)); } finally { db.close(); } };
const n = (dir, t) => q(dir, 'SELECT COUNT(*) AS n FROM ' + t)[0].n;
const PNG = (s) => 'data:image/png;base64,' + Buffer.from('簽名-' + s).toString('base64');
function freePort() { return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); }); }
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
async function startServer(dir) {   // 正式模式（非 E2E）、沒有橋接：只測資料層與登入憑證
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { PATH: process.env.PATH, HOME: tmp('dzyb-home-'), PORT: String(port), DATA_DIR: dir, ALLOW_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', () => {});
  await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
  return { port, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.on('exit', () => ok()); p.kill(); }) };
}
function api(port, action, body) {
  return new Promise((ok) => {
    const buf = Buffer.from(JSON.stringify(Object.assign({}, body || {}, { action })));
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'text/plain', 'Content-Length': buf.length }, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {} ok(json); });
    });
    r.on('error', (e) => ok({ ok: false, code: e.code }));
    r.write(buf); r.end();
  });
}
const checks = (out) => (out.match(/^ {3}(✅|❌) .*$/gm) || []);

async function main() {
  // ================= 準備：假 Google 上用真的 doPost 做出資料 =================
  const FG = makeFakeGas();
  const URL0 = await FG.listen();
  const KEY = 'k'.repeat(40), SECRET = 'test-secret-migrate-0123456789';   // 測試用假值（非正式）
  Object.assign(FG.props, { BRIDGE_KEY: KEY, PRIMARY: 'gas', TOKEN_SECRET: SECRET, ADMIN_INIT: 'admin-pass-99' });
  const doPost = (b) => JSON.parse(FG.G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  const atoken = doPost({ action: 'adminLogin', pass: 'admin-pass-99' }).data.atoken;
  const today = FG.G.DZYB.today();
  const posts = ['公告一', '公告二', '公告三'].map((t, i) => doPost({ action: 'savePost', atoken, post: { title: t, body: '內容' + i, units: ['mala'], publishOn: today } }).data.post.id);
  const staff = Array.from({ length: 15 }, (_, i) => doPost({ action: 'staffAdd', atoken, name: '同仁' + i, unit: 'mala' }).data.staff.id);
  const tokens = staff.map((id) => doPost({ action: 'setPin', staffId: id, pin: '2580' }).data.token);
  let acks = 0;
  posts.forEach((p) => tokens.forEach((t, i) => { if (doPost({ action: 'ack', token: t, postId: p, sig: PNG(p + i) }).ok) acks++; }));
  doPost({ action: 'staffAdd', atoken, name: '還沒設密碼', unit: 'cf' });
  eq('（前提）GAS 上 3 則公告、16 人、45 張簽名（Drive 上）', [posts.length, FG.sheetRows('同仁').length, acks, Object.keys(FG.drive.files).length], [3, 16, 45, 45]);
  const tokA = tokens[0];
  eq('（前提）搬遷前的同仁 token／主管 atoken 在 GAS 能用', [doPost({ action: 'board', token: tokA }).ok, doPost({ action: 'adminData', atoken }).ok], [true, true]);
  const gasLog = FG.sheetRows('操作紀錄').length;

  // 切換：PRIMARY=mini（寫入回 MOVED）、EXPORT_ONCE=1
  Object.assign(FG.props, { PRIMARY: 'mini', EXPORT_ONCE: '1' });
  const ENV = (dir, extra) => Object.assign({ DATA_DIR: dir, BRIDGE_URL: URL0, BRIDGE_KEY: KEY }, extra || {});

  // ================= 缺 secret：GAS 端拒絕 export → migrate.js exit≠0、不寫入、EXPORT_ONCE 保留 =================
  { const dir = path.join(tmp(), 'data');
    delete FG.props.TOKEN_SECRET;
    const r = await runJob('migrate.js', ['--save', path.join(path.dirname(dir), 'x.json')], ENV(dir));
    FG.props.TOKEN_SECRET = SECRET;
    eq('GAS 缺 TOKEN_SECRET：export 被拒 → exit 4、沒建資料庫、沒存檔、EXPORT_ONCE 保留',
      [r.code, fs.existsSync(path.join(dir, 'bulletin.db')), fs.existsSync(path.join(path.dirname(dir), 'x.json')), FG.props.EXPORT_ONCE], [4, false, false, '1']); }

  // ================= dry-run：呼叫 export 一次 → 存檔（600）→ 印筆數／張數／預估；不寫入 =================
  const base = tmp(), dir = path.join(base, 'data'), file = path.join(base, 'export.json');
  FG.st.hits = {};
  let r = await runJob('migrate.js', ['--dry-run', '--save', file], ENV(dir));
  eq('dry-run：exit 0、export 打 1 次、EXPORT_ONCE 已被刪掉', [r.code, FG.st.hits.export, 'EXPORT_ONCE' in FG.props], [0, 1, false]);
  eq('dry-run：匯出檔存在、權限 600', [fs.existsSync(file), fs.existsSync(file) && (fs.statSync(file).mode & 0o777).toString(8)], [true, '600']);
  eq('dry-run：印出各表筆數', /公告 3、同仁 16、已讀 45、操作紀錄 \d+/.test(r.out), true);
  eq('dry-run：印出簽名圖張數與批次、預估下載時間', [/簽名圖 45 張 → 3 次 sigs 橋接呼叫（每批 20 張）/.test(r.out), /預估下載 \d+ 秒～\d+ (秒|分鐘)/.test(r.out)], [true, true]);
  eq('dry-run：沒有下載簽名圖、沒有建資料庫', [FG.st.hits.sigs || 0, fs.existsSync(path.join(dir, 'bulletin.db'))], [0, false]);
  eq('dry-run：提示下一步用 --from', r.out.includes('--from ' + file), true);
  const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq('匯出檔：含 secret 與 admin.hash、已讀的 sigId＝Drive id', [exp.secret === SECRET, !!exp.admin.hash, exp.reads.every((x) => !!FG.drive.files[x.sigId])], [true, true, true]);
  eq('輸出不含 secret／密碼雜湊', [r.out.includes(SECRET), exp.staff.some((s) => s.pinHash && r.out.includes(s.pinHash)), r.out.includes(exp.admin.hash)], [false, false, false]);

  r = await runJob('migrate.js', ['--dry-run', '--save', path.join(base, 'again.json')], ENV(dir));
  eq('export 只能用一次：第二次呼叫 → exit 4、提示改用 --from、不留空檔', [r.code, /--from/.test(r.out), fs.existsSync(path.join(base, 'again.json'))], [4, true, false]);
  r = await runJob('migrate.js', ['--dry-run', '--save', file], ENV(dir));
  eq('--save 指到既有檔：不覆蓋、exit 2（那可能是唯一一份 export）', [r.code, fs.readFileSync(file, 'utf8') === JSON.stringify(exp)], [2, true]);

  // ================= 缺 secret／admin.hash 的匯出檔：exit 3、拒絕寫入 =================
  for (const [label, mut] of [['secret', (x) => { delete x.secret; }], ['admin.hash', (x) => { x.admin.hash = ''; }], ['reads', (x) => { delete x.reads; }]]) {
    const b2 = tmp(), f2 = path.join(b2, 'bad.json'), d2 = path.join(b2, 'data'), x = JSON.parse(JSON.stringify(exp));
    mut(x); fs.writeFileSync(f2, JSON.stringify(x), { mode: 0o600 });
    const r2 = await runJob('migrate.js', ['--from', f2], ENV(d2));
    eq(`匯出檔缺 ${label}：exit 3、拒絕寫入（沒建資料庫、沒建 sigs）`, [r2.code, fs.existsSync(path.join(d2, 'bulletin.db')), fs.existsSync(path.join(d2, 'sigs')), /拒絕寫入/.test(r2.out)], [3, false, false, true]);
  }

  // ================= 正式匯入（--from）：六項全 ✅、簽名圖批次 =================
  FG.st.hits = {};
  r = await runJob('migrate.js', ['--from', file], ENV(dir));
  const ck = checks(r.out);
  eq('正式匯入：exit 0、六項全 ✅', [r.code, ck.length, ck.filter((x) => x.includes('✅')).length], [0, 6, 6]);
  eq('簽名圖批次：45 張只打 3 次 sigs（每批 ≤20）、沒有再打 export', [FG.st.hits.sigs, FG.st.hits.export || 0], [3, 0]);
  eq('筆數＝GAS export 筆數', [n(dir, 'posts'), n(dir, 'staff'), n(dir, 'reads'), n(dir, 'log')], [exp.posts.length, exp.staff.length, exp.reads.length, exp.log.length]);
  eq('操作紀錄＝GAS 分頁筆數（凍結後 GAS 沒有新增）', [n(dir, 'log'), FG.sheetRows('操作紀錄').length], [gasLog, gasLog]);
  const rows = q(dir, 'SELECT postId, staffId, sigId, driveSigId FROM reads ORDER BY rowid');
  eq('已讀：driveSigId＝GAS 的 Drive id、sigId＝本機檔名（與伺服器同一套命名）',
    rows.every((x, i) => x.driveSigId === exp.reads[i].sigId && x.sigId === x.postId + '_' + x.staffId + '.png'), true);
  eq('簽名圖檔內容＝Drive 上的原圖（逐張）', rows.every((x) => fs.readFileSync(path.join(dir, 'sigs', x.sigId)).equals(Buffer.from(FG.drive.files[x.driveSigId].bytes.map((b) => b & 255)))), true);
  eq('提示刪除匯出檔', r.out.includes('rm ' + file), true);
  eq('輸出不含 secret', r.out.includes(SECRET), false);
  eq('mirror.js 空庫保險不擋搬遷後的庫（有同仁）', n(dir, 'staff') > 0, true);

  // ================= 搬遷後：伺服器認得搬遷前的 token（不必重新登入） =================
  { const S = await startServer(dir);
    const b = await api(S.port, 'board', { token: tokA });
    eq('同仁：搬遷前的 token 直接能看公告（secret 有搬過去）、已簽的 3 則都在', [b.ok, b.ok && Object.keys(b.data.myReads).length], [true, 3]);
    const ad = await api(S.port, 'adminData', { atoken });
    eq('主管：搬遷前的 atoken 直接能用（通行碼版本＋secret 有搬過去）', ad.ok, true);
    eq('同仁：原本的密碼能登入（密碼雜湊有搬過去）', (await api(S.port, 'login', { staffId: staff[5], pin: '2580' })).ok, true);
    eq('主管：原本的通行碼能登入', (await api(S.port, 'adminLogin', { pass: 'admin-pass-99' })).ok, true);
    eq('亂造的 token 仍被拒（不是放行一切）', (await api(S.port, 'board', { token: staff[0] + '.1.xxxx' })).code, 'AUTH');
    await S.stop();
    const st = makeSqliteStore(dir);
    const sigs = st.getSigs(posts[1]);
    eq('回條簽名圖看得到（本機 sigs/，內容＝原本簽的）', [Object.keys(sigs).length, sigs[staff[2]]], [15, PNG(posts[1] + 2)]);
    st.close(); }

  // ================= 目標非空：拒絕；--force 先備份再匯入（--from 重跑） =================
  { const before = n(dir, 'reads');
    FG.st.hits = {};
    const r1 = await runJob('migrate.js', ['--from', file], ENV(dir));
    eq('目標已有資料：exit 2、拒絕、沒打任何橋接、資料不動', [r1.code, /已有資料/.test(r1.out), Object.keys(FG.st.hits).length, n(dir, 'reads')], [2, true, 0, before]);
    const r1d = await runJob('migrate.js', ['--from', file, '--dry-run'], ENV(dir));
    eq('--from＋--dry-run 重看：exit 0、提醒要 --force', [r1d.code, /--force/.test(r1d.out)], [0, true]);
    fs.writeFileSync(path.join(dir, 'sigs', 'mini-only.png'), 'x');   // 模擬 Mac mini 期間新簽的圖（--force 不刪檔）
    const r2 = await runJob('migrate.js', ['--from', file, '--force'], ENV(dir));
    const bak = fs.readdirSync(dir).filter((f) => /^bulletin\.db\.before-migrate-/.test(f));
    eq('--force：exit 0、六項全 ✅、先備份舊庫', [r2.code, checks(r2.out).filter((x) => x.includes('✅')).length, bak.length], [0, 6, 1]);
    const bdb = new DatabaseSync(path.join(dir, bak[0]), { readOnly: true });
    eq('備份檔是完整的舊庫', Number(bdb.prepare('SELECT COUNT(*) AS n FROM reads').get().n), before); bdb.close();
    eq('--force 不刪 sigs/ 裡既有的圖', fs.existsSync(path.join(dir, 'sigs', 'mini-only.png')), true);
    const e2 = tmp(), r3 = await runJob('migrate.js', ['--from', path.join(e2, 'nope.json')], ENV(path.join(e2, 'data')));
    eq('--from 檔案不存在：exit 2', r3.code, 2);
    const loose = path.join(tmp(), 'loose.json'); fs.writeFileSync(loose, JSON.stringify(exp)); fs.chmodSync(loose, 0o644);
    const r4 = await runJob('migrate.js', ['--from', loose], ENV(path.join(path.dirname(loose), 'data')));
    eq('--from 檔權限太寬：自動改 600 後照常匯入', [r4.code, (fs.statSync(loose).mode & 0o777).toString(8)], [0, '600']); }

  // ================= 竄改一筆：逐筆比對抓得到（不是只比筆數） =================
  const bridge = makeBridge(URL0, KEY);
  const quietRun = async (o) => { const lines = []; const res = await runMigrate(Object.assign({ say: (s) => lines.push(s), bridge, from: file }, o)); res.out = lines.join('\n'); return res; };
  const status = (res) => res.checks.map((c) => (c.ok ? '✅' : '❌') + c.name.split('（')[0]);
  const ALL = ['✅公告', '✅同仁', '✅已讀', '✅操作紀錄', '✅簽名圖', '✅登入金鑰＋管理通行碼雜湊'];
  { const res = await quietRun({ dir: path.join(tmp(), 'data') });
    eq('（對照）程序內跑：六項全 ✅', [res.code, status(res)], [0, ALL]); }
  const tamper = async (label, sql, want) => {
    const res = await quietRun({ dir: path.join(tmp(), 'data'), afterLoad: (d) => {
      if (typeof sql === 'function') return sql(d);
      const db = new DatabaseSync(path.join(d, 'bulletin.db')); db.exec(sql); db.close();
    } });
    const w = [].concat(want);
    eq('竄改 ' + label + ' → exit 1、只有' + w.join('＋') + ' ❌', [res.code, status(res)], [1, ALL.map((x) => (w.includes(x.slice(1)) ? '❌' + x.slice(1) : x))]);
    return res;
  };
  const tS = await tamper('同仁一筆的密碼雜湊（筆數不變）', `UPDATE staff SET json = json_set(json, '$.pinHash', 'zzz') WHERE id = '${staff[7]}'`, '同仁');
  eq('❌ 那行列出是哪一筆（只列 id、不列雜湊）', [tS.out.includes(staff[7]), tS.out.includes('zzz')], [true, false]);
  await tamper('公告一筆的內文', `UPDATE posts SET json = json_set(json, '$.body', '被改了') WHERE id = '${posts[2]}'`, '公告');
  await tamper('已讀一筆的簽名時間', `UPDATE reads SET at = '2000-01-01' WHERE rowid = 10`, '已讀');
  await tamper('已讀一筆的 driveSigId', `UPDATE reads SET driveSigId = 'X' WHERE rowid = 11`, '已讀');
  await tamper('操作紀錄一筆的摘要', `UPDATE log SET summary = '被改了' WHERE seq = 2`, '操作紀錄');
  await tamper('一張簽名圖（長度相同、內容不同）', (d) => { const f = path.join(d, 'sigs', q(d, 'SELECT sigId FROM reads WHERE rowid = 5')[0].sigId); const b = fs.readFileSync(f); b[0] ^= 1; fs.writeFileSync(f, b); }, '簽名圖');
  await tamper('一張簽名圖（檔案不見）', (d) => fs.unlinkSync(path.join(d, 'sigs', q(d, 'SELECT sigId FROM reads WHERE rowid = 6')[0].sigId)), '簽名圖');
  await tamper('登入金鑰', `UPDATE kv SET v = 'other' WHERE k = 'secret'`, '登入金鑰＋管理通行碼雜湊');
  await tamper('少一筆已讀（筆數也不同；那筆的簽名圖也跟著對不上）', `DELETE FROM reads WHERE rowid = 3`, ['已讀', '簽名圖']);

  // Drive 上讀不到的簽名圖：Drive id 保留、簽名圖那項 ❌、exit 1
  { const gone = exp.reads[4].sigId, keep = FG.drive.files[gone]; delete FG.drive.files[gone];
    const d = path.join(tmp(), 'data'), res = await quietRun({ dir: d });
    FG.drive.files[gone] = keep;
    eq('Drive 少一張圖：exit 1、只有簽名圖 ❌、那筆 driveSigId 仍保留', [res.code, status(res), q(d, `SELECT driveSigId, sigId FROM reads WHERE driveSigId = '${gone}'`)[0]],
      [1, ALL.map((x) => (x === '✅簽名圖' ? '❌簽名圖' : x)), { driveSigId: gone, sigId: '' }]); }

  // 簽名圖下載失敗（Google 當掉）：每批重試，連 3 次失敗才中斷、資料庫沒有動
  { const d = path.join(tmp(), 'data');
    const flaky = { n: 0, call: async (op, p, t) => { if (op === 'sigs' && flaky.n++ < 2) throw Object.assign(new Error('x'), { code: 'BRIDGE' }); return bridge.call(op, p, t); } };
    const res = await quietRun({ dir: d, bridge: flaky });
    eq('sigs 失敗 2 次後成功：重試後六項全 ✅', [res.code, status(res)], [0, ALL]);
    const d2 = path.join(tmp(), 'data');
    const dead = { call: async () => { throw Object.assign(new Error('x'), { code: 'BRIDGE_TIMEOUT' }); } };
    const res2 = await quietRun({ dir: d2, bridge: dead });
    eq('sigs 連 3 次失敗：exit 5、資料庫沒有建、提示 --from 重跑', [res2.code, fs.existsSync(path.join(d2, 'bulletin.db')), /--from/.test(res2.out)], [5, false, true]); }
  { const d = path.join(tmp(), 'data'); FG.st.hits = {};
    const res = await quietRun({ dir: d, batch: 7 });
    eq('--batch 7：45 張打 7 次 sigs', [res.code, FG.st.hits.sigs], [0, 7]); }
  eq('參數：--batch 超過 20 一律 20、未知參數擋下', [parseArgs(['--batch', '50']).batch, !!parseArgs(['--nope']).bad, !!parseArgs(['--from']).bad], [20, true, true]);

  // ================= mirror.js 空庫保險：切換日 PRIMARY=mini 後、搬遷前，空庫不可蓋掉試算表 =================
  { const d = tmp(); makeSqliteStore(d).close();
    const calls = []; const B = { call: async (op) => { calls.push(op); return { counts: {} }; } };
    const lines = []; const o = console.log; console.log = (s) => lines.push(s);
    let res; try { res = await runMirror({ dir: d, bridge: B }); } finally { console.log = o; }
    eq('空庫：mirror 拒絕（ok:false）、一次橋接都沒打', [res.ok, calls, /資料庫是空的/.test(res.error)], [false, [], true]); }

  // ================= server/latency.js（切換後量測，CUTOVER.md 步驟 9） =================
  { const { fromLog, fromValues } = require('../server/latency.js');
    const log = Array.from({ length: 100 }, (_, i) => `2026-10-01T07:00:${String(i % 60).padStart(2, '0')}.000Z board ${i + 1}ms ok`)
      .concat(['2026-10-01T07:01:00.000Z ack 30ms ok', '2026-10-01T07:01:01.000Z ack 5000ms SERVER', '2026-09-30T07:00:00.000Z ack 999ms ok', '佈告欄伺服器 v0.5.4 啟動', 'garbage']).join('\n');
    const r0 = fromLog(log, { actions: ['board', 'ack'] });
    eq('latency：board 100 筆 p50＝50、p95＝95（nearest-rank）', [r0.board.n, r0.board.p50, r0.board.p95, r0.board.max], [100, 50, 95, 100]);
    eq('latency：錯誤回應不算進百分位、另計', [r0.ack.n, r0.ack.errors], [2, 1]);
    eq('latency：--since 過濾', fromLog(log, { actions: ['ack'], since: '2026-10-01T00:00:00Z' }).ack.n, 1);
    const v = fromValues(Array.from({ length: 30 }, (_, i) => ((i + 1) / 10).toFixed(3)).join('\n'));
    eq('latency --values：30 筆中位數＝第 15、16 筆平均，p90＝第 27 筆', [v.n, v.median, v.p90], [30, 1.55, 2.7]);
    // 真伺服器的每請求紀錄格式要能被 latency.js 讀到（index.js 的格式一改這裡就會紅）
    const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { PATH: process.env.PATH, HOME: tmp('dzyb-home-'), PORT: String(await freePort()), DATA_DIR: path.join(tmp(), 'lat'), ALLOW_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
    procs.push(p);
    let out = ''; p.stdout.on('data', (c) => { out += c; });
    await new Promise((ok) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); });
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)[1]);
    for (let i = 0; i < 5; i++) await api(port, 'roster');
    await api(port, 'board', { token: 'x' });
    await new Promise((ok) => setTimeout(ok, 100));
    const rl = fromLog(out, { actions: ['roster', 'board'] });
    eq('latency 讀得到真伺服器的紀錄：roster 5 次成功、board 1 次錯誤', [rl.roster && rl.roster.n, rl.board && rl.board.errors], [5, 1]);
    await new Promise((ok) => { p.on('exit', () => ok()); p.kill(); }); }

  await FG.close();
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { if (p.exitCode === null) p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`migrate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
