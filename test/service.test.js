// node test/service.test.js — 透過本機假後端把 API 契約 17 個 action 全部打一遍
'use strict';
global.DZYB = require('../js/logic.js');
global.makeAuth_ = require('../gas/Auth.js').makeAuth_;
global.makeService_ = require('../gas/Service.js').makeService_;
const M = require('../js/mock.js');
const C = (a, q) => M.callSync(a, q);
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const seen = new Set();
const call = (a, q) => { seen.add(a); return C(a, q); };

// roster：只回遮罩姓名、不回雜湊
let r = call('roster');
eq('roster ok', r.ok, true);
eq('roster masked', r.data.find(s => s.id === 'S-001').name, '陳O安');
eq('roster no hash leak', Object.keys(r.data[0]).sort(), ['hasPin', 'id', 'locked', 'name', 'unit']);
eq('tester no pin', r.data.find(s => s.id === 'S-013').hasPin, false);

// board 不帶憑證
eq('board no token', call('board', {}).code, 'AUTH');

// setPin
eq('setPin weak', call('setPin', { staffId: 'S-013', pin: '1234' }).code, 'WEAK_PIN');
eq('setPin bad', call('setPin', { staffId: 'S-013', pin: '12' }).code, 'BAD_REQ');
r = call('setPin', { staffId: 'S-013', pin: '2580' });
eq('setPin ok', [r.ok, r.data.me], [true, { id: 'S-013', name: '測試員甲', unit: 'mala' }]);
eq('setPin returns board', Array.isArray(r.data.board.posts) && r.data.board.me.id === 'S-013', true);
const tok = r.data.token;
eq('setPin again', call('setPin', { staffId: 'S-013', pin: '1357' }).code, 'HAS_PIN');

// board / ack
r = call('board', { token: tok });
eq('board ok', r.ok, true);
eq('board only on', r.data.posts.every(p => p.status.state === 'on'), true);
eq('board pinned first', r.data.posts[0].pinned, true);
eq('board myReads empty', r.data.myReads, {});
eq('board excludes plan', r.data.posts.some(p => p.id === 'P-20260929-001'), false);
eq('ack bad sig', call('ack', { token: tok, postId: 'P-20260920-001', sig: 'x' }).code, 'BAD_REQ');
eq('ack other unit', call('ack', { token: tok, postId: 'P-20260915-001', sig: 'data:image/jpeg;base64,AA' }).code, 'BAD_REQ');
eq('ack huge sig', call('ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/' + 'A'.repeat(45000) }).code, 'BAD_REQ');
r = call('ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/jpeg;base64,AA' });
eq('ack ok', r.ok, true);
eq('ack twice', call('ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/jpeg;base64,AA' }).code, 'ALREADY');
eq('board myReads', Object.keys(call('board', { token: tok }).data.myReads), ['P-20260920-001']);
eq('ack archived', call('ack', { token: tok, postId: 'P-20260720-001', sig: 'data:image/jpeg;base64,AA' }).code, 'BAD_REQ');

// history
r = call('history', { token: tok });
eq('history only off', r.data.posts.every(p => p.status.state === 'off'), true);
eq('history order', r.data.posts.map(p => p.status.offDate), ['2026-09-05', '2026-08-31', '2026-08-15', '2026-07-20']);

// login：連錯 3 次鎖
eq('login bad1', [call('login', { staffId: 'S-013', pin: '1111' }).code, C('login', { staffId: 'S-013', pin: '1111' }).left], ['BAD_PIN', 1]);
eq('login bad3 locks', C('login', { staffId: 'S-013', pin: '1111' }).code, 'LOCKED');
eq('login locked right pin', C('login', { staffId: 'S-013', pin: '2580' }).code, 'LOCKED');
eq('roster shows locked', C('roster').data.find(s => s.id === 'S-013').locked, true);
eq('existing token still valid while locked', C('board', { token: tok }).ok, true);

// admin
eq('admin wrong', call('adminLogin', { pass: 'nope' }).code, 'AUTH');
r = C('adminLogin', { pass: '1234' });
eq('admin ok (init)', r.ok, true);
eq('adminLogin returns data', Array.isArray(r.data.data.posts) && Array.isArray(r.data.data.staff), true);
let at = r.data.atoken;
eq('adminData no token', call('adminData', {}).code, 'AUTH');
r = call('adminData', { atoken: at });
eq('adminData ok', r.ok, true);
eq('adminData counts', r.data.posts.find(p => p.id === 'P-20260920-001').readCount + '/' + r.data.posts.find(p => p.id === 'P-20260920-001').targetCount, '2/6');   // 小辛辣 5 人＋總部小辛辣 1 人
eq('adminData staff full name', r.data.staff.find(s => s.id === 'S-001').name, '陳大安');
eq('adminData locked flag', r.data.staff.find(s => s.id === 'S-013').locked, true);

