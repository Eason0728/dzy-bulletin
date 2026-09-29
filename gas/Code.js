/* 鼎兆元｜電子佈告欄 — Web App 入口
 * 正本在 repo ~/dzy-bulletin/gas/；Logic.js 由 tools/build.sh 從 js/logic.js 產生，不要手改。 */
'use strict';

var VERSION_ = '0.1.0';

function doGet() {
  return json_({ ok: true, data: { app: 'dzy-bulletin', v: VERSION_ } });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); }
  catch (x) { return json_({ ok: false, code: 'BAD_REQ', message: '格式錯誤' }); }
  var action = String(req.action || '');
  try {
    var files = makeFiles_();
    var svc = makeService_(DZYB, makeStore_(files), files, makeAuth_(gasCrypto_(), DZYB),
      { nowMs: function () { return Date.now(); }, today: function () { return DZYB.today(); } });
    if (svc.WRITE_ACTIONS.indexOf(action) < 0) return json_(svc.call(action, req));
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ ok: false, code: 'SERVER', message: '同時操作的人太多，請稍後再試' });
    try { return json_(svc.call(action, req)); } finally { lock.releaseLock(); }
  } catch (x) {
    console.error(action + ': ' + (x && x.stack || x));
    return json_({ ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' });
  }
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
    var def = SHEETS_[k], sh = book.getSheetByName(def.name) || book.insertSheet(def.name);
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');   // 純文字，避免日期被轉型
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var blank = book.getSheetByName('工作表1') || book.getSheetByName('Sheet1');
  if (blank && book.getSheets().length > 1) book.deleteSheet(blank);
  // 試算表放進附件資料夾，集中管理
  var folder = attachFolder_(); sigFolder_();
  var file = DriveApp.getFileById(book.getId());
  if (!file.getParents().hasNext() || file.getParents().next().getId() !== folder.getId()) folder.addFile(file);
  if (!pr.getProperty('TOKEN_SECRET')) pr.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!pr.getProperty('ADMIN_VER')) pr.setProperty('ADMIN_VER', '1');
  Drive.About.get({ fields: 'user' });   // 觸發 Drive 進階服務授權
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
