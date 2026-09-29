/* 鼎兆元｜電子佈告欄 — Web App 入口
 * 正本在 repo ~/dzy-bulletin/gas/；Logic.js 由 tools/build.sh 從 js/logic.js 產生，不要手改。 */
'use strict';

var WRITE_ACTIONS_ = ['setPin', 'login', 'ack', 'adminLogin', 'savePost', 'setPublished', 'setPinned', 'staffAdd', 'staffDelete', 'staffResetPin', 'syncClock', 'staffSetStore'];   // 必須與 Service.WRITE_ACTIONS 一致（test 檢查）
var VERSION_ = '0.5.2';

function doGet() {
  return json_({ ok: true, data: { app: 'dzy-bulletin', v: VERSION_ } });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); }
  catch (x) { return json_({ ok: false, code: 'BAD_REQ', message: '格式錯誤' }); }
  var action = String(req.action || '');
  try {
    // 寫入動作：先拿鎖、再建 store（store 的快取世代在鎖內才讀，避免用到鎖外的舊快照）
    var build = function () {
      var files = makeFiles_();
      return makeService_(DZYB, makeStore_(files), files, makeAuth_(gasCrypto_(), DZYB),
        { nowMs: function () { return Date.now(); }, today: function () { return DZYB.today(); } }, clockSource_());
    };
    if (action === 'roster') {                                    // 名單結果快取：命中時連 store／service 都不建（世代換了自動失效）
      var ck = 'roster:' + (PropertiesService.getScriptProperties().getProperty('DATA_GEN') || '0'), hit = null;
      try { hit = CacheService.getScriptCache().get(ck); } catch (x) {}
      if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
      var out = JSON.stringify(build().call(action, req));
      try { if (out.length < 30000 && out.indexOf('"ok":true') === 1) CacheService.getScriptCache().put(ck, out, 600); } catch (x) {}
      return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
    }
    if (WRITE_ACTIONS_.indexOf(action) < 0) return json_(build().call(action, req));
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ ok: false, code: 'SERVER', message: '同時操作的人太多，請稍後再試' });
    try { return json_(build().call(action, req)); } finally { lock.releaseLock(); }
  } catch (x) {
    console.error(action + ': ' + (x && x.stack || x));
    return json_({ ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' });
  }
}

/* 打卡系統名單（唯讀）：roster 分頁的 emp_id／name／active／removed_at。來源清單在 Config.local.js（不進 git） */
function clockSource_() {
  if (typeof CLOCK_SOURCES_ === 'undefined') return null;
  return {
    read: function () {
      var rows = [], errors = [], counts = {}, sources = [];
      CLOCK_SOURCES_.forEach(function (c) {
        try {
          var v = SpreadsheetApp.openById(c.ssId).getSheetByName('roster').getDataRange().getValues();
          var h = v[0].map(String), iE = h.indexOf('emp_id'), iN = h.indexOf('name'), iA = h.indexOf('active'), iR = h.indexOf('removed_at');
          if (iE < 0 || iN < 0 || iA < 0) throw new Error('roster 欄位不符');
          var n = 0;
          v.slice(1).forEach(function (r) {
            var active = (r[iA] === true || String(r[iA]).toUpperCase() === 'TRUE') && !(iR >= 0 && String(r[iR]).trim());
            if (!String(r[iE]).trim()) return;
            if (active) n++;
            rows.push({ src: c.src, unit: c.unit, store: c.store || '', empId: String(r[iE]).trim(), name: String(r[iN]).trim(), active: active });
          });
          counts[c.label] = n; sources.push(c.src);
        } catch (e) { errors.push(c.label + '：讀取失敗，請確認打卡試算表還在、名單分頁叫 roster'); console.error(c.label + ': ' + e); }
      });
      return { rows: rows, errors: errors, counts: counts, sources: sources };
    }
  };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* 首次安裝：Eason 在編輯器執行一次（同時完成授權）。可重複執行，不會覆蓋既有資料。 */
function setup() {
  var pr = PropertiesService.getScriptProperties();
  var ssId = pr.getProperty('SPREADSHEET_ID'), book;
  if (ssId) book = SpreadsheetApp.openById(ssId);
  else { book = SpreadsheetApp.create('鼎兆元｜電子佈告欄'); pr.setProperty('SPREADSHEET_ID', book.getId()); }
  Object.keys(SHEETS_).forEach(function (k) {
    if (k === 'snap') return;                                     // 名單快照在獨立試算表，不放主試算表
    var def = SHEETS_[k], sh = book.getSheetByName(def.name) || book.insertSheet(def.name);
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');   // 純文字，避免日期被轉型（之後每次寫入也會對該列再設一次）
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var blank = book.getSheetByName('工作表1') || book.getSheetByName('Sheet1');
  if (blank && book.getSheets().length > 1) book.deleteSheet(blank);
  // 附件資料夾只放附件與簽名；正本試算表放在雲端硬碟根目錄（舊版曾放進附件資料夾，重跑 setup 會移出）
  var folder = attachFolder_(); sigFolder_();
  var file = DriveApp.getFileById(book.getId()), ps = file.getParents();
  while (ps.hasNext()) { if (ps.next().getId() === folder.getId()) { file.moveTo(DriveApp.getRootFolder()); break; } }
  if (!pr.getProperty('TOKEN_SECRET')) pr.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!pr.getProperty('ADMIN_VER')) pr.setProperty('ADMIN_VER', '1');
  Drive.About.get({ fields: 'user' });   // 觸發 Drive 進階服務授權
  try { makeStore_(makeFiles_()).refreshSnap(); } catch (e) { Logger.log('名單快照：' + e); }
  var sp = pr.getProperty('SNAP_SS_ID');
  if (sp) Logger.log('公開名單試算表（只有遮罩姓名，可整份發布到網路）：' + SpreadsheetApp.openById(sp).getUrl());
  Logger.log('試算表：' + book.getUrl());
  Logger.log('附件資料夾：' + folder.getUrl());
  Logger.log(pr.getProperty('ADMIN_HASH') ? '管理通行碼：已設定' : '管理通行碼：尚未設定 → 請到「專案設定 → 指令碼屬性」新增 ADMIN_INIT');
}

/* 部署後自我檢查：HMAC／SHA-256 輸出必須與 node 測試的已知向量一致 */
function selfTest() {
  var c = gasCrypto_();
  Logger.log('sha256(ab2580)=' + c.sha256Hex('ab2580'));
  Logger.log('hmac(k,S-001|1)=' + c.hmacB64url('k', 'S-001|1'));
  Logger.log('mask=' + DZYB.maskName('歐陽娜娜') + ' today=' + DZYB.today());
}