// receipts
r = call('receipts', { atoken: at, postId: 'P-20260920-001' });
eq('receipts rows', r.data.rows.length, 6);
eq('receipts read', r.data.rows.filter(x => x.read).map(x => x.staffId).sort(), ['S-001', 'S-013']);

// 重設密碼 → 舊憑證失效、解鎖
eq('reset', call('staffResetPin', { atoken: at, staffId: 'S-013' }).ok, true);
eq('old token dead', C('board', { token: tok }).code, 'AUTH');
eq('roster after reset', C('roster').data.find(s => s.id === 'S-013'), { id: 'S-013', name: '測OO甲', unit: 'mala', hasPin: false, locked: false });

// 上傳＋上架
eq('upload bad type', call('uploadFile', { atoken: at, name: 'a.png', data: 'AAAA' }).code, 'BAD_TYPE');
r = C('uploadFile', { atoken: at, name: 'a.pdf', data: 'JVBERi0x' });
eq('upload ok', [r.ok, r.data.type], [true, 'pdf']);
const f1 = r.data;
// 公告改單位後，仍在職的簽名者標 inTarget:false、active:true
{ const rr = C('adminLogin', { pass: '1234' }).data.atoken; const p0 = C('adminData', { atoken: rr }).data.posts.find(p => p.id === 'P-20260925-001');
  C('savePost', { atoken: rr, post: Object.assign({}, p0, { units: ['cf'] }) });
  const row = C('receipts', { atoken: rr, postId: 'P-20260925-001' }).data.rows.find(x => x.staffId === 'S-001');
  eq('out of scope reader', [row.active, row.inTarget, row.read], [true, false, true]); }
eq('savePost bad file type', C('savePost', { atoken: at, post: { title: 't', units: ['mala'], publishOn: DZYB.today(), files: [{ id: 'x', name: 'evil.exe', type: 'pdf', size: 1 }] } }).code, 'BAD_TYPE');
eq('savePost invalid', call('savePost', { atoken: at, post: { title: '', units: ['mala'], publishOn: '2026-09-29' } }).code, 'BAD_REQ');
r = C('savePost', { atoken: at, post: { title: '測試公告', body: 'x', units: ['cf', 'mzt', 'mala'], publishOn: DZYB.today(), expiresOn: '', pinned: true, files: [f1] } });
eq('savePost new', [r.ok, r.data.post.units, r.data.post.status.state], [true, ['mzt', 'mala', 'cf'], 'on']);
const pid = r.data.post.id;
eq('post id format', new RegExp('^P-' + DZYB.today().replace(/-/g, '') + '-\\d{3}$').test(pid), true);
r = C('savePost', { atoken: at, post: { id: pid, title: '測試公告（改）', units: ['mala'], publishOn: DZYB.today(), files: [] } });
eq('savePost edit', [r.data.post.title, r.data.post.files.length, r.data.post.createdAt !== undefined], ['測試公告（改）', 0, true]);
eq('revoked blob', M.blobOf(f1.id), null);

// 下架／重新上架／置頂
r = call('setPublished', { atoken: at, postId: pid, on: false });
eq('off', [r.data.post.status.state, r.data.post.status.offDate], ['off', DZYB.today()]);
eq('on again', call('setPublished', { atoken: at, postId: pid, on: true }).data.post.status.state, 'on');
eq('reopen expired', C('setPublished', { atoken: at, postId: 'P-20260720-001', on: true }).code, 'BAD_REQ');
eq('pin off', call('setPinned', { atoken: at, postId: pid, on: false }).data.post.pinned, false);

// 同仁增刪
eq('staffAdd empty', call('staffAdd', { atoken: at, name: ' ', unit: 'cf' }).code, 'BAD_REQ');
r = C('staffAdd', { atoken: at, name: '新同仁', unit: 'cf' });
eq('staffAdd ok', [r.ok, r.data.staff.id], [true, 'S-019']);
eq('staffAdd dup', C('staffAdd', { atoken: at, name: '新同仁', unit: 'cf' }).code, 'BAD_REQ');
eq('staffDelete', call('staffDelete', { atoken: at, staffId: 'S-001' }).ok, true);
eq('deleted not in roster', C('roster').data.some(s => s.id === 'S-001'), false);
r = C('receipts', { atoken: at, postId: 'P-20260920-001' });
eq('deleted reader kept, inactive', [r.data.rows.find(x => x.staffId === 'S-001').active, r.data.rows.find(x => x.staffId === 'S-001').inTarget], [false, false]);
eq('no debug field on server error', Object.keys(M.callSync('receipts', { atoken: at, postId: null })).includes('debug'), false);
eq('deleted not counted', C('adminData', { atoken: at }).data.posts.find(p => p.id === 'P-20260920-001').targetCount, 5);

