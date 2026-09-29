/* 鼎兆元｜電子佈告欄 — Web App 入口
 * 正本在 repo ~/dzy-bulletin/gas/；Logic.js 由 tools/build.sh 從 js/logic.js 產生，不要手改。 */
'use strict';

var WRITE_ACTIONS_ = ['setPin', 'login', 'ack', 'adminLogin', 'savePost', 'setPublished', 'setPinned', 'staffAdd', 'staffDelete', 'staffResetPin', 'syncClock', 'staffSetStore'];   // 必須與 Service.WRITE_ACTIONS 一致（test 檢查）
var VERSION_ = '0.5.5';
// 後端搬 Mac mini（#5、#7）：指令碼屬性 PRIMARY＝gas（現況）／mini（已切到 Mac mini）。
// mini 時寫入一律回 MOVED、讀取照常：還沒重新整理的舊頁面能看、不能寫（避免切換期雙寫）。uploadFile 也擋（與 Mac mini 的 READONLY 同步，免得留孤兒附件）。
// 只有寫入動作才讀 PRIMARY（讀取動作零成本、PRIMARY 沒設時與改版前完全一樣）；寫入在拿到鎖之後再確認一次（等鎖期間才切 mini 也擋得住）。
var MOVED_ = { ok: false, code: 'MOVED', message: '系統已搬家，請重新整理' };
function isMini_(v) { return String(v == null ? '' : v).trim().toLowerCase() === 'mini'; }   // 'mini '／'Mini' 手滑也算
function gated_(action) { return WRITE_ACTIONS_.indexOf(action) >= 0 || action === 'uploadFile'; }
function movedGate_(action, primary) { return gated_(action) && isMini_(primary) ? MOVED_ : null; }
function primary_() { return PropertiesService.getScriptProperties().getProperty('PRIMARY'); }

