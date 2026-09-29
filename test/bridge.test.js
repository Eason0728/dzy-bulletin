// node test/bridge.test.js — M2（#7）：Apps Script 改當 Google 橋接
// 用假的 Google 服務（試算表／Drive／屬性／鎖／快取）把 gas/*.js 原封不動載進 vm，再開一個本機 HTTP 假「Web App」包住 doPost，
// 讓 server/bridge.js（M1 客戶端）真的打過來：驗 op 名稱與參數格式對得上、每條驗收各有對應的檢查。不連任何 Google。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http'), os = require('os'), crypto = require('crypto');
const { makeBridge } = require('../server/bridge.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}

// ---------- 假 Google 服務 ----------
const props = {}, cache = {};
let lockFree = true, throwOnWrite = null;                       // throwOnWrite：寫到這個分頁名稱時丟錯（模擬 mirror 寫到一半逾時）
function makeSheet(name, maxRows) {
  const sh = { name, data: [], max: maxRows || 1000, frozen: 0 };
  const cell = (r, c) => ((sh.data[r - 1] || [])[c - 1] ?? '');
  sh.getName = () => sh.name; sh.setName = (n) => { sh.name = n; return sh; };
  sh.getLastRow = () => sh.data.length;
  sh.getMaxRows = () => sh.max;
  sh.insertRowsAfter = (after, n) => { sh.max += n; };
  sh.setFrozenRows = (n) => { sh.frozen = n; };
  sh.getRange = (r, c, nr = 1, nc = 1) => {
    if (r + nr - 1 > sh.max) throw new Error('範圍超出工作表');
    const rng = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      getValue: () => cell(r, c),
      setValues: (v) => {
        if (throwOnWrite && sh.name === throwOnWrite) throw new Error('模擬逾時：' + sh.name);
        v.forEach((row, i) => { const R = r + i - 1; sh.data[R] = sh.data[R] || []; row.forEach((x, j) => { sh.data[R][c + j - 1] = x; }); });
        return rng;
      },
      clearContent: () => { for (let i = r - 1; i < r - 1 + nr; i++) sh.data[i] = []; while (sh.data.length && !sh.data[sh.data.length - 1].length) sh.data.pop(); return rng; },
      setNumberFormat: () => rng, setFontWeight: () => rng
    };
    return rng;
  };
  return sh;
}
let book;
function freshBook() {
  const sheets = [];
  book = {
    sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet: (n, idx) => { if (sheets.some((s) => s.name === n)) throw new Error('分頁已存在'); const s = makeSheet(n); sheets.splice(idx === undefined ? sheets.length : idx, 0, s); return s; },
    deleteSheet: (s) => { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); }
  };
}
// Drive：資料夾與檔案
const drive = { folders: {}, files: {}, seq: 0 };
const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
function folderObj(id) {
  const f = drive.folders[id];
  return {
    getId: () => id, getName: () => f.name, isTrashed: () => !!f.trashed,
    getParents: () => iter(f.parent ? [folderObj(f.parent)] : []),
    createFolder: (name) => folderObj(newFolder(name, id)),
    createFile: (blob) => fileObj(newFile(blob, id)),
    getFiles: () => iter(Object.keys(drive.files).filter((k) => drive.files[k].parent === id && !drive.files[k].trashed).map(fileObj)),
    getSharingAccess: () => f.sharing, setSharing: (a) => { f.sharing = a; }
  };
}
function newFolder(name, parent) { const id = 'D' + (++drive.seq); drive.folders[id] = { name, parent, sharing: 'PRIVATE' }; return id; }
function newFile(blob, parent) { const id = 'G' + (++drive.seq); drive.files[id] = { name: blob.name, mime: blob.mime, bytes: blob.bytes, parent, sharing: 'PRIVATE', created: Date.now() }; return id; }
function fileObj(id) {
  const f = drive.files[id]; if (!f) throw new Error('找不到檔案');
  return {
    getId: () => id, getName: () => f.name, getMimeType: () => f.mime, getSize: () => f.bytes.length,
    getParents: () => iter([folderObj(f.parent)]), getDateCreated: () => new Date(f.created),
    getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes }),
    getSharingAccess: () => f.sharing, setSharing: (a) => { f.sharing = a; }, setTrashed: (t) => { f.trashed = t; }, isTrashed: () => !!f.trashed
  };
}
const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
const G = {
  console: Object.assign({}, console, { error: () => {} }),   // 預期中的錯誤（丟錯測試）不洗版
  DZYB: require('../js/logic.js'),
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
    getProperties: () => Object.assign({}, props), setProperties: (o) => { Object.keys(o).forEach((k) => { props[k] = String(o[k]); }); },
    deleteProperty: (k) => { delete props[k]; } }) },
  CacheService: { getScriptCache: () => ({
    get: (k) => (k in cache ? cache[k] : null),
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; },
    put: (k, v) => { cache[k] = v; }, putAll: (o) => Object.assign(cache, o) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock: () => {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  SpreadsheetApp: { openById: () => book, flush: () => {} },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' }, Permission: { VIEW: 'VIEW', NONE: 'NONE' },
    getFolderById: (id) => { if (!drive.folders[id]) throw new Error('找不到資料夾'); return folderObj(id); },
    createFolder: (name) => folderObj(newFolder(name, 'ROOT')),
    getFileById: (id) => fileObj(id), getRootFolder: () => folderObj('ROOT')
  },
  Drive: { Files: { update: () => {} }, About: { get: () => ({ storageQuota: { limit: '100', usage: '40' } }) } },
  Utilities: {
    sleep: () => {}, formatDate: () => '', getUuid: () => crypto.randomUUID(),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (a, s) => signed(crypto.createHash('sha256').update(s, 'utf8').digest()),
    computeHmacSha256Signature: (m, k) => signed(crypto.createHmac('sha256', k).update(m, 'utf8').digest()),
    base64EncodeWebSafe: (b) => Buffer.from(b.map((x) => x & 255)).toString('base64url'),
    base64Encode: (b) => Buffer.from(b.map((x) => x & 255)).toString('base64'),
    base64Decode: (s) => signed(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ bytes, mime, name })
  }
};
drive.folders.ROOT = { name: '我的雲端硬碟', parent: null, sharing: 'PRIVATE' };
vm.createContext(G);
['gas/Auth.js', 'gas/Service.js', 'gas/Store.js', 'gas/Files.js', 'gas/Code.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), G, { filename: f }));
const doPost = (body) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const store = () => vm.runInContext('makeStore_(makeFiles_())', G);

// 主試算表四分頁（與 setup() 相同表頭）＋一位同仁、一則公告
function seedBook() {
  freshBook();
  ['posts', 'staff', 'reads', 'log'].forEach((k) => { const d = G.SHEETS_[k], s = book.insertSheet(d.name); s.data.push(d.head.slice()); });
  const td = G.DZYB.today();
  book.getSheetByName('同仁').data.push(['S-001', '陳大安', 'mala', '', '', '0', '0', 'TRUE', '', '', '', '']);
  book.getSheetByName('公告').data.push(['P-1', '測試公告', '內容', 'mala', G.DZYB.addDays(td, -1), '', 'FALSE', 'TRUE', '', '[]', '', '']);
}
seedBook();
const KEY = 'k'.repeat(40);
Object.assign(props, { SPREADSHEET_ID: 'MAIN', TOKEN_SECRET: 'secret-xyz', ADMIN_HASH: 'ahash', ADMIN_SALT: 'asalt', ADMIN_VER: '3', BRIDGE_KEY: KEY });

// ---------- 本機假 Web App：把 HTTP POST 丟給 doPost（算呼叫次數） ----------
let hits = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { hits++; const out = G.doPost({ postData: { contents: b } }).getContent(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out); });
});

