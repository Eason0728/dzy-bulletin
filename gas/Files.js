/* 鼎兆元｜電子佈告欄 — Drive：附件上傳／分享／撤銷、簽名檔、空間（依 ② 探實測結果）
 * 分享與撤銷只對「附件資料夾」內的檔案動作，避免傳入任意 id 把其他系統的檔案分享出去。 */
'use strict';

var FOLDER_NAME_ = '鼎兆元｜電子佈告欄附件';
var SIG_FOLDER_NAME_ = '簽名';
var SIG_MIME_ = ['image/png', 'image/jpeg'];   // 簽名圖實際用的型別（saveSig 只收這兩種）

function folderByProp_(key, name, parent) {
  var pr = PropertiesService.getScriptProperties(), id = pr.getProperty(key);
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var nf = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
  pr.setProperty(key, nf.getId());
  return nf;
}
// 讀取路徑用：只讀屬性、不建資料夾（屬性遺失時回空字串，任何檔案都不會被當成在簽名資料夾裡）
function sigFolderId_() { return PropertiesService.getScriptProperties().getProperty('SIG_FOLDER_ID') || ''; }
function isSigImage_(f) { return SIG_MIME_.indexOf(f.getMimeType()) >= 0; }
function inFolder_(f, fid) {
  if (!fid) return false;
  var ps = f.getParents();
  while (ps.hasNext()) if (ps.next().getId() === fid) return true;
  return false;
}
function dataUrl_(f) { var b = f.getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); }
function attachFolder_() { return folderByProp_('FOLDER_ID', FOLDER_NAME_, null); }
function sigFolder_() { return folderByProp_('SIG_FOLDER_ID', SIG_FOLDER_NAME_, attachFolder_()); }

