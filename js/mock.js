/* 鼎兆元｜電子佈告欄 — 本機假後端（?mode=local）
 * 與正式後端共用 gas/Service.js，只把資料放在 localStorage（dzyb_mock_db）。
 * 加密用假的雜湊，只為了讓流程跑得起來，不具安全性。 */
'use strict';

var DZYB_MOCK = (function () {
  var G = typeof window !== 'undefined' ? window : global;
  var L = G.DZYB, KEY = 'dzyb_mock_db';
  var BLOBS = {};                                   // 本機上傳的檔案內容（重新整理就消失）

  function fakeHex(s, len) {                        // FNV-1a 疊代，湊出固定長度的 hex
    var out = '', h = 2166136261, i, k = 0;
    while (out.length < len) {
      for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      h ^= k++; out += ('00000000' + h.toString(16)).slice(-8);
    }
    return out.slice(0, len);
  }
  var fakeCrypto = {
    sha256Hex: function (s) { return fakeHex(s, 64); },
    hmacB64url: function (k, m) { return fakeHex(k + '|' + m, 43); },
    randomHex: function (n) { var s = ''; while (s.length < n * 2) s += Math.floor(Math.random() * 16).toString(16); return s; }
  };
  var auth = G.makeAuth_(fakeCrypto, L);

  function seed() {
    var T = L.today(), A = L.addDays;
    var salt = 'seed';
    var staff = [
      ['S-001', '陳大安', 'mala'], ['S-002', '林雅婷', 'mala'], ['S-003', '黃俊宇', 'mala'], ['S-004', '張詩涵', 'mala'],
      ['S-005', '李志豪', 'mzt'], ['S-006', '王淑芳', 'mzt'], ['S-007', '吳家翔', 'mzt'], ['S-008', '劉怡君', 'mzt'],
      ['S-009', '蔡明哲', 'cf'], ['S-010', '楊佩琪', 'cf'], ['S-011', '許文傑', 'cf'], ['S-012', '鄭宜萱', 'cf'],
      ['S-013', '測試員甲', 'mala'], ['S-014', '測試員乙', 'mzt'], ['S-015', '測試員丙', 'cf'],
      ['S-016', '周總經理', 'hq-dzy'], ['S-017', '孫品牌經理', 'hq-mzt'], ['S-018', '趙營運督導', 'hq-mala']
    ].map(function (r) {
      var test = r[1].indexOf('測試員') === 0;
      return { id: r[0], name: r[1], unit: r[2], salt: test ? '' : salt, pinHash: test ? '' : auth.hashPin(salt, '0000'),
        pinVer: 1, fail: 0, active: true, createdAt: '2026-09-01T00:00:00.000Z', deletedAt: '' };
    });
    var F = function (id, name, mb) { return { id: id, name: name, type: L.fileType(name), size: Math.round(mb * 1048576) }; };
    var P = function (o) {
      return Object.assign({ published: true, offOn: '', expiresOn: '', pinned: false, files: [], body: '',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }, o);
    };
    var all = ['mzt', 'mala', 'cf'];
    var posts = [
      P({ id: 'P-20260925-001', title: '10 月份排班提醒與請假流程調整', units: all, pinned: true, publishOn: A(T, -4), expiresOn: A(T, 32),
        body: '各位同仁好：\n\n1. 10 月班表已上傳，請於本週五前確認。\n2. 自 10/1 起，請假需提前 3 天於打卡系統申請，臨時請假請直接電話告知店長。\n3. 附件為新版請假流程與 10 月假日對照表。\n\n如有疑問請洽各單位主管。',
        files: [F('demo-1', '請假流程說明_v2.pdf', 1.2), F('demo-2', '2026年10月假日對照表.xlsx', 0.3)] }),
      P({ id: 'P-20260920-001', title: '【新品】藤椒雞上市作業 SOP', units: ['mala'], publishOn: A(T, -9), expiresOn: A(T, 21),
        body: '藤椒雞 10/1 三店同步上市。\n請全員於上市前詳讀附件 SOP，重點：\n・醃料比例與靜置時間\n・出餐份量 180g\n・過敏原標示（含花椒）',
        files: [F('demo-3', '藤椒雞_SOP.docx', 2.4), F('demo-4', '藤椒雞_出餐照片.pdf', 6.8)] }),
      P({ id: 'P-20260915-001', title: '燃麵醬料配方更新（第 3 版）', units: ['mzt'], publishOn: A(T, -14),
        body: '即日起燃麵醬料改用第 3 版配方，舊版請勿再使用。', files: [F('demo-5', '燃麵醬料配方_v3.pdf', 0.8)] }),
      P({ id: 'P-20260927-001', title: '冷凍庫盤點時間調整為每週二', units: ['cf'], publishOn: A(T, -2), expiresOn: A(T, 11),
        body: '自下週起冷凍庫盤點由每週一改為每週二 14:00，請當班同仁配合。' }),
      P({ id: 'P-20260910-001', title: '颱風季應變通報流程', units: all, pinned: true, publishOn: A(T, -19), expiresOn: A(T, 1),
        body: '颱風警報發布時：\n1. 店長於 LINE 群組回報營業狀態\n2. 停止營業須經品牌主管同意\n3. 同仁安全優先', files: [F('demo-6', '颱風應變流程圖.pdf', 0.5)] }),
      P({ id: 'P-20260929-001', title: '中秋節金發放說明', units: all, publishOn: A(T, 2), expiresOn: A(T, 16), body: '中秋節金將隨 10 月薪資發放。' }),
      P({ id: 'P-20260801-001', title: '8 月起勞健保費率調整說明', units: all, publishOn: '2026-08-01', expiresOn: '2026-08-31',
        body: '8 月起勞健保費率調整，薪資單將同步更新。', files: [F('demo-7', '勞健保費率對照.xlsx', 0.2)] }),
      P({ id: 'P-20260720-001', title: '暑期限定活動結束通知', units: ['mala'], publishOn: '2026-07-20', expiresOn: '2026-08-15', body: '暑期限定套餐於 8/15 結束販售。' }),
      P({ id: 'P-20260701-001', title: '七月消防演練時間表', units: ['mzt'], publishOn: '2026-07-01', expiresOn: '2026-07-20', body: '各店消防演練時間如附件。',
        files: [F('demo-8', '消防演練時間表.docx', 0.4)] }),
      P({ id: 'P-20260820-001', title: '舊版配送時刻表（已停用）', units: ['cf'], publishOn: '2026-08-20', published: false, offOn: '2026-09-05', body: '此版時刻表已由新版取代。' })
    ];
    var R = function (p, s, at) { var st = staff.filter(function (x) { return x.id === s; })[0]; return { postId: p, staffId: s, name: st.name, unit: st.unit, at: at, sig: '' }; };
    var reads = [
      R('P-20260925-001', 'S-001', '2026-09-26T02:12:00.000Z'), R('P-20260925-001', 'S-005', '2026-09-25T10:02:00.000Z'),
      R('P-20260925-001', 'S-009', '2026-09-27T01:30:00.000Z'), R('P-20260920-001', 'S-001', '2026-09-21T02:00:00.000Z'),
      R('P-20260915-001', 'S-005', '2026-09-16T04:00:00.000Z'), R('P-20260915-001', 'S-006', '2026-09-16T04:30:00.000Z'),
      R('P-20260910-001', 'S-001', '2026-09-11T02:00:00.000Z'), R('P-20260801-001', 'S-001', '2026-08-02T02:00:00.000Z')
    ];
    return { posts: posts, staff: staff, reads: reads, log: [], admin: { hash: '', salt: '', init: '1234', ver: 1, fail: 0, lockUntil: 0 },
      secret: 'mock-secret', fileSeq: 0 };
  }

  var db = null, mem = null;
  function storage() { try { return G.localStorage || null; } catch (e) { return null; } }
  function load() {
    if (db) return db;
    var ls = storage();
    try { db = ls ? JSON.parse(ls.getItem(KEY)) : mem; } catch (e) { db = null; }
    if (!db) { db = seed(); save(); }
    return db;
  }
  function save() { var ls = storage(); try { if (ls) ls.setItem(KEY, JSON.stringify(db)); else mem = db; } catch (e) {} }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function upsert(list, obj) {
    var i = list.findIndex(function (x) { return x.id === obj.id; });
    if (i >= 0) list[i] = clone(obj); else list.push(clone(obj));
  }

  var store = {
    getPosts: function () { return clone(load().posts); },
    savePost: function (p) { upsert(load().posts, p); save(); },
    getStaff: function () { return clone(load().staff); },
    saveStaff: function (s) { upsert(load().staff, s); save(); },
    getReads: function () { return clone(load().reads); },
    addRead: function (r) { load().reads.push(clone(r)); save(); },
    addLog: function (e) { load().log.push(e); save(); },
    getAdmin: function () { return clone(load().admin); },
    setAdmin: function (a) { load().admin = clone(a); save(); },
    secret: function () { return load().secret; }
  };
  var files = {
    upload: function (name, mime, b64) {
      var d = load(), id = 'L-' + (++d.fileSeq); save();
      BLOBS[id] = 'data:' + mime + ';base64,' + b64;
      return { id: id, name: name, type: L.fileType(name), size: Math.floor(b64.length * 3 / 4) };
    },
    share: function () {}, revoke: function (ids) { ids.forEach(function (id) { delete BLOBS[id]; }); },
    quota: function () { return { limit: 16106127360, usage: 7935000000 }; }
  };
  var clock = { nowMs: function () { return Date.now(); }, today: function () { return L.today(); } };
  // 模擬打卡系統名單（小辛辣光復 gf／央廚 cf／墨竹亭金山 js）
  var CLOCK = [
    { src: 'gf', unit: 'mala', empId: 'A01', name: '陳大安', active: true },
    { src: 'gf', unit: 'mala', empId: 'A02', name: '光復新人', active: true },
    { src: 'gf', unit: 'mala', empId: 'A03', name: '已離職員工', active: false },
    { src: 'cf', unit: 'cf', empId: 'CF01', name: '蔡明哲', active: true },
    { src: 'cf', unit: 'cf', empId: 'CF09', name: '央廚新人', active: true },
    { src: 'js', unit: 'mzt', empId: 'J01', name: '金山新人', active: true }
  ];
  var clockSrc = { read: function () {
    return { rows: JSON.parse(JSON.stringify(CLOCK)), errors: [], sources: ['gf', 'cf', 'js'],
      counts: { '小辛辣光復店': CLOCK.filter(function (r) { return r.src === 'gf' && r.active; }).length, '央廚': CLOCK.filter(function (r) { return r.src === 'cf' && r.active; }).length, '墨竹亭金山店': CLOCK.filter(function (r) { return r.src === 'js' && r.active; }).length } };
  } };
  var svc = G.makeService_(L, store, files, auth, clock, clockSrc);

  return {
    call: function (action, req) {
      var res = svc.call(action, clone(req || {}));
      return new Promise(function (ok) { setTimeout(function () { ok(res); }, 120); });   // 模擬網路延遲
    },
    callSync: function (action, req) { return svc.call(action, clone(req || {})); },
    blobOf: function (id) { return BLOBS[id] || null; },
    setClockActive: function (empId, on) { CLOCK.forEach(function (r) { if (r.empId === empId) r.active = on; }); },   // 測試用
    reset: function () { db = seed(); save(); },
    testerReset: function () {                       // 預覽用：清掉測試員的密碼與簽名
      var d = load();
      d.staff.forEach(function (s) { if (s.name.indexOf('測試員') === 0) { s.pinHash = ''; s.salt = ''; s.pinVer++; s.fail = 0; } });
      var ids = d.staff.filter(function (s) { return s.name.indexOf('測試員') === 0; }).map(function (s) { return s.id; });
      d.reads = d.reads.filter(function (r) { return ids.indexOf(r.staffId) < 0; });
      save();
    }
  };
})();

if (typeof module !== 'undefined') module.exports = DZYB_MOCK;