(async () => {
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const URL0 = 'http://127.0.0.1:' + srv.address().port + '/exec';
  const B = makeBridge(URL0, KEY);
  const raw = async (body) => JSON.parse(await (await fetch(URL0, { method: 'POST', body: JSON.stringify(body) })).text());
  const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code + '|' + (/ (AUTH|BAD_REQ|SERVER|MOVED) /.exec(e.detail + ' ') || [])[1]; } };

  // ===== 驗收 1：金鑰缺／短於 32／錯誤一律 AUTH；op 未知回 BAD_REQ =====
  eq('金鑰缺 → AUTH', (await raw({ action: 'bridge', op: 'quota' })).code, 'AUTH');
  eq('金鑰錯 → AUTH', (await raw({ action: 'bridge', key: 'x'.repeat(40), op: 'quota' })).code, 'AUTH');
  eq('金鑰長度對但差一字 → AUTH', (await raw({ action: 'bridge', key: KEY.slice(0, -1) + 'j', op: 'quota' })).code, 'AUTH');
  props.BRIDGE_KEY = 's'.repeat(31);
  eq('指令碼屬性 BRIDGE_KEY 短於 32 → 就算送一樣的也 AUTH', (await raw({ action: 'bridge', key: 's'.repeat(31), op: 'quota' })).code, 'AUTH');
  delete props.BRIDGE_KEY;
  eq('指令碼屬性沒設 BRIDGE_KEY → AUTH（空字串也不行）', (await raw({ action: 'bridge', key: '', op: 'quota' })).code, 'AUTH');
  props.BRIDGE_KEY = KEY;
  eq('AUTH 訊息不透露是哪一種錯', (await raw({ action: 'bridge', op: 'quota' })).message, '橋接金鑰錯誤');
  eq('未知 op → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'nope' })).code, 'BAD_REQ');
  eq('金鑰錯時連 op 未知也只回 AUTH（先驗金鑰）', (await raw({ action: 'bridge', key: 'bad', op: 'nope' })).code, 'AUTH');
  eq('bridge.js 客戶端：quota 通', await B.files.quota(), { limit: 100, usage: 40 });
  eq('bridge.js 客戶端：金鑰錯 → 伺服器自己的 BRIDGE 碼（不原樣回 AUTH）', await codeOf(makeBridge(URL0, 'z'.repeat(40)).files.quota()), 'BRIDGE|AUTH');

  // ===== 驗收 2：PRIMARY=mini 時 ack 回 MOVED、board 照常；PRIMARY=gas 時照舊 =====
  props.PRIMARY = 'gas';
  let r = doPost({ action: 'setPin', staffId: 'S-001', pin: '2580' });
  eq('PRIMARY=gas：setPin 照常', r.ok, true);
  const tok = r.data.token;
  eq('PRIMARY=gas：board 照常', doPost({ action: 'board', token: tok }).ok, true);
  props.PRIMARY = 'mini';
  const readsBefore = book.getSheetByName('已讀').data.length;
  r = doPost({ action: 'ack', token: tok, postId: 'P-1', sig: 'data:image/png;base64,AAAA' });
  eq('PRIMARY=mini：ack → MOVED＋固定訊息', [r.ok, r.code, r.message], [false, 'MOVED', '系統已搬家，請重新整理']);
  eq('PRIMARY=mini：ack 沒寫進已讀', book.getSheetByName('已讀').data.length, readsBefore);
  r = doPost({ action: 'board', token: tok });
  eq('PRIMARY=mini：board 照常（讀得到公告）', [r.ok, r.data.posts.map((p) => p.id)], [true, ['P-1']]);
  eq('PRIMARY=mini：roster／history 照常', [doPost({ action: 'roster' }).ok, doPost({ action: 'history', token: tok }).ok], [true, true]);
  const W = vm.runInContext('WRITE_ACTIONS_', G);
  eq('PRIMARY=mini：12 個寫入動作全部 MOVED（含 uploadFile）', W.concat(['uploadFile']).map((a) => doPost({ action: a }).code), W.concat(['uploadFile']).map(() => 'MOVED'));
  props.PRIMARY = 'gas';
  r = doPost({ action: 'ack', token: tok, postId: 'P-1', sig: 'data:image/png;base64,AAAA' });
  eq('PRIMARY=gas：ack 照常寫入', [r.ok, book.getSheetByName('已讀').data.length], [true, readsBefore + 1]);
  delete props.PRIMARY;
  eq('PRIMARY 未設定＝gas（寫入照常）', doPost({ action: 'login', staffId: 'S-001', pin: '2580' }).ok, true);

  // ===== 驗收 4：sigs 批次上傳 15 張只產生 1 次橋接呼叫，回傳 15 個 Drive id =====
  const png = 'data:image/png;base64,' + Buffer.from('簽名圖').toString('base64');
  const items = Array.from({ length: 15 }, (_, i) => ({ name: 'P-1_S-' + String(i).padStart(3, '0'), data: png }));
  hits = 0;
  const up = await B.call('sigs', { put: items });
  const sigFolder = props.SIG_FOLDER_ID;
  eq('sigs put 15 張：1 次橋接呼叫', hits, 1);
  eq('sigs put 15 張：回 15 個 Drive id、都在簽名資料夾、檔名對應', [up.ids.length, new Set(up.ids).size, up.ids.every((id) => drive.files[id] && drive.files[id].parent === sigFolder),
    up.ids.map((id) => drive.files[id].name)], [15, 15, true, items.map((x) => x.name + '.png')]);
  hits = 0;
  const got = await B.call('sigs', { get: up.ids.slice(0, 3).concat(['G-nope']) });
  eq('sigs get：1 次呼叫、讀回 data URL、讀不到的給 null', [hits, got.sigs[up.ids[0]], got.sigs['G-nope']], [1, png, null]);
  eq('sigs 超過 20 張 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'sigs', put: items.concat(items) })).code, 'BAD_REQ');
  eq('sigs put／get 都沒給或都給 → BAD_REQ', [(await raw({ action: 'bridge', key: KEY, op: 'sigs' })).code, (await raw({ action: 'bridge', key: KEY, op: 'sigs', put: items, get: [] })).code], ['BAD_REQ', 'BAD_REQ']);
  eq('sigs 內容不是圖 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'sigs', put: [{ name: 'x', data: 'hello' }] })).code, 'BAD_REQ');

  // ===== 驗收 5：PRIMARY≠mini 時 mirror 回 AUTH（實際經 HTTP 打一次） =====
  const snapshot = () => JSON.stringify(['公告', '同仁', '已讀', '操作紀錄'].map((n) => book.getSheetByName(n).data));
  const sheetsBefore = snapshot();
  const mirrorData = { posts: [], staff: [], reads: [], log: [] };
  props.PRIMARY = 'gas';
  eq('PRIMARY=gas：mirror → AUTH（raw）', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: mirrorData })).code, 'AUTH');
  eq('PRIMARY=gas：mirror → bridge.js 拿到 BRIDGE（AUTH 在 detail）', await codeOf(B.call('mirror', { data: mirrorData })), 'BRIDGE|AUTH');
  delete props.PRIMARY;
  eq('PRIMARY 未設定：mirror → AUTH', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: mirrorData })).code, 'AUTH');
  eq('mirror 被拒後四分頁沒動', snapshot(), sheetsBefore);

  // ===== 驗收 6、7：export 守門與內容 =====
  props.PRIMARY = 'mini';
  eq('export：EXPORT_ONCE 缺席 → AUTH', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');
  props.EXPORT_ONCE = '1'; props.PRIMARY = 'gas';
  eq('export：PRIMARY=gas 即使有 EXPORT_ONCE 也 AUTH', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');
  props.PRIMARY = 'mini'; props.EXPORT_ONCE = 'true';
  eq('export：EXPORT_ONCE 不是 1 → AUTH', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');
  props.EXPORT_ONCE = '1';
  lockFree = false;
  eq('export：拿不到 ScriptLock → SERVER 忙碌、EXPORT_ONCE 保留', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['SERVER', '1']);
  lockFree = true;
  const adminHash = props.ADMIN_HASH; delete props.ADMIN_HASH;
  eq('export：缺 ADMIN_HASH → 拒絕、EXPORT_ONCE 保留', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['SERVER', '1']);
  props.ADMIN_HASH = adminHash; const sec = props.TOKEN_SECRET; delete props.TOKEN_SECRET;
  eq('export：缺 TOKEN_SECRET → 拒絕、EXPORT_ONCE 保留', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['SERVER', '1']);
  props.TOKEN_SECRET = sec;
  // fresh：先讓快取存著舊的同仁表，再直接改試算表（不換世代）→ export 必須讀到試算表現況
  store().getStaff();
  book.getSheetByName('同仁').data.push(['S-002', '林雅婷', 'mala', '', '', '0', '0', 'TRUE', '', '', '', '']);
  book.getSheetByName('操作紀錄').data.push(['2026-09-30T01:00:00.000Z', 'savePost', 'P-1', '新增']);
  eq('（前提）一般讀取吃快取、看不到手動加的 S-002', store().getStaff().map((s) => s.id), ['S-001']);
  hits = 0;
  const ex = await B.call('export', {});
  eq('export 成功：1 次呼叫，EXPORT_ONCE 已刪', [hits, 'EXPORT_ONCE' in props], [1, false]);
  eq('export 內含 secret 與 admin.hash（與指令碼屬性一致）', [ex.secret, ex.admin.hash, ex.admin.salt, ex.admin.ver], ['secret-xyz', 'ahash', 'asalt', 3]);
  eq('export fresh 讀取：看得到快取外的 S-002', ex.staff.map((s) => s.id), ['S-001', 'S-002']);
  eq('export 帶出公告／已讀（簽名檔 id＝Drive id）／操作紀錄', [ex.posts.map((p) => p.id), ex.reads.length, !!drive.files[ex.reads[0].sigId], ex.log], [['P-1'], 1, true, [{ at: '2026-09-30T01:00:00.000Z', action: 'savePost', target: 'P-1', summary: '新增' }]]);
  eq('export 第二次 → AUTH（一次性）', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');

  // ===== 驗收 8：mirror 後試算表與 Mac mini 逐筆一致（含已讀簽名檔 id＝Drive id） =====
  // 用 M1 的 SQLite store 當「Mac mini 正本」：塞資料 → dump() → 模擬 M3 回填 driveSigId → 經 bridge.js 鏡像 → 用 GAS store 讀回比對
  const { makeSqliteStore } = require('../server/store-sqlite.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-m2-'));
  const mini = makeSqliteStore(dir);
  const demo = require('../js/demo-data.js')(G.DZYB);
  const staffIn = demo.staff.map((s, i) => ({ id: s.id, name: s.name, unit: s.unit, pinHash: s.pin ? 'h' + i : '', salt: s.pin ? 's' + i : '', pinVer: s.pin ? 1 : 0,
    fail: 0, active: i !== 3, createdAt: '2026-09-29T00:00:00.000Z', deletedAt: i === 3 ? '2026-09-30T00:00:00.000Z' : '', src: '', store: s.store }));
  const readsIn = demo.posts.slice(0, 3).flatMap((p, i) => staffIn.slice(0, 4).map((s, j) => ({ postId: p.id, staffId: s.id, name: s.name, unit: s.unit, at: '2026-09-30T0' + i + ':0' + j + ':00.000Z', sigId: p.id + '_' + s.id + '.png' })));
  mini.load({ posts: demo.posts.map((p) => Object.assign({ createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '' }, p)), staff: staffIn, reads: readsIn,
    log: [{ at: '2026-09-30T01:00:00.000Z', action: 'ack', target: 'P-1', summary: '簽名' }, { at: '2026-09-30T02:00:00.000Z', action: 'savePost', target: 'P-2', summary: '' }] });
  const dump = mini.dump(); mini.close();
  dump.reads.forEach((x, i) => { x.driveSigId = i % 5 === 4 ? '' : 'DRV-' + i; });   // 每 5 筆留 1 筆「還沒回填」
  props.PRIMARY = 'mini';
  hits = 0;
  const mres = await B.call('mirror', { data: { posts: dump.posts, staff: dump.staff, reads: dump.reads, log: dump.log } });
  eq('mirror：1 次呼叫、回報四分頁筆數', [hits, mres.counts], [1, { posts: dump.posts.length, staff: dump.staff.length, reads: dump.reads.length, log: dump.log.length }]);
  const S2 = store();
  const pick = (o, ks) => ks.reduce((a, k) => (a[k] = o[k], a), {});
  const PK = ['id', 'title', 'body', 'units', 'publishOn', 'expiresOn', 'pinned', 'published', 'offOn', 'files', 'createdAt', 'updatedAt'];
  eq('mirror 後公告逐筆一致', S2.getPosts().map((p) => pick(p, PK)), dump.posts.map((p) => pick(Object.assign({ expiresOn: '', offOn: '' }, p, { units: G.DZYB.normUnits(p.units) }), PK)));
  const SK = ['id', 'name', 'unit', 'pinHash', 'salt', 'pinVer', 'fail', 'active', 'createdAt', 'deletedAt', 'src', 'store'];
  eq('mirror 後同仁逐筆一致（含停用者、雜湊）', S2.getStaff().map((s) => pick(s, SK)), dump.staff.map((s) => pick(s, SK)));
  eq('mirror 後已讀逐筆一致，簽名檔 id＝driveSigId（Drive id），沒回填的留空、不寫 Mac mini 檔名',
    S2.getReads(), dump.reads.map((x) => ({ postId: x.postId, staffId: x.staffId, name: x.name, unit: x.unit, at: x.at, sigId: x.driveSigId })));
  eq('（確認資料含未回填列）', dump.reads.some((x) => !x.driveSigId) && dump.reads.some((x) => x.driveSigId), true);
  eq('mirror 後操作紀錄逐筆一致', S2.dump().log, dump.log);
  eq('mirror 後分頁順序與名稱不變、沒有殘留暫存分頁', book.getSheets().map((s) => s.name), ['公告', '同仁', '已讀', '操作紀錄']);
  eq('mirror 後分頁凍結表頭', book.getSheets().map((s) => s.frozen), [1, 1, 1, 1]);
  eq('mirror 換世代（快取失效）', !!props.DATA_GEN, true);

  // mirror 寫到一半丟錯（已讀寫完、寫操作紀錄時逾時）→ 正式四分頁仍是上一輪的完整資料；下一輪成功並清掉殘留暫存分頁
  const good = snapshot();
  const d2 = JSON.parse(JSON.stringify({ posts: dump.posts, staff: dump.staff, reads: dump.reads.slice(0, 2), log: [] }));
  throwOnWrite = '操作紀錄__鏡像中';
  eq('mirror 中途丟錯 → 回錯誤', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok, false);
  eq('mirror 中途丟錯 → 正式四分頁仍是上一輪完整資料', snapshot(), good);
  eq('（殘留暫存分頁存在，正式分頁不受影響）', book.getSheets().some((s) => s.name === '已讀__鏡像中'), true);
  throwOnWrite = null;
  eq('下一輪 mirror 成功', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok, true);
  eq('下一輪清掉殘留暫存分頁、已讀換成新資料', [book.getSheets().map((s) => s.name), book.getSheetByName('已讀').data.length], [['公告', '同仁', '已讀', '操作紀錄'], 3]);
  eq('mirror 缺任一份（例如沒帶 reads）→ BAD_REQ、正式分頁不被清空', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: { posts: [], staff: [], log: [] } })).code, book.getSheetByName('已讀').data.length], ['BAD_REQ', 3]);
  lockFree = false;
  eq('mirror 拿不到 ScriptLock → SERVER 忙碌', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).code, 'SERVER');
  lockFree = true;
  // 鏡像後回退（PRIMARY=gas）：GAS 的 readSig 讀得到鏡像寫回的 Drive id（用上面 sigs 上傳得到的真 id）
  await B.call('mirror', { data: { posts: dump.posts, staff: dump.staff, reads: [Object.assign({}, dump.reads[0], { driveSigId: up.ids[0] })], log: [] } });
  props.PRIMARY = 'gas';
  eq('回退後 GAS 用鏡像的簽名檔 id 讀得到簽名圖', Object.values(store().getSigs(dump.reads[0].postId)), [png]);

  // ===== 驗收 9：備份檔落在獨立備份資料夾、分享狀態為「限制」 =====
  const b64 = Buffer.from('gzip-bytes').toString('base64');
  props.BACKUP_FOLDER_ID = vm.runInContext('attachFolder_()', G).createFolder('備份').getId();   // 模擬舊草稿：備份資料夾在附件資料夾底下
  drive.folders[props.BACKUP_FOLDER_ID].sharing = 'ANYONE_WITH_LINK';
  const oldFolder = props.BACKUP_FOLDER_ID;
  const bk = await B.call('backup', { name: 'dzyb-2026-09-30.db.gz', data: b64 });
  const bf = drive.files[bk.id], bfo = drive.folders[bf.parent];
  eq('備份：不在附件資料夾底下，改建在雲端硬碟根目錄的獨立資料夾', [bf.parent !== oldFolder, bfo.parent, bfo.name, props.BACKUP_FOLDER_ID === bf.parent], [true, 'ROOT', '鼎兆元｜電子佈告欄備份', true]);
  eq('備份：檔案與資料夾分享狀態都是「限制」', [bf.sharing, bfo.sharing], ['PRIVATE', 'PRIVATE']);
  eq('備份：內容與檔名', [Buffer.from(bf.bytes.map((x) => x & 255)).toString(), bf.name, bf.mime], ['gzip-bytes', 'dzyb-2026-09-30.db.gz', 'application/gzip']);
  drive.folders[bf.parent].sharing = 'ANYONE_WITH_LINK';          // 有人把備份資料夾分享出去 → 下次備份時收回
  const oldId = newFile({ name: 'old.gz', mime: 'application/gzip', bytes: [1] }, bf.parent); drive.files[oldId].created = Date.now() - 31 * 86400e3;
  const bk2 = await B.call('backup', { name: '../../evil name.gz', data: b64 });
  eq('備份：資料夾被分享出去時收回成「限制」、超過 30 天的舊檔丟垃圾桶', [drive.folders[bf.parent].sharing, drive.files[oldId].trashed, bk2.trashed], ['PRIVATE', true, 1]);
  eq('備份：檔名去掉路徑字元', drive.files[bk2.id].name, '.._.._evil_name.gz');
  eq('備份：空內容 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'backup', name: 'x.gz', data: '' })).code, 'BAD_REQ');

  // ===== 其他 op 與 bridge.js 格式對齊（upload／share／revoke／clock／sig） =====
  const pdf = Buffer.from('%PDF-1.4').toString('base64');
  const u = await B.files.upload('a.pdf', 'application/pdf', pdf);
  eq('upload：回 {id,name,type,size}、放在附件資料夾', [u.name, u.type, drive.files[u.id].parent === props.FOLDER_ID], ['a.pdf', 'pdf', true]);
  await B.files.share([u.id]);
  eq('share：附件改成知道連結者可看', drive.files[u.id].sharing, 'ANYONE_WITH_LINK');
  await B.files.revoke([u.id]);
  eq('revoke：收回分享並丟垃圾桶', [drive.files[u.id].sharing, drive.files[u.id].trashed], ['PRIVATE', true]);
  eq('share 簽名圖（不是附件）→ BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'share', ids: [up.ids[0]] })).code, 'BAD_REQ');
  eq('clock：沒設打卡來源時回空名單＋提示', (await B.clockSrc.read()).errors, ['未設定打卡來源']);
  eq('sig：單張讀回', await B.call('sig', { id: up.ids[1] }), png);

  // ===== 純函式：movedGate_ =====
  const gate = vm.runInContext('movedGate_', G);
  eq('movedGate_：只在 mini 擋寫入', [gate('ack', 'mini') && gate('ack', 'mini').code, gate('board', 'mini'), gate('ack', 'gas'), gate('ack', null), gate('ack', 'MINI')], ['MOVED', null, null, null, null]);

  srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(`bridge: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('✗ 執行中斷', e); process.exit(1); });