function makeFiles_() {
  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
  var OK_MIME = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  function ours(id) {
    var f;
    try { f = DriveApp.getFileById(id); } catch (e) { throw err('BAD_REQ', '找不到附件檔案'); }
    if (f.isTrashed()) throw err('BAD_REQ', '找不到附件檔案');     // 已撤銷（在垃圾桶）的附件不可再 share 回公開（#13 第 3 輪 R1）
    // 只允許 Word／PDF／Excel：擋掉正本試算表、簽名圖、資料夾與任何 Google 文件類型
    if (OK_MIME.indexOf(f.getMimeType()) < 0 || id === PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')) throw err('BAD_REQ', '附件格式錯誤');
    var fid = attachFolder_().getId(), ps = f.getParents();
    while (ps.hasNext()) if (ps.next().getId() === fid) return f;
    throw err('BAD_REQ', '附件不屬於佈告欄');
  }
  // M7（#18）附件備份專用：與 ours() 同三道檢查（找得到、mime 在白名單且不是正本試算表、直屬 parent 是附件資料夾），
  // 唯一差別是**不擋垃圾桶**——主管移除的附件（revoke＝丟垃圾桶）Mac mini 也要能補抓。ours() 本身不動（share／revoke 仍擋垃圾桶，M2 R1）。
  // 讀取路徑：只讀 FOLDER_ID 屬性、不建資料夾；不是我們的一律回 null、不丟錯（不洩漏檔名）。
  // 簽名圖在簽名資料夾（附件資料夾的子資料夾），直屬 parent 不符；備份 .gz、Google 文件、照片不在白名單 → 都是 null。
  function attachFolderIdForRead_() { return PropertiesService.getScriptProperties().getProperty('FOLDER_ID') || ''; }
  function okMime_(mime, id) { return OK_MIME.indexOf(mime) >= 0 && id !== PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'); }
  function oursForBackup(id) {
    try {
      var f = DriveApp.getFileById(id);                           // 垃圾桶內的檔 getFileById 讀得到
      if (!okMime_(f.getMimeType(), id)) return null;
      return inFolder_(f, attachFolderIdForRead_()) ? f : null;
    } catch (e) { return null; }
  }
  return {
    // 橋接 fileget（分段讀附件位元組，含垃圾桶）：off／len 由 bridgeCore_ 驗過；md5 用 Drive 已算好的 md5Checksum
    backupGet: function (id, off, len) {
      var f = oursForBackup(id);
      if (!f) return { file: null };
      try {
        var m = Drive.Files.get(id, { fields: 'md5Checksum,size,trashed' });
        var bytes = f.getBlob().getBytes(), size = bytes.length, end = Math.min(size, off + len);
        return {
          file: { id: id, name: f.getName(), mime: f.getMimeType(), size: size, md5: String(m.md5Checksum || ''), trashed: !!(m.trashed || f.isTrashed()) },
          off: off, data: off < end ? Utilities.base64Encode(bytes.slice(off, end)) : '', eof: end >= size
        };
      } catch (e) { console.error('backupGet: ' + e); return { file: null }; }
    },
    // 橋接 filelist：附件資料夾直屬的檔（**不加 trashed=false**，要含垃圾桶），伺服器端再過白名單；只回 id 與 meta
    backupList: function (pageToken) {
      var fid = attachFolderIdForRead_();
      if (!fid) return { files: [], nextPageToken: '' };
      var o = { q: "'" + fid.replace(/[\\']/g, '') + "' in parents", pageSize: 200,
        fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,trashed,createdTime)' };
      if (pageToken) o.pageToken = pageToken;
      var r = Drive.Files.list(o);
      return {
        files: (r.files || []).filter(function (x) { return okMime_(x.mimeType, x.id); }).map(function (x) {
          return { id: x.id, name: x.name, mime: x.mimeType, size: Number(x.size) || 0, md5: String(x.md5Checksum || ''), trashed: !!x.trashed, createdTime: x.createdTime || '' };
        }),
        nextPageToken: r.nextPageToken || ''
      };
    },
    upload: function (name, mime, b64) {
      var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, name);
      var f = attachFolder_().createFile(blob);
      Drive.Files.update({ copyRequiresWriterPermission: true }, f.getId());   // 禁止下載／列印／複製
      return { id: f.getId(), name: name, type: DZYB.fileType(name), size: f.getSize() };   // 先不分享，儲存公告時才分享
    },
    share: function (ids) {
      ids.forEach(function (id) {
        var f = ours(id);
        if (f.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK) f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      });
    },
    // 實測：丟垃圾桶後有連結的人仍看得到，所以一定要先關分享
    revoke: function (ids) {
      ids.forEach(function (id) {
        try { var f = ours(id); f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); f.setTrashed(true); } catch (e) { console.warn('revoke ' + id + ': ' + e); }
      });
    },
    quota: function () {
      var q = Drive.About.get({ fields: 'storageQuota' }).storageQuota;
      return { limit: Number(q.limit) || 0, usage: Number(q.usage) || 0 };
    },
    saveSig: function (dataUrl, name) {
      var m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) throw err('BAD_REQ', '簽名格式錯誤');
      var ext = m[1] === 'image/png' ? '.png' : '.jpg';
      return sigFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + ext)).getId();
    },
    // 橋接專用（sig／sigs.get）：只回 PNG／JPEG，而且必須「在簽名資料夾裡」或「是已讀分頁裡既有的簽名檔 id」（known）；
    // 其他一律回 null、不丟錯（不洩漏檔名）。金鑰外洩時影響範圍只到簽名圖（#13 B1）；
    // known 讓簽名資料夾重建過的舊簽名也搬得走（S5），而分頁的 id 只能由 GAS 自己或通過驗證的 mirror 寫入（N1）。
    readSigSafe: function (id, known) {
      try {
        id = String(id || '');
        var f = DriveApp.getFileById(id);
        if (!isSigImage_(f)) return null;
        if (!(known && known[id]) && !inFolder_(f, sigFolderId_())) return null;
        return dataUrl_(f);
      } catch (e) { return null; }
    },
    // mirror 驗證用：這個 id 是不是「目前簽名資料夾裡的圖」（sigs.put 新產生的都是）
    isSigFile: function (id) {
      try { var f = DriveApp.getFileById(String(id || '')); return isSigImage_(f) && inFolder_(f, sigFolderId_()); } catch (e) { return false; }
    },
    // 批次上傳簽名（橋接 sigs.put）：資料夾只找一次；逐張處理，失敗的那張回 null，不讓前面已建的檔變孤兒、下一輪也不整批重傳
    saveSigs: function (items) {
      var fo = sigFolder_();
      return items.map(function (x) {
        try {
          var m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(String(x && x.data || ''));
          if (!m) return null;
          var name = String(x && x.name || 'sig').replace(/[^\w.-]/g, '_') + (m[1] === 'image/png' ? '.png' : '.jpg');
          return fo.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name)).getId();
        } catch (e) { console.error('saveSigs: ' + e); return null; }
      });
    },
    // GAS 自己的回條（getSigs，id 來自已讀分頁）：任何路徑都只回 PNG／JPEG，其他回 null（#13 N1 b）
    readSig: function (id) {
      var f = DriveApp.getFileById(id);
      return isSigImage_(f) ? dataUrl_(f) : null;
    }
  };
}
