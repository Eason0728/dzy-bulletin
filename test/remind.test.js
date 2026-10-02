// node test/remind.test.js — #26：光復未簽 3 天提醒（server/sign-remind.js）。
// A 段在程序內呼叫 runRemind（帶假的 now）驗名單規則與送出；B 段以子程序跑 sign-remind.js 驗未設定、--dry-run、正式送出。
// 小幫手用本機假 HTTP 伺服器模擬（自己找空埠、只關自己開的）；子程序一律帶 DZYB_NO_DOTENV=1，不讀真的 server/.env、不連任何外部網址。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const { runRemind, buildText, LABEL, MAX_CHARS } = require('../server/sign-remind.js');
const L = require('../js/logic.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-remind-')); tmps.push(d); return d; };
const last = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'remind-last.json'), 'utf8'));
const hasLast = (dir) => fs.existsSync(path.join(dir, 'logs', 'remind-last.json'));
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };   // --dry-run 會印訊息，程序內呼叫時收起來
const TPE = (s) => new Date(s + '+08:00');                    // 台北時間的某一刻

// 假小幫手：mode＝'ok'｜'dropOnce'（第一次直接斷線）｜'drop'（每次斷線）｜'badToken'｜'notJson'。bodies＝收到的 JSON
function fakeHelper() {
  const h = { mode: 'ok', bodies: [], hits: 0, seen: new Set() };
  h.server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      h.hits++;
      const drop = h.mode === 'drop' || (h.mode === 'dropOnce' && h.hits === 1);
      if (drop) { req.socket.destroy(); return; }
      let j = {}; try { j = JSON.parse(b); } catch (e) {}
      h.bodies.push(j);
      res.setHeader('Content-Type', 'application/json');
      if (h.mode === 'notJson') return res.end('<html>找不到網頁</html>');
      if (j.action !== 'enqueue_text' || j.token !== 'T-test') return res.end(JSON.stringify({ ok: false, error: 'bad token' }));
      if (h.mode === 'badToken') return res.end(JSON.stringify({ ok: false, error: 'bad token' }));
      // 模擬 GAS 判重：同一天、同一個 label 只收一次（假設一個啟用群組）
      const key = j.label; const added = h.seen.has(key) ? 0 : 1; h.seen.add(key);
      res.end(JSON.stringify({ ok: true, queued: added }));
    });
  });
  return new Promise((ok) => h.server.listen(0, '127.0.0.1', () => { h.url = 'http://127.0.0.1:' + h.server.address().port + '/exec'; ok(h); }));
}

// 資料：光復（gf:）、央廚（cf:）、手動建的（src 空）、離職的光復同仁；公告上架日依 base（台北日期）往回推
function seed(dir, base) {
  const d = (n) => L.addDays(base, -n);
  const st = makeSqliteStore(dir);
  st.load({
    posts: [
      { id: 'P-2', title: '衛生稽核', units: ['mala', 'mzt'], published: true, publishOn: d(5), expiresOn: d(-10) }, // 5 天、未到期（故意排在 P-1 前面：訊息順序要照 sortBoard，不照存入順序）
      { id: 'P-1', title: '十月排班', units: ['mala'], published: true, publishOn: d(3), expiresOn: '' },             // 滿 3 天
      { id: 'P-3', title: '才兩天', units: ['mala'], published: true, publishOn: d(2), expiresOn: '' },              // 不滿 3 天
      { id: 'P-4', title: '已下架', units: ['mala'], published: false, offOn: d(1), publishOn: d(9), expiresOn: '' },
      { id: 'P-5', title: '已到期', units: ['mala'], published: true, publishOn: d(9), expiresOn: d(1) },
      { id: 'P-6', title: '只給墨竹亭', units: ['mzt'], published: true, publishOn: d(7), expiresOn: '' },
      { id: 'P-7', title: '還沒上架', units: ['mala'], published: true, publishOn: d(-2), expiresOn: '' }
    ],
    staff: [
      { id: 'S-001', name: '張羽成', unit: 'mala', active: true, src: 'gf:A01' },
      { id: 'S-002', name: '蕭妏芳', unit: 'mala', active: true, src: 'gf:A02' },
      { id: 'S-003', name: '已簽者', unit: 'mala', active: true, src: 'gf:A03' },
      { id: 'S-004', name: '央廚人', unit: 'cf', active: true, src: 'cf:C01' },
      { id: 'S-005', name: '手動建', unit: 'mala', active: true, src: '' },
      { id: 'S-006', name: '離職者', unit: 'mala', active: false, src: 'gf:A06' },
      { id: 'S-007', name: '光復總部', unit: 'hq-dzy', active: true, src: 'gf:A07' },                                // 總部鼎兆元只簽「全部」→ 都不必簽
      { id: 'S-008', name: '墨竹亭人', unit: 'mzt', active: true, src: 'js:J01' }
    ],
    reads: [
      { postId: 'P-1', staffId: 'S-003', name: '已簽者', unit: 'mala', at: '2026-10-01T01:00:00.000Z', sigId: '' },
      { postId: 'P-2', staffId: 'S-003', name: '已簽者', unit: 'mala', at: '2026-10-01T01:00:00.000Z', sigId: '' },
      { postId: 'P-2', staffId: 'S-002', name: '蕭妏芳', unit: 'mala', at: '2026-10-01T01:00:00.000Z', sigId: '' }
    ],
    log: []
  });
  st.close();
}