function doGet() {
  return json_({ ok: true, data: { app: 'dzy-bulletin', v: VERSION_ } });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); }
  catch (x) { return json_({ ok: false, code: 'BAD_REQ', message: '格式錯誤' }); }
  var action = String(req.action || '');
  if (action === 'bridge') return json_(bridge_(req));            // Mac mini 伺服器專用（需 BRIDGE_KEY）；bridge_ 自己有 try
  try {
    if (gated_(action) && movedGate_(action, primary_())) return json_(MOVED_);
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
    try {
      if (movedGate_(action, primary_())) return json_(MOVED_);    // 鎖內再確認：等鎖期間 PRIMARY 改成 mini（export 插隊）也不會落地
      return json_(build().call(action, req));
    } finally { lock.releaseLock(); }
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

/* ===== Google 橋接：只有持有 BRIDGE_KEY 的 Mac mini 伺服器能呼叫（2026-09-30 後端搬 Mac mini，#7） =====
 * 附件（Drive）、打卡名單、簽名圖、搬遷匯出、鏡像與備份。BRIDGE_KEY 由 Eason 自己產生、親手貼進指令碼屬性與 Mac mini server/.env
 * （Claude 不經手、不印出）。op 名稱與參數格式必須與 server/bridge.js 一致。
 * bridgeCore_ 只靠注入的 d 碰外界（屬性、Drive、試算表、鎖），node 測試直接餵假的 d（test/bridge.test.js）。 */
var BRIDGE_KEY_MIN_ = 32, SIGS_MAX_ = 20;
function bridgeCore_(req, d) {
  // 金鑰：屬性缺／短於 32、送來的不是字串（物件、陣列）或不相符，一律 AUTH，而且先於任何參數檢查——
  // M1 的 bridge.js 會把 BAD_REQ 當業務錯誤原樣顯示給主管，金鑰問題絕不能回 BAD_REQ（#12 第 3 輪）
  var key = d.prop('BRIDGE_KEY'), auth = { ok: false, code: 'AUTH', message: '橋接金鑰錯誤' };
  if (!key || String(key).length < BRIDGE_KEY_MIN_ || typeof req.key !== 'string' || !d.safeEq(req.key, String(key))) return auth;
  var op = typeof req.op === 'string' ? req.op : '', mini = isMini_(d.prop('PRIMARY'));
  var ok = function (x) { return { ok: true, data: x }; };
  var bad = function (m) { return { ok: false, code: 'BAD_REQ', message: m }; };
  var deny = { ok: false, code: 'AUTH', message: '目前不接受這個橋接動作' };
  var locked = function (ms, fn) {                                   // 拿不到鎖就回忙碌，不排隊
    var release = d.lock(ms);
    if (!release) return { ok: false, code: 'SERVER', message: '忙碌中' };
    try { return fn(); } finally { release(); }
  };
  try {
    if (op === 'upload') return ok(d.files().upload(String(req.name || ''), String(req.mime || ''), String(req.data || '')));
    if (op === 'share') { d.files().share(Array.isArray(req.ids) ? req.ids.map(String) : []); return ok({}); }
    if (op === 'revoke') { d.files().revoke(Array.isArray(req.ids) ? req.ids.map(String) : []); return ok({}); }
    if (op === 'quota') return ok(d.files().quota());
    if (op === 'clock') return ok(d.clock());
    if (op === 'sig') return ok(d.files().readSigSafe(String(req.id || ''), d.store().sigIds()));   // 只讀簽名資料夾或分頁既有的簽名圖，其他回 null（#13 B1、S5）
    // 批次簽名圖（一次最多 20 張，一次橋接呼叫）：put＝上傳到簽名資料夾、依序回傳 Drive id（M3 回填 driveSigId）；
    // get＝依 Drive id 讀回 data URL（M5 搬遷批次下載）；只放行「在簽名資料夾內或已讀分頁既有」的 PNG／JPEG，其他給 null。兩者擇一。
    if (op === 'sigs') {
      var put = req.put, get = req.get;
      if (Array.isArray(put) === Array.isArray(get)) return bad('sigs 需要 put 或 get 其中一個');
      var list = put || get;
      if (!list.length || list.length > SIGS_MAX_) return bad('sigs 一次 1～' + SIGS_MAX_ + ' 張');
      var fs = d.files();
      if (put) return ok({ ids: fs.saveSigs(put) });                // 逐張處理，失敗的那張是 null（呼叫端下一輪只重傳 null 的）
      var out = {}, known = d.store().sigIds();
      get.forEach(function (id) { id = String(id); out[id] = fs.readSigSafe(id, known); });
      return ok({ sigs: out });
    }
    // 搬遷匯出：交出全部密碼雜湊＋TOKEN_SECRET，不能是常駐能力 → 只在 PRIMARY=mini 且 EXPORT_ONCE=1 時接受，成功一次就刪掉 EXPORT_ONCE。
    // 在 ScriptLock 內、fresh 讀試算表（不走快取），匯出當下沒有寫入能插進來。
    if (op === 'export') {
      if (!mini) return deny;
      return locked(30000, function () {
        if (!isMini_(d.prop('PRIMARY')) || d.prop('EXPORT_ONCE') !== '1') return deny;   // 鎖內再讀一次：兩個 export 同時進來只有一個成功
        var secret = d.prop('TOKEN_SECRET') || '', admin = { hash: d.prop('ADMIN_HASH') || '', salt: d.prop('ADMIN_SALT') || '',
          ver: Number(d.prop('ADMIN_VER')) || 1, fail: 0, lockUntil: 0 };
        // 缺 secret 或管理雜湊，搬過去後所有人都要重新登入／主管進不去 → 直接拒絕，EXPORT_ONCE 保留（migrate.js 另有同一道檢查，#10）
        if (!secret || !admin.hash) return { ok: false, code: 'SERVER', message: '缺 TOKEN_SECRET 或 ADMIN_HASH，拒絕匯出' };
        var data = d.store().dump();
        data.admin = admin; data.secret = secret;
        d.delProp('EXPORT_ONCE');
        return ok(data);
      });
    }
    // 鏡像只在 PRIMARY=mini 時接受：回退到 GAS 後，Mac mini 的每小時鏡像（launchd 忘了關）也蓋不掉 GAS 的新資料（唯一硬保險）
    if (op === 'mirror') {
      if (!mini) return deny;
      return locked(30000, function () {
        if (!isMini_(d.prop('PRIMARY'))) return deny;              // 鎖內再讀一次：回退切 PRIMARY=gas 時正在等鎖的鏡像也不能蓋（#13 S2）
        return ok({ counts: d.store().mirror(req.data, { force: req.force === true }) });
      });
    }
    if (op === 'backup') return ok(d.backup(String(req.name || ''), String(req.data || '')));
    return bad('未知的橋接動作');
  } catch (e) {
    console.error('bridge ' + op + ': ' + (e && e.stack || e));        // 只記 op，不記 req（內含金鑰）
    return { ok: false, code: e && e.code || 'SERVER', message: e && e.code ? e.message : 'Google 橋接出錯' };
  }
}
function bridge_(req) {
  try { return bridgeCore_(req, gasBridgeDeps_()); }
  catch (e) { console.error('bridge: ' + (e && e.stack || e)); return { ok: false, code: 'SERVER', message: 'Google 橋接出錯' }; }   // 不回錯誤網頁
}
function gasBridgeDeps_() {
  var pr = PropertiesService.getScriptProperties(), files = null, store = null;
  return {
    prop: function (k) { return pr.getProperty(k); },
    delProp: function (k) { pr.deleteProperty(k); },
    safeEq: makeAuth_(gasCrypto_(), DZYB).safeEq,
    files: function () { return files || (files = makeFiles_()); },
    store: function () { return store || (store = makeStore_(files || (files = makeFiles_()))); },
    lock: function (ms) { var l = LockService.getScriptLock(); return l.tryLock(ms) ? function () { l.releaseLock(); } : null; },
    clock: function () { var cs = clockSource_(); return cs ? cs.read() : { rows: [], errors: ['未設定打卡來源'], sources: [], counts: {} }; },
    backup: saveBackup_
  };
}

// 每日 DB 快照：獨立的「鼎兆元｜電子佈告欄備份」資料夾（雲端硬碟根目錄、不分享、僅 owner），保留 30 天。
// 不得放在附件資料夾底下：附件資料夾有 share／ours 邏輯，且會被人打開翻（#7）。
var BACKUP_FOLDER_NAME_ = '鼎兆元｜電子佈告欄備份', BACKUP_KEEP_DAYS_ = 30;
function backupFolder_() {
  var fo = folderByProp_('BACKUP_FOLDER_ID', BACKUP_FOLDER_NAME_, null), aid = attachFolder_().getId(), ps = fo.getParents();
  while (ps.hasNext()) {
    if (ps.next().getId() === aid) {                                // 舊草稿曾建在附件資料夾下 → 改建新的獨立資料夾
      PropertiesService.getScriptProperties().deleteProperty('BACKUP_FOLDER_ID');
      fo = folderByProp_('BACKUP_FOLDER_ID', BACKUP_FOLDER_NAME_, null); break;
    }
  }
  if (fo.getSharingAccess() !== DriveApp.Access.PRIVATE) fo.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return fo;
}
// setSharing(PRIVATE) 只收回「知道連結者」；個別加入的共用者不自動移除（可能是 Eason 故意加的），只回報人數讓 M3 的 backup-last.json 標黃
function backupSharedWith_(fo) {
  try { return fo.getEditors().length + fo.getViewers().length; } catch (e) { return -1; }
}
function saveBackup_(name, b64) {
  if (!name || !b64) { var e = new Error('備份檔名或內容是空的'); e.code = 'BAD_REQ'; throw e; }
  var fo = backupFolder_();
  var f = fo.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'application/gzip', name.replace(/[^\w.-]/g, '_')));
  f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);   // 分享狀態明確設成「限制」
  var cut = Date.now() - BACKUP_KEEP_DAYS_ * 86400e3, it = fo.getFiles(), trashed = 0;
  while (it.hasNext()) { var x = it.next(); if (x.getId() !== f.getId() && x.getDateCreated().getTime() < cut) { x.setTrashed(true); trashed++; } }
  return { id: f.getId(), size: f.getSize(), trashed: trashed, sharedWith: backupSharedWith_(fo) };
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
