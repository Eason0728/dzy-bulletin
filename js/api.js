/* 呼叫後端：cloud＝fetch GAS（text/plain 避開 preflight）；local＝本機假後端。一律回傳 C12 格式，不丟例外。 */
'use strict';
var API = (function () {
  function timeoutOf(action) { return CFG.TIMEOUT[action] || CFG.TIMEOUT._default; }

  var RETRY = { roster: 1, board: 1, history: 1, adminData: 1, receipts: 1, login: 1, setPin: 1 };   // 可安全重試：唯讀動作＋登入（設密碼重試若已成功會回 HAS_PIN，畫面改走登入）
  function call(action, payload) {
    return once(action, payload).then(function (r) {
      // 唯讀動作：逾時（NET）或 Google 回錯誤網頁（BAD_RESP，多見於冷啟動）都自動重試一次
      if (!r.ok && (r.code === 'NET' || r.code === 'BAD_RESP') && RETRY[action] && CFG.MODE === 'cloud') return once(action, payload);
      return r;
    }).then(function (r) {
      if (!r.ok && r.code === 'BAD_RESP') r.code = 'SERVER';   // 對外仍是 C12 的 SERVER
      return r;
    });
  }
  function once(action, payload) {
    var req = Object.assign({}, payload || {}, { action: action });
    if (CFG.MODE === 'local') return window.DZYB_MOCK.call(action, req);
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutOf(action));
    return fetch(CFG.GAS_URL, {
      method: 'POST', body: JSON.stringify(req), redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.text(); }).then(function (t) {
      clearTimeout(timer);
      try { var j = JSON.parse(t); if (j && typeof j.ok === 'boolean') return j; } catch (e) {}
      // 留存錯誤網頁片段供診斷（只存標題與前 300 字，不含使用者資料）
      var title = (/<title>([^<]*)<\/title>/i.exec(t) || [])[1] || '';
      UI.store.set('lastBad', JSON.stringify({ at: new Date().toISOString(), action: action, title: title, head: String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) }));
      return { ok: false, code: 'BAD_RESP', message: '後端沒有回正常資料，請稍後再試' };
    }, function (e) {
      clearTimeout(timer);
      var aborted = e && e.name === 'AbortError';
      return { ok: false, code: 'NET', message: aborted ? '網路太慢，這次沒送出去，請再試一次' : '連不上伺服器，請確認網路' };
    });
  }

  // 同仁動作：自動帶憑證；憑證失效就回到選名字
  function staff(action, payload) {
    return call(action, Object.assign({ token: UI.store.get('token') }, payload)).then(function (r) {
      if (!r.ok && r.code === 'AUTH') { UI.store.del('token'); UI.store.del('me'); Staff.logout(r.message); }
      return r;
    });
  }
  // 管理動作：自動帶管理憑證；失效就回到輸入通行碼
  function admin(action, payload) {
    return call(action, Object.assign({ atoken: UI.store.get('atoken') }, payload)).then(function (r) {
      if (!r.ok && r.code === 'AUTH') { UI.store.del('atoken'); Admin.needLogin(r.message); }
      return r;
    });
  }
  return { call: call, staff: staff, admin: admin };
})();
