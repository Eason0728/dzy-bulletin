/* 鼎兆元｜電子佈告欄 — 公告附件的本機備份（M7，#18）：DATA_DIR/files/ 的讀寫共用（server/index.js 上傳／移除、server/mirror.js 第 3 步補齊）
 * 檔案系統就是正本，不加資料表（#18 D0）：
 *   files/<fileId>       ＝附件位元組（只當備份；同仁看附件照樣走 Drive 線上預覽，本機永遠不執行、不對外提供）
 *   files/<fileId>.json  ＝meta：{ name, mime, size, md5, sha256, savedAt, wantedAt, source, removedAt?, trashed? }
 *                          source＝upload（D1 上傳當下）｜posts（公告引用、補建）｜revoke（移除時補建）｜filelist（Drive 掃描）｜local（有位元組沒 meta，掃描補建）
 *   meta 存在、位元組不存在＝pending（mirror.js 第 3 步補抓）。meta 先寫、位元組後寫；一律先寫 .tmp 再 rename。
 *   移除後永久保留：本機位元組**永遠不刪**（revoke 只動 Drive）；也沒有任何程式會刪 files/ 裡的正式檔。
 * fileId 只允許 [A-Za-z0-9_-]（Drive id 本來就只有這些字元），不符一律拒絕（防路徑穿越）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const filesDir = (dir) => path.join(dir, 'files');
function need(id) { if (!validId(id)) { const e = new Error('附件 id 格式錯誤'); e.code = 'BAD_ID'; throw e; } return id; }
const bytesPath = (dir, id) => path.join(filesDir(dir), need(id));
const metaPath = (dir, id) => path.join(filesDir(dir), need(id) + '.json');
const hashes = (buf) => ({ md5: crypto.createHash('md5').update(buf).digest('hex'), sha256: crypto.createHash('sha256').update(buf).digest('hex') });
const MIME = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const mimeOf = (name) => MIME[String(name || '').split('.').pop().toLowerCase()] || '';
const okMime = (m) => Object.values(MIME).includes(m);        // 與 gas/Files.js OK_MIME 同一份白名單（filelist 在 Node 端再過一次）

function readMeta(dir, id) {
  try { const v = JSON.parse(fs.readFileSync(metaPath(dir, id), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
}
function hasBytes(dir, id) { try { return fs.statSync(bytesPath(dir, id)).isFile(); } catch (e) { return false; } }
// 同步版（mirror.js 用；它是獨立程序，卡住自己沒關係）
function writeMeta(dir, id, meta) {
  fs.mkdirSync(filesDir(dir), { recursive: true });
  const p = metaPath(dir, id), tmp = p + '.tmp-' + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(meta)); fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} throw e; }
}
// 非同步版（index.js 用：不卡事件迴圈）
async function writeMetaAsync(dir, id, meta) {
  await fs.promises.mkdir(filesDir(dir), { recursive: true });
  const p = metaPath(dir, id), tmp = p + '.tmp-' + process.pid;
  try { await fs.promises.writeFile(tmp, JSON.stringify(meta)); await fs.promises.rename(tmp, p); }
  catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
}
async function readMetaAsync(dir, id) {
  try { const v = JSON.parse(await fs.promises.readFile(metaPath(dir, id), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
}

// D1：新上傳存本機。回應已送出之後才呼叫（主管永遠不等磁碟）；丟錯由呼叫端記 stderr。
// 先寫 meta（寫成功＝之後 pending 可補）再寫位元組；driveSize 與實際不符只回警告字串（不擋）。
async function saveLocal(dir, id, name, b64, driveSize) {
  need(id);
  const buf = Buffer.from(String(b64 || ''), 'base64'), h = hashes(buf), now = new Date().toISOString();
  const meta = { name: String(name || ''), mime: mimeOf(name), size: buf.length, md5: h.md5, sha256: h.sha256, savedAt: '', wantedAt: now, source: 'upload' };
  await writeMetaAsync(dir, id, meta);
  const p = bytesPath(dir, id), tmp = p + '.tmp';
  try { await fs.promises.writeFile(tmp, buf); await fs.promises.rename(tmp, p); }
  catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
  meta.savedAt = new Date().toISOString();
  await writeMetaAsync(dir, id, meta);
  return Number(driveSize) >= 0 && Number(driveSize) !== buf.length ? `大小與 Drive 回報不同（本機 ${buf.length}、Drive ${driveSize}）` : '';
}
// D1：savePost 移除附件時（送 revoke 之前）確保 meta 存在並標 removedAt；位元組不動（永久保留）
async function markRemoved(dir, id, name) {
  need(id);
  const now = new Date().toISOString(), m = await readMetaAsync(dir, id);
  if (m && m.removedAt) return;
  await writeMetaAsync(dir, id, m ? Object.assign(m, { removedAt: now }) : { name: String(name || ''), mime: mimeOf(name), wantedAt: now, source: 'revoke', removedAt: now });
}

// files/ 目前的狀態：metas（有 .json 的 id）、bytes（有位元組的 id）；非法檔名、暫存檔另列
function scan(dir) {
  let names = [];
  try { names = fs.readdirSync(filesDir(dir)); } catch (e) { return { metas: [], bytes: [], tmps: [] }; }
  const metas = [], bytes = [], tmps = [];
  names.forEach((n) => {
    if (/\.tmp(-\d+)?$/.test(n)) tmps.push(n);
    else if (n.endsWith('.json')) { if (validId(n.slice(0, -5))) metas.push(n.slice(0, -5)); }
    else if (validId(n)) bytes.push(n);
  });
  return { metas, bytes, tmps };
}

module.exports = { validId, filesDir, bytesPath, metaPath, hashes, mimeOf, okMime, readMeta, hasBytes, writeMeta, writeMetaAsync, saveLocal, markRemoved, scan };
