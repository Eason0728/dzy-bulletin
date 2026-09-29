/* 鼎兆元｜電子佈告欄 — 服務層：API 契約（spec 第五節）的唯一實作
 * 本機假後端（js/mock.js）與 GAS（gas/Code.js）都呼叫這一份，只換 store／files／auth／clock。
 * store: getPosts() savePost(p) getStaff() saveStaff(s) getReads() addRead(r) addLog(e) getAdmin() setAdmin(a) secret()
 * files: upload(name,mime,b64) share(ids) revoke(ids) quota()
 * clock: { nowMs(), today() } */
'use strict';

function makeService_(L, store, files, auth, clock) {
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function iso() { return new Date(clock.nowMs()).toISOString(); }
  function log(action, target, summary) { store.addLog({ at: iso(), action: action, target: target || '', summary: summary || '' }); }

  function findStaff(id) {
    var s = store.getStaff().filter(function (x) { return x.id === id; })[0];
    if (!s || !s.active) throw err('NOT_FOUND', '找不到這位同仁');
    return s;
  }
  function findPost(id) {
    var p = store.getPosts().filter(function (x) { return x.id === id; })[0];
    if (!p) throw err('NOT_FOUND', '找不到這則公告');
    return p;
  }
  function me(s) { return { id: s.id, name: s.name, unit: s.unit }; }
  function staffOf(req) {
    var id = auth.staffIdOf(req.token);
    var s = store.getStaff().filter(function (x) { return x.id === id; })[0];
    if (!auth.verifyStaffToken(store.secret(), req.token, s)) throw err('AUTH', '請重新選擇你的名字');
    return s;
  }
  function requireAdmin(req) {
    var a = store.getAdmin();
    if (!auth.verifyAdminToken(store.secret(), req.atoken, a.ver, clock.nowMs())) throw err('AUTH', '請重新輸入管理通行碼');
    return a;
  }
  function withStatus(p, td) { var o = Object.assign({}, p); o.status = L.status(p, td); return o; }
  function myReadIds(sid) {
    return store.getReads().filter(function (r) { return r.staffId === sid; }).map(function (r) { return r.postId; });
  }
  function myReadAt(sid) {
    var o = {}; store.getReads().forEach(function (r) { if (r.staffId === sid) o[r.postId] = r.at; }); return o;
  }
  function targets(p) {
    return store.getStaff().filter(function (s) { return s.active && p.units.indexOf(s.unit) >= 0; });
  }
  function nextId(prefix, list, width) {
    var n = 0;
    list.forEach(function (x) { if (x.id.indexOf(prefix) === 0) n = Math.max(n, parseInt(x.id.slice(prefix.length), 10) || 0); });
    var s = String(n + 1); while (s.length < width) s = '0' + s;
    return prefix + s;
  }

  var H = {
    roster: function () {
      return store.getStaff().filter(function (s) { return s.active; }).map(function (s) {
        return { id: s.id, name: L.maskName(s.name), unit: s.unit, hasPin: !!s.pinHash, locked: (Number(s.fail) || 0) >= L.STAFF_MAX_FAIL };
      });
    },
    setPin: function (q) {
      var s = findStaff(q.staffId);
      if (s.pinHash) throw err('HAS_PIN', '已經設定過密碼');
      var bad = L.pinProblem(q.pin);
      if (bad) throw err(bad, bad === 'WEAK_PIN' ? '太好猜了（如 1111、1234），請換一組' : '請輸入 4 位數字');
      s.salt = auth.newSalt(); s.pinHash = auth.hashPin(s.salt, q.pin); s.pinVer = (Number(s.pinVer) || 0) + 1; s.fail = 0;
      store.saveStaff(s);
      return { token: auth.makeStaffToken(store.secret(), s.id, s.pinVer), me: me(s) };
    },
    login: function (q) {
      var s = findStaff(q.staffId);
      if (!s.pinHash) throw err('BAD_REQ', '尚未設定密碼');
      var r = auth.staffLogin(s, String(q.pin || ''));
      if (r.fail !== (Number(s.fail) || 0)) { s.fail = r.fail; store.saveStaff(s); }
      if (!r.ok) {
        var e = err(r.code, r.code === 'LOCKED' ? '密碼錯誤太多次，已鎖定' : '密碼錯誤（還可以試 ' + r.left + ' 次）');
        e.left = r.left; throw e;
      }
      return { token: auth.makeStaffToken(store.secret(), s.id, s.pinVer), me: me(s) };
    },
    board: function (q) {
      var s = staffOf(q), td = clock.today();
      var posts = store.getPosts().map(function (p) { return withStatus(p, td); })
        .filter(function (p) { return p.status.state === 'on'; }).sort(L.sortBoard);
      return { today: td, me: me(s), posts: posts, myReads: myReadAt(s.id) };
    },
    history: function (q) {
      var s = staffOf(q), td = clock.today();
      var posts = store.getPosts().filter(function (p) { return L.status(p, td).state === 'off'; })
        .sort(function (a, b) { return L.sortHistory(a, b, td); }).map(function (p) { return withStatus(p, td); });
      return { today: td, posts: posts, myReads: myReadAt(s.id) };
    },
    ack: function (q) {
      var s = staffOf(q), p = findPost(q.postId);
      if (L.status(p, clock.today()).state !== 'on') throw err('BAD_REQ', '這則公告已下架');
      if (p.units.indexOf(s.unit) < 0) throw err('BAD_REQ', '這則公告不需要你簽名');
      var sig = String(q.sig || '');
      if (sig.indexOf('data:image/') !== 0 || sig.length > L.SIG_MAX_CHARS) throw err('BAD_REQ', '簽名格式錯誤');
      if (myReadIds(s.id).indexOf(p.id) >= 0) throw err('ALREADY', '你已經簽過這則公告');
      var at = iso();
      store.addRead({ postId: p.id, staffId: s.id, name: s.name, unit: s.unit, at: at, sig: sig });
      return { at: at };
    },
    adminLogin: function (q) {
      var a = store.getAdmin();
      if (!a.hash) {
        if (!a.init) throw err('AUTH', '管理通行碼尚未設定');
        a.salt = auth.newSalt(); a.hash = auth.hashPin(a.salt, String(a.init)); a.init = ''; a.ver = Number(a.ver) || 1;
        store.setAdmin(a);
      }
      var r = auth.adminLogin(a, String(q.pass || ''), clock.nowMs());
      a.fail = r.st.fail; a.lockUntil = r.st.lockUntil; store.setAdmin(a);
      if (!r.ok) {
        var e = err(r.code, r.code === 'ADMIN_LOCKED' ? '錯誤太多次，請 15 分鐘後再試' : '通行碼錯誤');
        e.until = r.until; throw e;
      }
      return { atoken: auth.makeAdminToken(store.secret(), a.ver, clock.nowMs() + 12 * 3600e3) };
    },
    adminData: function (q) {
      requireAdmin(q);
      var td = clock.today(), reads = store.getReads();
      var posts = store.getPosts().map(function (p) {
        var o = withStatus(p, td), tg = targets(p);
        var ids = {}; tg.forEach(function (s) { ids[s.id] = 1; });
        o.readCount = reads.filter(function (r) { return r.postId === p.id && ids[r.staffId]; }).length;
        o.targetCount = tg.length;
        return o;
      });
      var staff = store.getStaff().filter(function (s) { return s.active; }).map(function (s) {
        return { id: s.id, name: s.name, unit: s.unit, hasPin: !!s.pinHash, locked: (Number(s.fail) || 0) >= L.STAFF_MAX_FAIL };
      });
      var quota = null;
      try { quota = files.quota(); } catch (e) { quota = null; }
      return { today: td, posts: posts, staff: staff, quota: quota };
    },
    receipts: function (q) {
      requireAdmin(q);
      var p = findPost(q.postId), reads = store.getReads().filter(function (r) { return r.postId === p.id; });
      var byId = {}; reads.forEach(function (r) { byId[r.staffId] = r; });
      var rows = targets(p).map(function (s) {
        var r = byId[s.id]; delete byId[s.id];
        return { staffId: s.id, name: s.name, unit: s.unit, active: true, read: !!r, at: r ? r.at : null, sig: r ? r.sig : null };
      });
      Object.keys(byId).forEach(function (k) {           // 已刪除或已換單位但簽過的人：紀錄保留、不計入人數
        var r = byId[k]; rows.push({ staffId: r.staffId, name: r.name, unit: r.unit, active: false, read: true, at: r.at, sig: r.sig });
      });
      return { rows: rows };
    },
    uploadFile: function (q) {
      requireAdmin(q);
      var type = L.fileType(q.name), mime = L.fileMime(q.name);
      if (!type) throw err('BAD_TYPE', '只接受 Word／PDF／Excel');
      var size = Math.floor(String(q.data || '').length * 3 / 4);
      if (!(size > 0) || size > L.MAX_BYTES + 3) throw err('TOO_BIG', '單檔不能超過 20MB');
      return files.upload(String(q.name), mime, String(q.data));
    },
    savePost: function (q) {
      requireAdmin(q);
      var d = q.post || {};
      var bad = L.postProblem(d); if (bad) throw err('BAD_REQ', bad);
      var fl = (d.files || []).map(function (f) { return { id: String(f.id), name: String(f.name), type: L.fileType(f.name) || f.type, size: Number(f.size) || 0 }; });
      var now = iso(), p;
      if (d.id) {
        p = findPost(d.id);
        var keep = {}; fl.forEach(function (f) { keep[f.id] = 1; });
        var removed = (p.files || []).filter(function (f) { return !keep[f.id]; }).map(function (f) { return f.id; });
        if (removed.length) files.revoke(removed);
      } else {
        var day = clock.today().replace(/-/g, '');
        p = { id: nextId('P-' + day + '-', store.getPosts(), 3), published: true, offOn: '', createdAt: now };
      }
      p.title = String(d.title).trim(); p.body = String(d.body || ''); p.units = L.normUnits(d.units);
      p.publishOn = d.publishOn; p.expiresOn = d.expiresOn || ''; p.pinned = !!d.pinned; p.files = fl; p.updatedAt = now;
      if (fl.length) files.share(fl.map(function (f) { return f.id; }));
      store.savePost(p);
      log(d.id ? '編輯' : '上架', p.id, p.title);
      return { post: withStatus(p, clock.today()) };
    },
    setPublished: function (q) {
      requireAdmin(q);
      var p = findPost(q.postId), td = clock.today();
      if (q.on) {
        if (p.expiresOn && p.expiresOn < td) throw err('BAD_REQ', '已過到期日，請先編輯延後到期日');
        p.published = true; p.offOn = '';
      } else { p.published = false; p.offOn = td; }
      p.updatedAt = iso(); store.savePost(p);
      log(q.on ? '重新上架' : '下架', p.id, p.title);
      return { post: withStatus(p, td) };
    },
    setPinned: function (q) {
      requireAdmin(q);
      var p = findPost(q.postId); p.pinned = !!q.on; p.updatedAt = iso(); store.savePost(p);
      log(q.on ? '置頂' : '取消置頂', p.id, p.title);
      return { post: withStatus(p, clock.today()) };
    },
    staffAdd: function (q) {
      requireAdmin(q);
      var name = String(q.name || '').trim();
      if (!name || name.length > 20) throw err('BAD_REQ', '請填姓名（20 字內）');
      if (L.UNIT_IDS.indexOf(q.unit) < 0) throw err('BAD_REQ', '單位錯誤');
      var all = store.getStaff();
      if (all.some(function (s) { return s.active && s.name === name && s.unit === q.unit; })) throw err('BAD_REQ', '此單位已有同名同仁');
      var s = { id: nextId('S-', all, 3), name: name, unit: q.unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: iso(), deletedAt: '' };
      store.saveStaff(s); log('新增同仁', s.id, name + '（' + L.UNIT_NAME[s.unit] + '）');
      return { staff: { id: s.id, name: s.name, unit: s.unit, hasPin: false, locked: false } };
    },
    staffDelete: function (q) {
      requireAdmin(q);
      var s = findStaff(q.staffId); s.active = false; s.deletedAt = iso(); store.saveStaff(s);
      log('刪除同仁', s.id, s.name); return {};
    },
    staffResetPin: function (q) {
      requireAdmin(q);
      var s = findStaff(q.staffId); s.pinHash = ''; s.salt = ''; s.pinVer = (Number(s.pinVer) || 0) + 1; s.fail = 0; store.saveStaff(s);
      log('重設密碼', s.id, s.name); return {};
    },
    changePass: function (q) {
      var a = requireAdmin(q);
      if (!auth.safeEq(auth.hashPin(a.salt, String(q.oldPass || '')), a.hash)) throw err('AUTH', '目前的通行碼錯誤');
      if (String(q.newPass || '').length < 4) throw err('BAD_REQ', '新通行碼至少 4 碼');
      a.salt = auth.newSalt(); a.hash = auth.hashPin(a.salt, String(q.newPass)); a.ver = (Number(a.ver) || 1) + 1; a.fail = 0; a.lockUntil = 0;
      store.setAdmin(a); log('變更通行碼', '', '');
      return { atoken: auth.makeAdminToken(store.secret(), a.ver, clock.nowMs() + 12 * 3600e3) };
    }
  };

  // 回傳 C12 格式；不讓內部錯誤訊息外洩
  function call(action, req) {
    try {
      if (!Object.prototype.hasOwnProperty.call(H, action)) throw err('BAD_REQ', '未知的動作');
      return { ok: true, data: H[action](req || {}) };
    } catch (e) {
      if (e && e.code) {
        var o = { ok: false, code: e.code, message: e.message };
        if (e.left !== undefined) o.left = e.left;
        if (e.until) o.until = e.until;
        return o;
      }
      return { ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試', debug: String(e && e.message || e) };
    }
  }
  return { call: call, WRITE_ACTIONS: ['setPin', 'login', 'ack', 'adminLogin', 'uploadFile', 'savePost', 'setPublished', 'setPinned', 'staffAdd', 'staffDelete', 'staffResetPin', 'changePass'] };
}

if (typeof module !== 'undefined') module.exports = { makeService_: makeService_ };
