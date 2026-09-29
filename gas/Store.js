/* 鼎兆元｜電子佈告欄 — 試算表讀寫（Service.js 的 store 介面）
 * 四個分頁全部設成純文字格式（setup 時），避免日期被 Sheets 自動轉型；讀取時仍防呆轉回字串。 */
'use strict';

var SHEETS_ = {
  posts: { name: '公告', cols: ['id', 'title', 'body', 'units', 'publishOn', 'expiresOn', 'pinned', 'published', 'offOn', 'files', 'createdAt', 'updatedAt'],
    head: ['id', '標題', '內容', '單位', '上架日', '到期日', '置頂', '上架中', '手動下架日', '附件', '建立時間', '最後修改時間'] },
  staff: { name: '同仁', cols: ['id', 'name', 'unit', 'pinHash', 'salt', 'pinVer', 'fail', 'active', 'createdAt', 'deletedAt', 'src', 'store'],
    head: ['id', '姓名', '單位', '密碼雜湊', 'salt', '密碼版本', '連續錯誤次數', '在職', '建立時間', '刪除時間', '來源（打卡系統）', '門市'] },
  // 名單快照欄位定義（寫在獨立的公開名單試算表，見 snapBook_；setup 不在主試算表建這個分頁）
  snap: { name: '名單快照', cols: ['id', 'name', 'unit', 'store', 'hasPin', 'locked'], head: ['id', 'name', 'unit', 'store', 'hasPin', 'locked'] },
  reads: { name: '已讀', cols: ['postId', 'staffId', 'name', 'unit', 'at', 'sigId'],
    head: ['公告 id', '同仁 id', '姓名', '單位', '簽名時間', '簽名檔 id'] },
  log: { name: '操作紀錄', cols: ['at', 'action', 'target', 'summary'], head: ['時間', '動作', '對象', '摘要'] }
};

function props_() { return PropertiesService.getScriptProperties(); }
function ss_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('尚未執行 setup()');
  return SpreadsheetApp.openById(id);
}
function cellStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

/* 讀取快取：Apps Script 冷啟動＋開試算表常要數秒。資料讀過就放 CacheService，
 * 鍵名帶「資料世代」DATA_GEN，任何寫入就把世代 +1，舊快取自然失效（不會讀到過期資料）。 */
var CACHE_TTL_ = 600, CACHE_CHUNK_ = 30000;   // CacheService 單值上限 100KB 以位元組計，中文一字 3 bytes
function dataGen_() { return props_().getProperty('DATA_GEN') || '0'; }
function bumpGen_() {
  var v = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  try { props_().setProperty('DATA_GEN', v); } catch (e) { Utilities.sleep(200); props_().setProperty('DATA_GEN', v); }   // 失敗重試一次
}
function cacheGet_(key) {
  try {
    var c = CacheService.getScriptCache(), head = c.get(key + ':n');
    if (!head) return null;
    var n = Number(head), keys = [];
    for (var i = 0; i < n; i++) keys.push(key + ':' + i);
    var parts = c.getAll(keys), s = '';
    for (var j = 0; j < n; j++) { if (parts[key + ':' + j] == null) return null; s += parts[key + ':' + j]; }
    return JSON.parse(s);
  } catch (e) { return null; }
}
function cachePut_(key, obj) {
  try {
    var s = JSON.stringify(obj), o = {}, n = Math.ceil(s.length / CACHE_CHUNK_) || 1;
    if (n > 50) return;                                     // 太大就不快取（CacheService 單次上限）
    for (var i = 0; i < n; i++) o[key + ':' + i] = s.slice(i * CACHE_CHUNK_, (i + 1) * CACHE_CHUNK_);
    o[key + ':n'] = String(n);
    CacheService.getScriptCache().putAll(o, CACHE_TTL_);
  } catch (e) {}
}

