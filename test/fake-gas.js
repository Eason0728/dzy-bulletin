// 測試共用：假的 Google 服務（試算表／Drive／屬性／鎖／快取）＋把 gas/*.js 原封不動載進 vm＋本機 HTTP 假「Web App」包住 doPost。
// 做法沿用 test/bridge.test.js（M2），抽成工廠給 test/jobs.test.js（M3）端到端驗 mirror.js／daily.js 打過去的 op 格式。不連任何 Google。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http'), crypto = require('crypto');

function makeFakeGas() {
  const props = {}, cache = {};
  const st = { lockFree: true, throwOnWrite: null, hits: {}, failNext: null };   // failNext：下一次呼叫此 op 時 Web App 回 500 HTML（模擬 Google 當掉）
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
          if (st.throwOnWrite && sh.name === st.throwOnWrite) throw new Error('模擬逾時：' + sh.name);
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
  const sheets = [];
  const book = {
    sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet: (n, idx) => { if (sheets.some((s) => s.name === n)) throw new Error('分頁已存在'); const s = makeSheet(n); sheets.splice(idx === undefined ? sheets.length : idx, 0, s); return s; },
    deleteSheet: (s) => { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); }
  };
  const drive = { folders: { ROOT: { name: '我的雲端硬碟', parent: null, sharing: 'PRIVATE' } }, files: {}, seq: 0 };
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  function folderObj(id) {
    const f = drive.folders[id];
    return {
      getId: () => id, getName: () => f.name, isTrashed: () => !!f.trashed,
      getParents: () => iter(f.parent ? [folderObj(f.parent)] : []),
      createFolder: (name) => folderObj(newFolder(name, id)),
      createFile: (blob) => fileObj(newFile(blob, id)),
      getFiles: () => iter(Object.keys(drive.files).filter((k) => drive.files[k].parent === id && !drive.files[k].trashed).map(fileObj)),
      getSharingAccess: () => f.sharing, setSharing: (a) => { f.sharing = a; },
      getEditors: () => (f.editors || []), getViewers: () => []
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
    console: Object.assign({}, console, { error: () => {} }),
    DZYB: require('../js/logic.js'),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      getProperties: () => Object.assign({}, props), setProperties: (o) => { Object.keys(o).forEach((k) => { props[k] = String(o[k]); }); },
      deleteProperty: (k) => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null),
      getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; },
      put: (k, v) => { cache[k] = v; }, putAll: (o) => Object.assign(cache, o) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => st.lockFree, releaseLock: () => {} }) },
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
  vm.createContext(G);
  ['gas/Auth.js', 'gas/Service.js', 'gas/Store.js', 'gas/Files.js', 'gas/Code.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), G, { filename: f }));
  // 主試算表四分頁（與 setup() 相同表頭）
  ['posts', 'staff', 'reads', 'log'].forEach((k) => { const d = G.SHEETS_[k], s = book.insertSheet(d.name); s.data.push(d.head.slice()); });
  props.SPREADSHEET_ID = 'MAIN';

  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let op = ''; try { op = JSON.parse(b).op || ''; } catch (e) {}
      st.hits[op] = (st.hits[op] || 0) + 1;
      if (st.failNext && st.failNext === op) { st.failNext = null; res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<html>Google 暫時錯誤</html>'); }
      const out = G.doPost({ postData: { contents: b } }).getContent();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out);
    });
  });
  return {
    G, props, book, drive, st,
    store: () => vm.runInContext('makeStore_(makeFiles_())', G),
    sheetRows: (name) => book.getSheetByName(name).data.slice(1),
    listen: () => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok('http://127.0.0.1:' + srv.address().port + '/exec'))),
    close: () => new Promise((ok) => srv.close(() => ok()))
  };
}

module.exports = { makeFakeGas };
