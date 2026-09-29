/* 鼎兆元｜電子佈告欄 — Drive：附件上傳／分享／撤銷、簽名檔、空間（依 ② 探實測結果）
 * 分享與撤銷只對「附件資料夾」內的檔案動作，避免傳入任意 id 把其他系統的檔案分享出去。 */
'use strict';

var FOLDER_NAME_ = '鼎兆元｜電子佈告欄附件';
var SIG_FOLDER_NAME_ = '簽名';

function folderByProp_(key, name, parent) {
  var pr = PropertiesService.getScriptProperties(), id = pr.getProperty(key);
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var nf = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
  pr.setProperty(key, nf.getId());
  return nf;
}
function attachFolder_() { return folderByProp_('FOLDER_ID', FOLDER_NAME_, null); }
function sigFolder_() { return folderByProp_('SIG_FOLDER_ID', SIG_FOLDER_NAME_, attachFolder_()); }

function makeFiles_() {
  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
  var OK_MIME = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  function ours(id) {
    var f;
    try { f = DriveApp.getFileById(id); } catch (e) { throw err('BAD_REQ', '找不到附件檔案'); }
    // 只允許 Word／PDF／Excel：擋掉正本試算表、簽名圖、資料夾與任何 Google 文件類型
    if (OK_MIME.indexOf(f.getMimeType()) < 0 || id === PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')) throw err('BAD_REQ', '附件格式錯誤');
    var fid = attachFolder_().getId(), ps = f.getParents();
    while (ps.hasNext()) if (ps.next().getId() === fid) return f;
    throw err('BAD_REQ', '附件不屬於佈告欄');
  }
  return {
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
    readSig: function (id) {
      var b = DriveApp.getFileById(id).getBlob();
      return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
    }
  };
}
