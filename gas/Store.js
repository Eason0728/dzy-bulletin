/* 鼎兆元｜電子佈告欄 — 試算表讀寫（Service.js 的 store 介面）
 * 四個分頁全部設成純文字格式（setup 時），避免日期被 Sheets 自動轉型；讀取時仍防呆轉回字串。 */
'use strict';

var SHEETS_ = {
  posts: { name: '公告', cols: ['id', 'title', 'body', 'units', 'publishOn', 'expiresOn', 'pinned', 'published', 'offOn', 'files', 'createdAt', 'updatedAt'],
    head: ['id', '標題', '內容', '單位', '上架日', '到期日', '置頂', '上架中', '手動下架日', '附件', '建立時間', '最後修改時間'] },
  staff: { name: '同仁', cols: ['id', 'name', 'unit', 'pinHash', 'salt', 'pinVer', 'fail', 'active', 'createdAt', 'deletedAt'],
    head: ['id', '姓名', '單位', '密碼雜湊', 'salt', '密碼版本', '連續錯誤次數', '在職', '建立時間', '刪除時間'] },
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

function makeStore_(files) {
  var book = ss_(), memo = {};
  function sheet(key) { return book.getSheetByName(SHEETS_[key].name); }
  function rows(key) {
    if (memo[key]) return memo[key];
    var sh = sheet(key), n = sh.getLastRow() - 1, cols = SHEETS_[key].cols;
    var vals = n > 0 ? sh.getRange(2, 1, n, cols.length).getValues() : [];
    memo[key] = vals.map(function (r, i) {
      var o = { _row: i + 2 }; cols.forEach(function (c, j) { o[c] = cellStr_(r[j]); }); return o;
    });
    return memo[key];
  }
  function write(key, obj, row) {
    var cols = SHEETS_[key].cols, sh = sheet(key);
    var vals = [cols.map(function (c) { var v = obj[c]; return v === undefined || v === null ? '' : String(v); })];
    if (row) sh.getRange(row, 1, 1, cols.length).setValues(vals);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, cols.length).setValues(vals);
    delete memo[key];
  }
  function upsert(key, obj) {
    var hit = rows(key).filter(function (r) { return r.id === obj.id; })[0];
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
      fail: Number(r.fail) || 0, active: bool_(r.active), createdAt: r.createdAt, deletedAt: r.deletedAt };
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
    secret: function () { return props_().getProperty('TOKEN_SECRET'); }
  };
}