// 名單快照：放在**獨立的試算表**「鼎兆元｜電子佈告欄｜公開名單」（只有公開欄位），發布到網路整份也不會外洩密碼資料。
// 絕不可寫進主試算表（主試算表有密碼雜湊與 salt，發布時選錯範圍就全外洩）。
function snapBook_() {
  var pr = props_(), id = pr.getProperty('SNAP_SS_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var bk = SpreadsheetApp.create('鼎兆元｜電子佈告欄｜公開名單');
  pr.setProperty('SNAP_SS_ID', bk.getId());
  bk.getSheets()[0].setName(SHEETS_.snap.name);
  return bk;
}
function writeSnap_(staffRows) {
  var def = SHEETS_.snap, bk = snapBook_(), sh = bk.getSheetByName(def.name) || bk.insertSheet(def.name);
  var rows = [def.head].concat(staffRows.filter(function (r) { return r.id && bool_(r.active); }).map(function (r) {
    return [r.id, DZYB.maskName(r.name), r.unit, r.store || '', r.pinHash ? 'Y' : '', (Number(r.fail) || 0) >= DZYB.STAFF_MAX_FAIL ? 'Y' : ''];
  }));
  if (rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows() + 50);
  sh.getRange(1, 1, rows.length, def.cols.length).setNumberFormat('@').setValues(rows);           // 先覆寫再清尾端，不留空快照空窗
  var last = sh.getLastRow();
  if (last > rows.length) sh.getRange(rows.length + 1, 1, last - rows.length, def.cols.length).clearContent();
}

function makeStore_(files) {
  var book = null, memo = {}, gen = null, snapDirty = false;                              // gen 惰性讀取：寫入動作在鎖內才第一次讀
  function sheet(key) { if (!book) book = ss_(); return book.getSheetByName(SHEETS_[key].name); }
  function rows(key, fresh) {
    if (memo[key] && !fresh) return memo[key];
    if (gen === null) gen = dataGen_();
    var ck = 'rows:' + key + ':' + gen, hit = fresh ? null : cacheGet_(ck);
    if (hit) { memo[key] = hit; return hit; }
    var sh = sheet(key), n = sh.getLastRow() - 1, cols = SHEETS_[key].cols;
    var vals = n > 0 ? sh.getRange(2, 1, n, cols.length).getValues() : [];
    memo[key] = vals.map(function (r, i) {
      var o = { _row: i + 2 }; cols.forEach(function (c, j) { o[c] = cellStr_(r[j]); }); return o;
    });
    cachePut_(ck, memo[key]);
    return memo[key];
  }
  function write(key, obj, row) {
    var cols = SHEETS_[key].cols, sh = sheet(key);
    if (sh.getRange(1, cols.length).getValue() === '') {                 // 舊表補新欄表頭（例如同仁的「來源」欄）
      sh.getRange(1, 1, 1, cols.length).setValues([SHEETS_[key].head]).setFontWeight('bold');
      sh.getRange(1, cols.length, sh.getMaxRows(), 1).setNumberFormat('@');
    }
    var vals = [cols.map(function (c) { var v = obj[c]; return v === undefined || v === null ? '' : String(v); })];
    var target = row || sh.getLastRow() + 1;
    if (target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);   // 超過現有列數先加列（getRange 越界會丟例外）
    var r = sh.getRange(target, 1, 1, cols.length);
    r.setNumberFormat('@').setValues(vals);                           // 每列寫入前設純文字：超過 setup 當下的列數也不會把 ISO 時間轉成日期
    SpreadsheetApp.flush();                                          // 先落地再換世代、再放鎖，避免下一個寫入者算到同一列或快取到舊值
    if (key === 'log') return;
    // 就地更新本次請求的 memo（不整表重讀：批次同步數十人時才不會越來越慢）
    if (memo[key]) {
      var o = { _row: target }; cols.forEach(function (c, j) { o[c] = vals[0][j]; });
      var i = memo[key].findIndex(function (x) { return x._row === target; });
      if (i >= 0) memo[key][i] = o; else memo[key].push(o);
    }
    bumpGen_(); gen = dataGen_();                                    // 資料變了：快取世代換新
    if (memo[key]) cachePut_('rows:' + key + ':' + gen, memo[key]);
    if (key === 'staff') snapDirty = true;                          // 快照在請求結束時寫一次（批次同步不必每人重寫）
  }
  // 寫回既有列之前，確認那一列的 id 還是它（有人手動刪列／排序過試算表時，快取裡的列號會錯）；對不上就重讀試算表
  function upsert(key, obj) {
    var hit = rows(key).filter(function (r) { return r.id === obj.id; })[0];
    var sh0 = hit && sheet(key);
    if (hit && (hit._row > sh0.getLastRow() || String(sh0.getRange(hit._row, 1).getValue()) !== String(obj.id))) {   // 列號超出現有資料也視為過期
      hit = rows(key, true).filter(function (r) { return r.id === obj.id; })[0];
    }
    write(key, obj, hit ? hit._row : null);
  }

  function toPost(r) {
    var fl = []; try { fl = JSON.parse(r.files || '[]'); } catch (e) { fl = []; }
    return { id: r.id, title: r.title, body: r.body, units: DZYB.normUnits(r.units.split(',')), publishOn: r.publishOn,
      expiresOn: r.expiresOn, pinned: bool_(r.pinned), published: bool_(r.published), offOn: r.offOn, files: fl,
      createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  function fromPost(p) {
    return { id: p.id, title: p.title, body: p.body, units: (p.units || []).join(','), publishOn: p.publishOn, expiresOn: p.expiresOn || '',
      pinned: p.pinned ? 'TRUE' : 'FALSE', published: p.published ? 'TRUE' : 'FALSE', offOn: p.offOn || '',
      files: JSON.stringify(p.files || []), createdAt: p.createdAt || '', updatedAt: p.updatedAt || '' };
  }
  function toStaff(r) {
    return { id: r.id, name: r.name, unit: r.unit, pinHash: r.pinHash, salt: r.salt, pinVer: Number(r.pinVer) || 0,
      fail: Number(r.fail) || 0, active: bool_(r.active), createdAt: r.createdAt, deletedAt: r.deletedAt, src: r.src || '', store: r.store || '' };
  }

  return {
    getPosts: function () { return rows('posts').filter(function (r) { return r.id; }).map(toPost); },
    savePost: function (p) { upsert('posts', fromPost(p)); },
    getStaff: function () { return rows('staff').filter(function (r) { return r.id; }).map(toStaff); },
    saveStaff: function (s) {
      var o = Object.assign({}, s); o.active = s.active ? 'TRUE' : 'FALSE'; upsert('staff', o);
    },
    // 已讀：簽名圖存 Drive，試算表只存檔案 id（簽名量大，放試算表會拖慢整份表）
    getReads: function () {
      return rows('reads').filter(function (r) { return r.postId; })
        .map(function (r) { return { postId: r.postId, staffId: r.staffId, name: r.name, unit: r.unit, at: r.at, sigId: r.sigId }; });
    },
    addRead: function (r) {
      var sigId = files.saveSig(r.sig, r.postId + '_' + r.staffId);
      write('reads', { postId: r.postId, staffId: r.staffId, name: r.name, unit: r.unit, at: r.at, sigId: sigId }, null);
    },
    getSigs: function (postId) {
      var out = {};
      this.getReads().forEach(function (r) {
        if (r.postId === postId && r.sigId) { try { out[r.staffId] = files.readSig(r.sigId); } catch (e) { out[r.staffId] = null; } }
      });
      return out;
    },
    addLog: function (e) { write('log', e, null); },
    getReq: function (rid) { try { return CacheService.getScriptCache().get('req:' + rid); } catch (e) { return null; } },
    putReq: function (rid, id) { try { CacheService.getScriptCache().put('req:' + rid, id, 21600); } catch (e) {} },
    getAdmin: function () {
      var p = props_().getProperties();
      return { hash: p.ADMIN_HASH || '', salt: p.ADMIN_SALT || '', init: p.ADMIN_INIT || '', ver: Number(p.ADMIN_VER) || 1,
        fail: Number(p.ADMIN_FAIL) || 0, lockUntil: Number(p.ADMIN_LOCK) || 0 };
    },
    setAdmin: function (a) {
      var pr = props_();
      pr.setProperties({ ADMIN_HASH: a.hash || '', ADMIN_SALT: a.salt || '', ADMIN_VER: String(a.ver || 1),
        ADMIN_FAIL: String(a.fail || 0), ADMIN_LOCK: String(a.lockUntil || 0) });
      if (!a.init) pr.deleteProperty('ADMIN_INIT');          // 初始通行碼轉成雜湊後刪除原文
    },
    secret: function () { return props_().getProperty('TOKEN_SECRET'); },
    // 請求結束：有同仁異動才重寫名單快照；快照失敗只記紀錄，不影響已成功的寫入
    endRequest: function () {
      if (!snapDirty) return; snapDirty = false;
      try { writeSnap_(rows('staff')); } catch (e) { console.error('名單快照寫入失敗：' + e); }
    },
    refreshSnap: function () { writeSnap_(rows('staff')); }
  };
}
