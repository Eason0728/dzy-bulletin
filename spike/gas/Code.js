// 用完即丟：電子佈告欄 ② 探 spike。驗證 (1) 執行身分 (2) base64 上傳上限 (3) 直傳 Drive 的續傳上傳 (4) 禁止下載設定。
// 不碰任何正式試算表；只在自建的「【spike】佈告欄附件測試」資料夾內建檔。
const FOLDER_NAME = '【spike】佈告欄附件測試';

function authorizeOnce() { // Eason 在編輯器執行一次以完成授權
  folder_(); Logger.log('ok ' + folder_().getOwner().getEmail());
}
function folder_() {
  const p = PropertiesService.getScriptProperties();
  let id = p.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(FOLDER_NAME); p.setProperty('FOLDER_ID', f.getId()); return f;
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet() { return out_({ ok: true, user: folder_().getOwner().getEmail() }); }

function doPost(e) {
  const t0 = Date.now();
  try {
    const req = JSON.parse(e.postData.contents);
    const r = handle_(req);
    r.ms = Date.now() - t0; r.bodyChars = e.postData.contents.length;
    return out_(r);
  } catch (err) { return out_({ ok: false, error: String(err), ms: Date.now() - t0 }); }
}

function handle_(req) {
  if (req.action === 'b64') {           // 方法 A：整包 base64
    const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime, req.name);
    const f = folder_().createFile(blob);
    return Object.assign({ ok: true, method: 'b64', size: f.getSize() }, lock_(f.getId()));
  }
  if (req.action === 'init') {          // 方法 B：開續傳工作階段，瀏覽器直接 PUT 到 Google
    const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size', {
      method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': req.mime,
                 'X-Upload-Content-Length': String(req.size), Origin: req.origin },
      payload: JSON.stringify({ name: req.name, parents: [folder_().getId()] })
    });
    const h = res.getAllHeaders();
    return { ok: res.getResponseCode() === 200, code: res.getResponseCode(), uploadUrl: h.Location || h.location, body: res.getContentText().slice(0, 300) };
  }
  if (req.action === 'unshare') { return { ok: true, done: req.ids.map(id => { const f = DriveApp.getFileById(id); f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); return id; }) }; }
  if (req.action === 'trash') { const f = folder_(); f.setTrashed(true); PropertiesService.getScriptProperties().deleteProperty('FOLDER_ID'); return { ok: true, trashed: f.getName() }; }
  if (req.action === 'quota') { const a = Drive.About.get({ fields: 'storageQuota' }); return { ok: true, q: a.storageQuota }; }
  if (req.action === 'lock') return Object.assign({ ok: true }, lock_(req.fileId));
  throw new Error('unknown action');
}

// 禁止下載／列印／複製（copyRequiresWriterPermission）＋ 知道連結者可檢視
function lock_(id) {
  Drive.Files.update({ copyRequiresWriterPermission: true }, id);
  DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const m = Drive.Files.get(id, { fields: 'id,name,size,mimeType,copyRequiresWriterPermission' });
  return { fileId: id, meta: m, preview: 'https://drive.google.com/file/d/' + id + '/preview' };
}