function runJob(args, env) {
  return new Promise((ok) => {
    const e = Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: tmp('dzyb-home-'), REMIND_RETRY_MS: '0' }, env);
    const p = spawn(process.execPath, [path.join(ROOT, 'server', 'sign-remind.js')].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => ok({ code, out, err }));
  });
}

async function main() {
  const h = await fakeHelper();
  const NOW = TPE('2026-10-10T18:00:00'), BASE = '2026-10-10';
  const opt = (dir, extra) => Object.assign({ dir, url: h.url, token: 'T-test', now: NOW, retryMs: 0 }, extra || {});

  // ===== A1 名單規則與格式 =====
  {
    const dir = tmp(); seed(dir, BASE);
    const r = await runRemind(opt(dir));
    eq('A1 ok', r.ok, true);
    eq('A1 送一次', h.hits, 1);
    const b = h.bodies[0];
    eq('A1 action／label／token', [b.action, b.label, b.token], ['enqueue_text', LABEL, 'T-test']);
    eq('A1 label 固定', LABEL, '佈告欄未簽提醒');
    // 只挑 gf:、active；已簽不列；下架／到期／未上架／不滿 3 天／不必簽的單位都不列；依公告分組（sortBoard：上架日新到舊）
    eq('A1 訊息', b.text, '📋 佈告欄未簽提醒\n《十月排班》上架 3 天：張羽成、蕭妏芳\n《衛生稽核》上架 5 天：張羽成\n請到 https://dzy-bulletin.github.io 簽名，謝謝！');
    eq('A1 結果檔', (({ ok, people, posts, queued }) => ({ ok, people, posts, queued }))(last(dir)), { ok: true, people: 3, posts: 2, queued: 1 });
    eq('A1 結果檔有 at', typeof last(dir).at, 'string');
    // 同一天重跑：一樣送（label 相同），由小幫手判重 → queued 0、仍 ok
    const r2 = await runRemind(opt(dir));
    eq('A1 重跑仍 ok、label 相同、判重 0 列', [r2.ok, h.bodies[1].label, r2.queued], [true, LABEL, 0]);
  }

  // ===== A2 3 天邊界（台北時間）：10/1 上架 → 10/3 23:59 不列、10/4 00:00 列 =====
  {
    const dir = tmp(); seed(dir, '2026-10-04');                // P-1 上架日＝10/1
    h.bodies = []; h.hits = 0; h.seen.clear();
    const before = await quiet(() => runRemind(opt(dir, { now: TPE('2026-10-03T23:59:00'), dryRun: true })));
    eq('A2 2 天 23 小時：P-1 不在內', [/十月排班/.test(before.text), /《衛生稽核》上架 4 天/.test(before.text)], [false, true]);
    const at = await runRemind(opt(dir, { now: TPE('2026-10-04T00:00:00') }));
    eq('A2 3 天整：P-1 列入', [at.posts, /《十月排班》上架 3 天/.test(h.bodies[0].text)], [2, true]);
    eq('A2 dry-run 不送', h.hits, 1);
    // UTC 已是隔天、台北還沒到：用台北日期，不用 UTC
    h.bodies = []; h.hits = 0; h.seen.clear();
    const utc = await quiet(() => runRemind(opt(dir, { now: new Date('2026-10-03T15:59:00Z'), dryRun: true })));   // ＝台北 10/3 23:59
    eq('A2 以台北日期計算', /十月排班/.test(utc.text), false);
  }

  // ===== A3 沒有人要提醒 → 不打小幫手 =====
  {
    const dir = tmp(); seed(dir, BASE);
    const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'bulletin.db'));
    db.exec("INSERT INTO reads (postId, staffId, name, unit, at, sigId) VALUES ('P-1','S-001','','','',''),('P-1','S-002','','','',''),('P-2','S-001','','','','')");
    db.close();
    h.hits = 0;
    const r = await runRemind(opt(dir));
    eq('A3 無人不送', [r.ok, r.people, r.posts, h.hits], [true, 0, 0, 0]);
    eq('A3 結果檔', [last(dir).ok, last(dir).queued], [true, 0]);
  }

  // ===== A4 重試：第一次斷線 → 重試 1 次成功；一直斷線 → ok:false；拒收／非 JSON =====
  {
    const dir = tmp(); seed(dir, BASE);
    h.mode = 'dropOnce'; h.hits = 0; h.seen.clear();
    const r1 = await runRemind(opt(dir));
    eq('A4 斷線一次：重試後成功', [r1.ok, h.hits, r1.queued], [true, 2, 1]);
    h.mode = 'drop'; h.hits = 0;
    const r2 = await runRemind(opt(dir));
    eq('A4 一直斷線：只重試 1 次、ok:false', [r2.ok, h.hits, /連不上小幫手/.test(last(dir).error)], [false, 2, true]);
    h.mode = 'notJson'; h.hits = 0;
    const r3 = await runRemind(opt(dir));
    eq('A4 非 JSON：重試 1 次後失敗', [r3.ok, h.hits], [false, 2]);
    h.mode = 'badToken'; h.hits = 0;
    const r4 = await runRemind(opt(dir));
    eq('A4 拒收：不重試、ok:false', [r4.ok, h.hits, /拒收/.test(r4.error)], [false, 1, true]);
    eq('A4 錯誤不含 token', JSON.stringify(last(dir)).includes('T-test'), false);
    h.mode = 'ok';
  }

  // ===== A5 長度上限：超過就截斷並加「…等」，網址留著 =====
  {
    const names = Array.from({ length: 900 }, (_, i) => '同仁' + i);
    const t = buildText([{ title: '很長', days: 4, names }]);
    eq('A5 ≤ 上限', t.length <= MAX_CHARS, true);
    eq('A5 有「…等」與網址', [/…等\n請到 https:\/\/dzy-bulletin\.github\.io 簽名，謝謝！$/.test(t), t.startsWith('📋 佈告欄未簽提醒\n')], [true, true]);
    eq('A5 短的不截', buildText([{ title: 'x', days: 3, names: ['甲'] }]).includes('…等'), false);
  }

  // ===== A6 資料庫不存在 → ok:false，不建庫 =====
  {
    const dir = tmp(); h.hits = 0;
    const r = await runRemind(opt(dir));
    eq('A6 無庫', [r.ok, h.hits, fs.existsSync(path.join(dir, 'bulletin.db'))], [false, 0, false]);
  }

  // ===== B 子程序 =====
  const base = L.today();                                     // 子程序用真的現在時間
  {
    const dir = tmp(); seed(dir, base); h.hits = 0; h.bodies = []; h.seen.clear();
    // B1 未設定：exit 0、印原因、不送、不寫結果檔
    const b1 = await runJob([], { DATA_DIR: dir });
    eq('B1 未設定 exit 0', b1.code, 0);
    eq('B1 印原因', b1.out.trim(), '未設定 REMIND_ENQUEUE_URL／TOKEN，尚未啟用');
    eq('B1 不送、不寫結果', [h.hits, hasLast(dir)], [0, false]);
    const b1b = await runJob([], { DATA_DIR: dir, REMIND_ENQUEUE_URL: h.url });   // 只設一個也算未設定
    eq('B1 只設 URL 也是未啟用', [b1b.code, h.hits], [0, 0]);
    // B2 --dry-run：設好了也不送，印出訊息
    const b2 = await runJob(['--dry-run'], { DATA_DIR: dir, REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'T-test' });
    eq('B2 dry-run exit 0、不送、不寫結果', [b2.code, h.hits, hasLast(dir)], [0, 0, false]);
    eq('B2 印出訊息', /^📋 佈告欄未簽提醒\n《十月排班》上架 3 天：張羽成、蕭妏芳\n/.test(b2.out), true);
    const b2b = await runJob(['--dry-run'], { DATA_DIR: dir });
    eq('B2 dry-run 不需要先設定', [b2b.code, /《十月排班》/.test(b2b.out), h.hits], [0, true, 0]);
    // B3 正式送出
    const b3 = await runJob([], { DATA_DIR: dir, REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'T-test' });
    eq('B3 exit 0、送一次、label', [b3.code, h.hits, h.bodies[0] && h.bodies[0].label], [0, 1, LABEL]);
    eq('B3 結果檔', [last(dir).ok, last(dir).people, last(dir).posts, last(dir).queued], [true, 3, 2, 1]);
    // B4 小幫手拒收 → exit 1
    const b4 = await runJob([], { DATA_DIR: dir, REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'wrong' });
    eq('B4 拒收 exit 1', [b4.code, last(dir).ok], [1, false]);
  }

  // ===== C launchd 範本：每天 18:00、指到 sign-remind.js、佔位字串、不含金鑰 =====
  { const f = path.join(ROOT, 'server/launchd/com.dzy.bulletin.remind.plist');
    const x = JSON.parse(require('child_process').execFileSync('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }));
    eq('C Label／時間', [x.Label, x.StartCalendarInterval], ['com.dzy.bulletin.remind', { Hour: 18, Minute: 0 }]);
    eq('C 腳本與佔位字串', [x.ProgramArguments, x.EnvironmentVariables.DATA_DIR], [['__NODE__', '__REPO__/server/sign-remind.js'], '__DATA_DIR__']);
    eq('C 不含金鑰', /<key>(REMIND_|BRIDGE_)/.test(fs.readFileSync(f, 'utf8')), false); }

  h.server.close();
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`remind: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