// 更換通行碼：只能經由 ADMIN_INIT（網頁沒有 changePass）
eq('changePass removed', C('changePass', { atoken: at, oldPass: '1234', newPass: '5678' }).code, 'BAD_REQ');
M.setAdminInit('5678');
r = C('adminLogin', { pass: '5678' });
eq('ADMIN_INIT replaces pass', r.ok, true);
eq('old atoken dead after replace', C('adminData', { atoken: at }).code, 'AUTH');
eq('new atoken ok', C('adminData', { atoken: r.data.atoken }).ok, true);
eq('old pass rejected', C('adminLogin', { pass: '1234' }).code, 'AUTH');
eq('ADMIN_INIT consumed', C('adminLogin', { pass: '5678' }).ok, true);

// C15 總部：看得到／要簽
{ const tk = id => { M.callSync('staffResetPin', { atoken: C('adminLogin', { pass: '5678' }).data.atoken, staffId: id }); return C('setPin', { staffId: id, pin: '2580' }).data.token; };
  const dzy = tk('S-016'), hmzt = tk('S-017'), hmala = tk('S-018');
  const ids = t => C('board', { token: t }).data.posts.map(p => p.id);
  eq('hq-dzy sees cf post', ids(dzy).includes('P-20260927-001'), true);
  eq('hq-mzt sees only mzt/all', ids(hmzt).every(id => ['P-20260925-001', 'P-20260915-001', 'P-20260910-001'].includes(id)) && ids(hmzt).includes('P-20260915-001'), true);
  eq('hq-mala not see mzt post', ids(hmala).includes('P-20260915-001'), false);
  eq('hq-mzt history filtered', C('history', { token: hmzt }).data.posts.some(p => p.units.indexOf('mzt') < 0), false);
  eq('hq-dzy ack partial rejected', C('ack', { token: dzy, postId: 'P-20260927-001', sig: 'data:image/png;base64,AA' }).code, 'BAD_REQ');
  eq('hq-dzy ack all ok', C('ack', { token: dzy, postId: 'P-20260910-001', sig: 'data:image/png;base64,AA' }).ok, true);
  eq('hq-mala ack mzt rejected', C('ack', { token: hmala, postId: 'P-20260915-001', sig: 'data:image/png;base64,AA' }).code, 'BAD_REQ');
  const ad = C('adminLogin', { pass: '5678' }).data.atoken, posts = C('adminData', { atoken: ad }).data.posts;
  const tgt = id => posts.find(p => p.id === id).targetCount;
  eq('target all includes hq-dzy/hq-mzt/hq-mala', tgt('P-20260910-001'), 18);   // 門市在職 15（S-001 已刪、S-019 新增）＋總部 3
  eq('target cf excludes hq', tgt('P-20260927-001'), 6);   // 央廚 5＋S-019，總部都不算
  eq('staffAdd hq unit', C('staffAdd', { atoken: ad, name: '總部新人', unit: 'hq-mzt' }).ok, true);
  eq('staffAdd bad unit', C('staffAdd', { atoken: ad, name: 'x', unit: 'hq' }).code, 'BAD_REQ');
}
// 從打卡系統同步
{ const ad = C('adminLogin', { pass: '5678' }).data.atoken;
  eq('syncClock no token', call('syncClock', {}).code, 'AUTH');
  let s1 = C('syncClock', { atoken: ad }).data;
  eq('sync added', s1.added, ['光復新人（小辛辣）', '央廚新人（央廚）', '金山新人（墨竹亭）']);
  eq('sync adopted existing', s1.adopted, 1);    // 蔡明哲對應既有 S-009；陳大安 S-001 已在佈告欄刪除 → 不加回
  const s2 = C('syncClock', { atoken: ad }).data;
  eq('sync idempotent', [s2.added.length, s2.adopted], [0, 0]);
  eq('sync counts', s1.counts['央廚'], 2);
  M.setClockActive('CF09', false);
  eq('sync lists left', C('syncClock', { atoken: ad }).data.left.map(x => x.name), ['央廚新人']);
  const st = C('adminData', { atoken: ad }).data.staff;
  eq('left not auto-deleted', st.some(x => x.name === '央廚新人'), true);
  const del = st.find(x => x.name === '金山新人'); C('staffDelete', { atoken: ad, staffId: del.id });
  eq('deleted not re-added', C('syncClock', { atoken: ad }).data.added.includes('金山新人（墨竹亭）'), false);
  eq('roster has no src leak', Object.keys(C('roster').data[0]).includes('src'), false);
}
eq('unknown action', C('hack', {}).code, 'BAD_REQ');
eq('all 17 actions covered', seen.size, 17);

console.log(`service: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
