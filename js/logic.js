/* 鼎兆元｜電子佈告欄 — 共用純函式（正本）
 * 前端 <script> 載入、後端由 tools/build.sh 複製成 gas/Logic.js、node 測試 require。
 * 契約見 docs/task.md 共用契約 C1–C14，改這裡前先改契約。 */
'use strict';

var DZYB = (function () {
  // C1
  var UNITS = [
    { id: 'mzt', name: '墨竹亭' },
    { id: 'mala', name: '小辛辣' },
    { id: 'cf', name: '央廚' }
  ];
  var UNIT_IDS = UNITS.map(function (u) { return u.id; });
  var UNIT_NAME = {};
  UNITS.forEach(function (u) { UNIT_NAME[u.id] = u.name; });

  var MAX_FILES = 5;
  var MAX_BYTES = 20 * 1024 * 1024;
  var STAFF_MAX_FAIL = 3;           // C14
  var ADMIN_MAX_FAIL = 5;
  var ADMIN_LOCK_MS = 15 * 60 * 1000;
  var SIG_MAX_CHARS = 45000;

  // C2
  function today(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now || new Date());
  }
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function addDays(d, n) {
    var t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }

  // 依 C1 順序整理單位陣列，過濾未知代號
  function normUnits(list) {
    return UNIT_IDS.filter(function (id) { return (list || []).indexOf(id) >= 0; });
  }
  function isAllUnits(list) { return normUnits(list).length === UNIT_IDS.length; }

  // C10：p = {published, offOn, expiresOn, publishOn}
  function status(p, td) {
    td = td || today();
    if (!p.published) {
      var off = p.offOn || td;
      return { state: 'off', offDate: off, month: off.slice(0, 7) };
    }
    if (p.expiresOn && p.expiresOn < td) {
      return { state: 'off', offDate: p.expiresOn, month: p.expiresOn.slice(0, 7) };
    }
    if (p.publishOn > td) return { state: 'plan', offDate: null, month: null };
    return { state: 'on', offDate: null, month: null };
  }

  // 置頂優先，其次上架日新到舊，再以 id 新到舊
  function sortBoard(a, b) {
    return (Number(!!b.pinned) - Number(!!a.pinned)) ||
      String(b.publishOn).localeCompare(String(a.publishOn)) ||
      String(b.id).localeCompare(String(a.id));
  }
  // 歷史區：下架日新到舊
  function sortHistory(a, b, td) {
    return String(status(b, td).offDate).localeCompare(String(status(a, td).offDate)) ||
      String(b.id).localeCompare(String(a.id));
  }

  // C3
  function maskName(n) {
    var c = Array.from(String(n || '').trim());
    if (c.length <= 1) return c.join('');
    if (c.length === 2) return c[0] + 'O';
    return c[0] + new Array(c.length - 1).join('O') + c[c.length - 1];
  }

  // C9：回傳 null（可用）、'BAD_REQ'（格式錯）、'WEAK_PIN'（太好猜）
  function pinProblem(pin) {
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return 'BAD_REQ';
    if (/^(\d)\1{3}$/.test(pin)) return 'WEAK_PIN';
    if ('0123456789'.indexOf(pin) >= 0 || '9876543210'.indexOf(pin) >= 0) return 'WEAK_PIN';
    return null;
  }

  // C11
  var EXT_TYPE = { pdf: 'pdf', doc: 'docx', docx: 'docx', xls: 'xlsx', xlsx: 'xlsx' };
  var TYPE_MIME = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  function fileExt(name) {
    var m = /\.([^.]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function fileType(name) { return EXT_TYPE[fileExt(name)] || null; }
  function fileMime(name) { return TYPE_MIME[fileExt(name)] || null; }

  // list = [{name,size}]；回傳 [{name, code}]，空陣列＝全部通過
  function checkFiles(list) {
    var errs = [];
    (list || []).forEach(function (f, i) {
      if (!fileType(f.name)) errs.push({ name: f.name, code: 'BAD_TYPE' });
      else if (!(f.size > 0) || f.size > MAX_BYTES) errs.push({ name: f.name, code: 'TOO_BIG' });
      else if (i >= MAX_FILES) errs.push({ name: f.name, code: 'TOO_MANY' });
    });
    return errs;
  }

  // 公告表單驗證：回傳 null 或錯誤訊息（中文，給前端直接顯示）
  function postProblem(d) {
    if (!d || !String(d.title || '').trim()) return '請填標題';
    if (String(d.title).trim().length > 60) return '標題最多 60 字';
    if (!normUnits(d.units).length) return '請選擇顯示單位';
    if (!isDate(d.publishOn)) return '請填上架日';
    if (d.expiresOn && !isDate(d.expiresOn)) return '到期日格式錯誤';
    if (d.expiresOn && d.expiresOn < d.publishOn) return '到期日不能早於上架日';
    if ((d.files || []).length > MAX_FILES) return '附件最多 ' + MAX_FILES + ' 個';
    return null;
  }

  function fmtMD(d) { if (!d) return ''; var p = d.split('-'); return (+p[1]) + '/' + (+p[2]); }
  function fmtYM(m) { var p = m.split('-'); return p[0] + ' 年 ' + (+p[1]) + ' 月'; }
  function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  return {
    UNITS: UNITS, UNIT_IDS: UNIT_IDS, UNIT_NAME: UNIT_NAME,
    MAX_FILES: MAX_FILES, MAX_BYTES: MAX_BYTES, SIG_MAX_CHARS: SIG_MAX_CHARS,
    STAFF_MAX_FAIL: STAFF_MAX_FAIL, ADMIN_MAX_FAIL: ADMIN_MAX_FAIL, ADMIN_LOCK_MS: ADMIN_LOCK_MS,
    today: today, isDate: isDate, addDays: addDays, normUnits: normUnits, isAllUnits: isAllUnits,
    status: status, sortBoard: sortBoard, sortHistory: sortHistory,
    maskName: maskName, pinProblem: pinProblem,
    fileExt: fileExt, fileType: fileType, fileMime: fileMime, checkFiles: checkFiles, postProblem: postProblem,
    fmtMD: fmtMD, fmtYM: fmtYM, fmtSize: fmtSize
  };
})();

if (typeof module !== 'undefined') module.exports = DZYB;
