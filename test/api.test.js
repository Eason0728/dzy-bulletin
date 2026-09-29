// node test/api.test.js — 前端 js/api.js 收到 MOVED 的處理（#7、#13 建議 7）：vm 載入、假 fetch 一律回 MOVED
// 自動重載 5 分鐘內最多一次；存公告或管理端有未存草稿時不重載；sessionStorage 不能用時寧可不重載。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const SRC = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8') + ';this.API = API;';
function run(action, opt) {
  opt = opt || {};
  const st = { reloads: 0, dels: [] };
  const G = {
    CFG: { MODE: 'cloud', GAS_URL: 'x', TIMEOUT: { _default: 1000 } },
    UI: { store: { del: (k) => st.dels.push(k), set() {}, get() { return null; } } },
    location: { reload: () => { st.reloads++; } },
    fetch: async () => ({ text: async () => JSON.stringify({ ok: false, code: 'MOVED', message: '系統已搬家，請重新整理' }) }),
    setTimeout, clearTimeout, Promise, Date, Number, String, Object, JSON
  };
  if (opt.admin) G.Admin = opt.admin;
  Object.defineProperty(G, 'sessionStorage', { get: opt.ss || (() => opt.mem) });
  vm.createContext(G); vm.runInContext(SRC, G);
  return Promise.race([G.API.call(action, {}).then((r) => r.message), new Promise((ok) => setTimeout(() => ok('重載中'), 50))])
    .then((m) => ({ m, reloads: st.reloads, clearedLastBad: st.dels.includes('lastBad') }));
}
const mem = () => { const o = {}; return { getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); }, o }; };
const TIP = '系統搬家中，約 10 分鐘後請重新整理';
(async () => {
  const m1 = mem();
  eq('第一次 MOVED：自動重載、清 lastBad', await run('ack', { mem: m1 }), { m: '重載中', reloads: 1, clearedLastBad: true });
  eq('5 分鐘內第二次：不重載、顯示提示', await run('login', { mem: m1 }), { m: TIP, reloads: 0, clearedLastBad: true });
  m1.o.dzyb_movedReloadAt = String(Date.now() - 5 * 60 * 1000 - 1);
  eq('超過 5 分鐘：可再重載一次', (await run('ack', { mem: m1 })).reloads, 1);
  const m2 = mem();
  const r = await run('savePost', { mem: m2 });
  eq('存公告收到 MOVED：不重載（草稿只在記憶體）、提示先複製內容', [r.reloads, /複製/.test(r.m), 'dzyb_movedReloadAt' in m2.o], [0, true, false]);
  eq('管理端有未存草稿時其他動作收到 MOVED：也不重載', (await run('adminData', { mem: mem(), admin: { hasDraft: () => true } })).reloads, 0);
  eq('管理端沒有草稿：照常重載', (await run('adminLogin', { mem: mem(), admin: { hasDraft: () => false } })).reloads, 1);
  eq('Admin.hasDraft 丟錯：當作沒有草稿（照常重載）', (await run('adminLogin', { mem: mem(), admin: { hasDraft: () => { throw new Error('x'); } } })).reloads, 1);
  eq('sessionStorage 存取丟錯：不重載、只提示', await run('ack', { ss: () => { throw new Error('SecurityError'); } }), { m: TIP, reloads: 0, clearedLastBad: true });
  eq('sessionStorage 是 null（WebView 關掉 DOM storage）：不重載', (await run('ack', { ss: () => null })).reloads, 0);
  eq('setItem 丟錯（額度滿）：不重載', (await run('ack', { ss: () => ({ getItem: () => null, setItem() { throw new Error('Quota'); } }) })).reloads, 0);
  console.log(`api: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
