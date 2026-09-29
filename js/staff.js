/* 同仁端：選名字／密碼、公告、歷史區、內容頁、簽名 */
'use strict';
var Staff = (function () {
  var L = DZYB, $ = UI.$, esc = UI.esc;
  var FORGOT = '請主管到「設定 → 同仁名單」按「重設密碼」，你下次選名字時就能設定新密碼。';
  var v = { tab: 'board', unit: null, month: null, board: null, hist: null, loading: false, error: null };

  function me() { try { return JSON.parse(UI.store.get('me')); } catch (e) { return null; } }
  function loggedIn() { return !!(UI.store.get('token') && me()); }

  function start() {
    $('foot').textContent = '鼎兆元｜電子佈告欄 v' + CFG.VERSION + (CFG.MODE === 'local' ? '（本機假資料）' : '');
    if (CFG.MODE === 'local') {
      $('demoBar').hidden = false;
      $('resetDemo').onclick = function () { if (confirm('重置所有假資料？')) { DZYB_MOCK.reset(); clearMe(); location.reload(); } };
      $('testMe').onclick = function () { DZYB_MOCK.testerReset(); clearMe(); v.board = v.hist = null; UI.toast('測試員的密碼與簽名已清除'); picker(true, 'mala'); };
    }
    $('openAdmin').onclick = function () { Admin.open(); };
    if (loggedIn()) loadBoard(); else picker(true);
  }
  function clearMe() { UI.store.del('token'); UI.store.del('me'); renderMe(); $('app').innerHTML = ''; }
  function logout(msg) { clearMe(); v.board = v.hist = null; if (msg) UI.toast(msg); picker(true); }
  function onSheetClosed() {
    if (!loggedIn()) setTimeout(function () { picker(true); }, 0);
    else if (typeof Admin !== 'undefined' && Admin.takeDirty()) loadBoard();
  }

  function renderMe() {
    var m = me(), bar = $('meBar');
    if (!m || !UI.store.get('token')) { bar.innerHTML = ''; return; }
    bar.innerHTML = '👤 <span id="meName"></span> <button id="chgMe">不是我</button>';
    $('meName').textContent = m.name + '（' + L.STAFF_UNIT_NAME[m.unit] + '）';
    $('chgMe').onclick = function () { logout(); };
  }

  /* ---------- 選名字與密碼 ---------- */
  function picker(force, unit) {
    var lock = force === true;
    UI.sheet('<div class="bar"><b>請選擇你是誰</b>' + (lock ? '' : '<button data-close>取消</button>') + '</div><div class="body"><div class="loading">載入名單中</div></div>', lock);
    API.call('roster').then(function (r) {
      if (!r.ok) {
        var es = UI.sheet('<div class="bar"><b>請選擇你是誰</b></div><div class="body"><div class="errbox"></div><button class="btn primary" id="rt">重試</button>' +
          '<button class="btn ghost" id="toAdmin" style="margin-top:8px">⚙ 主管設定</button></div>', true);
        es.querySelector('.errbox').textContent = r.message;
        es.querySelector('#rt').onclick = function () { picker(force, unit); };
        es.querySelector('#toAdmin').onclick = function () { Admin.open(); };
        return;
      }
      var GROUPS = L.UNITS.concat([{ id: 'hq', name: '總部' }]);
      var grp = function (u) { return u.indexOf('hq-') === 0 ? 'hq' : u; };
      var people = r.data, cur = unit || (me() && grp(me().unit)) || v.unit || 'mala';
      function draw() {
        var list = people.filter(function (s) { return grp(s.unit) === cur; });
        var s = UI.sheet('<div class="bar"><b>請選擇你是誰</b>' + (lock ? '' : '<button data-close>取消</button>') + '</div><div class="body">' +
          '<div class="hint" style="margin:0 0 10px">選自己的名字並輸入 4 位數密碼（第一次使用會請你設定）。這支手機會記住你，按「我已閱讀」時會請你手寫簽名。</div>' +
          '<div class="seg">' + GROUPS.map(function (u) { return '<button data-pu="' + u.id + '" class="' + (u.id === cur ? 'on' : '') + '">' + u.name + '</button>'; }).join('') + '</div>' +
          '<div class="picklist">' + (list.map(function (p) { return '<button data-pick="' + esc(p.id) + '">' + esc(p.name) + (p.locked ? ' 🔒' : '') + (cur === 'hq' ? '<br><small style="color:var(--sub);font-weight:400">' + L.STAFF_UNIT_NAME[p.unit].replace('總部', '') + '</small>' : '') + '</button>'; }).join('') || '<div class="hint" style="grid-column:1/-1">這個單位還沒有同仁名單</div>') + '</div>' +
          '<div class="hint" style="margin-top:14px">找不到自己的名字？請洽主管在「設定 → 同仁名單」新增。</div>' +
          '<button class="btn ghost" id="toAdmin" style="margin-top:6px">⚙ 主管設定</button></div>', lock);
        s.querySelector('#toAdmin').onclick = function () { Admin.open(); };
        s.querySelectorAll('[data-pu]').forEach(function (b) { b.onclick = function () { cur = b.dataset.pu; draw(); }; });
        s.querySelectorAll('[data-pick]').forEach(function (b) {
          b.onclick = function () { pinForm(people.filter(function (p) { return p.id === b.dataset.pick; })[0], function () { draw(); }); };
        });
      }
      draw();
    });
  }

  function pinInput(id, ph) { return '<input class="inp pinbox" id="' + id + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="' + ph + '">'; }

  function pinForm(p, back) {
    var title = p.locked ? '已鎖定' : p.hasPin ? '輸入密碼' : '設定個人密碼';
    var body;
    if (p.locked) body = '<div class="content" style="margin-top:0">密碼錯誤太多次，已鎖定。' + FORGOT + '</div><button class="btn ghost" id="pfBack2">我知道了</button>';
    else if (p.hasPin) body = '<div class="hint" style="margin:0 0 10px" id="pfWho"></div>' + pinInput('pv', '請輸入 4 位數密碼') +
      '<div class="err" id="pfErr"></div><div style="height:12px"></div><button class="btn primary" id="pfGo">進入</button>' +
      '<div style="height:10px"></div><button class="btn ghost" id="pfForgot">忘記密碼？</button>';
    else body = '<div class="hint" style="margin:0 0 10px" id="pfWho"></div><label class="f">輸入 4 位數密碼</label>' + pinInput('p1', '••••') +
      '<label class="f">再輸入一次</label>' + pinInput('p2', '••••') + '<div class="err" id="pfErr"></div><div style="height:12px"></div><button class="btn primary" id="pfGo">設定並進入</button>';
    var s = UI.sheet('<div class="bar"><b>' + title + '</b><button id="pfBack">返回</button></div><div class="body">' + body + '</div>', true);
    s.querySelector('#pfBack').onclick = back;
    if (p.locked) { s.querySelector('#pfBack2').onclick = back; return; }
    s.querySelector('#pfWho').textContent = p.name + '（' + L.STAFF_UNIT_NAME[p.unit] + '）' + (p.hasPin ? '' : '你好，第一次使用請設定 4 位數密碼，之後換手機時要輸入。');
    var err = s.querySelector('#pfErr'), go = s.querySelector('#pfGo');
    if (p.hasPin) {
      s.querySelector('#pfForgot').onclick = function () {
        var f = UI.sheet('<div class="bar"><b>忘記密碼</b><button id="fgBack">返回</button></div><div class="body"><div class="content" style="margin-top:0">' + FORGOT + '</div><button class="btn ghost" id="fgOk">我知道了</button></div>', true);
        f.querySelector('#fgBack').onclick = function () { pinForm(p, back); };
        f.querySelector('#fgOk').onclick = back;
      };
      var submit = function () {
        var done = UI.busy(go, '驗證中…');
        API.call('login', { staffId: p.id, pin: s.querySelector('#pv').value }).then(function (r) {
          done();
          if (r.ok) return enter(r.data);
          if (r.code === 'LOCKED') { p.locked = true; return pinForm(p, back); }
          err.textContent = r.message; s.querySelector('#pv').value = '';
        });
      };
      go.onclick = submit;
      s.querySelector('#pv').onkeydown = function (e) { if (e.key === 'Enter') submit(); };
      setTimeout(function () { var el = s.querySelector('#pv'); if (el) el.focus(); }, 50);
    } else {
      go.onclick = function () {
        var a = s.querySelector('#p1').value, b = s.querySelector('#p2').value;
        var bad = L.pinProblem(a);
        if (bad === 'BAD_REQ') { err.textContent = '請輸入 4 位數字'; return; }
        if (bad === 'WEAK_PIN') { err.textContent = '太好猜了（如 1111、1234），請換一組'; return; }
        if (a !== b) { err.textContent = '兩次輸入不一樣'; return; }
        var done = UI.busy(go, '設定中…');
        API.call('setPin', { staffId: p.id, pin: a }).then(function (r) {
          done();
          if (r.ok) return enter(r.data);
          if (r.code === 'HAS_PIN') { p.hasPin = true; return pinForm(p, back); }
          err.textContent = r.message;
        });
      };
      setTimeout(function () { var el = s.querySelector('#p1'); if (el) el.focus(); }, 50);
    }
  }

  function enter(d) {
    UI.store.set('token', d.token); UI.store.set('me', JSON.stringify(d.me));
    v.unit = L.homeTab(d.me.unit); v.tab = 'board'; v.board = v.hist = null;
    UI.closeSheet(); UI.toast('你好，' + d.me.name); loadBoard();
  }

  /* ---------- 公告與歷史 ---------- */
  function loadBoard() {
    renderMe(); v.loading = true; v.error = null; render();
    API.staff('board').then(function (r) {
      v.loading = false;
      if (!r.ok) { if (r.code !== 'AUTH') { v.error = r.message; render(); } return; }
      v.board = r.data; UI.store.set('me', JSON.stringify(r.data.me)); renderMe();
      if (!v.unit) v.unit = L.homeTab(r.data.me.unit);
      render();
    });
  }
  function loadHistory() {
    v.loading = true; v.error = null; render();
    API.staff('history').then(function (r) {
      v.loading = false;
      if (!r.ok) { if (r.code !== 'AUTH') { v.error = r.message; render(); } return; }
      v.hist = r.data; render();
    });
  }
  function reads() { return (v.tab === 'hist' ? v.hist : v.board || {}).myReads || {}; }
  function iTarget(p) { var m = me(); return !!m && L.mustSign(m.unit, p); }

  function render() {
    var app = $('app'), m = me();
    if (!m) { app.innerHTML = ''; return; }
    var tabs = L.viewTabs(m.unit), home = L.homeTab(m.unit);
    if (tabs.indexOf(v.unit) < 0) v.unit = home;
    var myR = (v.board && v.board.myReads) || {};
    var unread = function (u) {
      return v.board ? v.board.posts.filter(function (p) { return p.units.indexOf(u) >= 0 && iTarget(p) && !myR[p.id]; }).length : 0;
    };
    var h = '<div class="tabs"><button data-tab="board" class="' + (v.tab === 'board' ? 'on' : '') + '">📌 公告</button>' +
      '<button data-tab="hist" class="' + (v.tab === 'hist' ? 'on' : '') + '">🗂 歷史區</button></div>' +
      '<div class="seg">' + L.UNITS.filter(function (u) { return tabs.indexOf(u.id) >= 0; }).map(function (u) {
        var n = (v.tab === 'board' && u.id === home) ? unread(u.id) : 0;
        return '<button data-unit="' + u.id + '" class="' + (v.unit === u.id ? 'on' : '') + '">' + u.name + (n ? '<span class="n">' + n + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    if (v.loading) h += '<div class="loading">載入中</div>';
    else if (v.error) h += '<div class="errbox" id="errMsg"></div><button class="btn ghost" id="retry">重試</button>';
    else if (v.tab === 'board' && v.board) {
      var list = v.board.posts.filter(function (p) { return p.units.indexOf(v.unit) >= 0; });
      h += list.length ? list.map(card).join('') : '<div class="empty">目前沒有公告</div>';
    } else if (v.tab === 'hist' && v.hist) {
      var arch = v.hist.posts.filter(function (p) { return p.units.indexOf(v.unit) >= 0; });
      var months = arch.map(function (p) { return p.status.month; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).sort().reverse();
      if (months.indexOf(v.month) < 0) v.month = months[0] || null;
      h += '<div class="hint">依下架日期的月份封存</div>';
      if (!months.length) h += '<div class="empty">還沒有封存的公告</div>';
      else h += '<div class="months">' + months.map(function (mm) { return '<button data-month="' + mm + '" class="' + (mm === v.month ? 'on' : '') + '">' + L.fmtYM(mm) + '</button>'; }).join('') + '</div>' +
        arch.filter(function (p) { return p.status.month === v.month; }).map(card).join('');
    }
    app.innerHTML = h;
    if (v.error) { $('errMsg').textContent = v.error; $('retry').onclick = function () { v.tab === 'hist' ? loadHistory() : loadBoard(); }; }
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.onclick = function () { v.tab = b.dataset.tab; if (v.tab === 'hist') loadHistory(); else loadBoard(); };
    });
    app.querySelectorAll('[data-unit]').forEach(function (b) { b.onclick = function () { v.unit = b.dataset.unit; render(); }; });
    app.querySelectorAll('[data-month]').forEach(function (b) { b.onclick = function () { v.month = b.dataset.month; render(); }; });
    app.querySelectorAll('[data-post]').forEach(function (b) { b.onclick = function () { openPost(b.dataset.post); }; });
  }

  function tags(p) {
    return L.isAllUnits(p.units) ? '<span class="tag all">全部</span>' : p.units.map(function (u) { return '<span class="tag ' + u + '">' + L.UNIT_NAME[u] + '</span>'; }).join(' ');
  }
  function card(p) {
    var st = p.status, r = reads()[p.id], on = st.state === 'on';
    var exp = on ? (p.expiresOn ? '到期 ' + L.fmtMD(p.expiresOn) : '不自動下架') : '下架 ' + L.fmtMD(st.offDate);
    return '<button class="card ' + (p.pinned && on ? 'pin' : '') + '" data-post="' + esc(p.id) + '">' +
      (on && iTarget(p) && !r ? '<span class="unread"></span>' : '') + '<h3>' + esc(p.title) + '</h3>' +
      '<div class="meta">' + (p.pinned && on ? '<span class="pinmark">📌 置頂</span>' : '') + tags(p) +
      '<span>上架 ' + L.fmtMD(p.publishOn) + '</span><span>' + exp + '</span>' +
      (p.files.length ? '<span>📎 ' + p.files.length + '</span>' : '') + (r ? '<span class="readok">✓ 已讀</span>' : '') + '</div></button>';
  }

  function findPost(id) { var src = v.tab === 'hist' ? v.hist : v.board; return src && src.posts.filter(function (p) { return p.id === id; })[0]; }

  function openPost(id, justSig) {
    var p = findPost(id); if (!p) return;
    var st = p.status, at = reads()[p.id], foot = '';
    if (st.state === 'on' && iTarget(p)) {
      foot = at ? '<div class="done">✓ 已於 ' + esc(UI.fmtTime(at)) + ' 簽名確認閱讀' + (justSig ? '<div><img src="' + esc(justSig) + '" style="max-width:220px;height:70px;object-fit:contain;background:#fff;border-radius:8px;margin-top:8px"></div>' : '') + '</div>'
        : '<button class="btn primary" id="ackBtn">我已閱讀</button>';
    } else if (st.state === 'off') foot = '<div class="hint" style="text-align:center">此公告已於 ' + L.fmtMD(st.offDate) + ' 下架，僅供查閱</div>';
    var s = UI.sheet('<div class="bar"><b>公告內容</b><button data-close>關閉</button></div><div class="body">' +
      '<div class="meta">' + (p.pinned && st.state === 'on' ? '<span class="pinmark">📌 置頂</span>' : '') + tags(p) + '</div>' +
      '<h2>' + esc(p.title) + '</h2>' +
      '<div class="meta"><span>上架 ' + p.publishOn + '</span><span>' + (st.state === 'off' ? '下架 ' + st.offDate : (p.expiresOn ? '到期 ' + p.expiresOn : '不自動下架')) + '</span></div>' +
      (p.body ? '<div class="content">' + esc(p.body) + '</div>' : '') +
      (p.files.length ? '<div class="meta" style="margin-top:8px">附件（點開線上檢視）</div><div class="files">' + p.files.map(function (f, i) { return UI.fileRow(f, 'data-view="' + i + '"'); }).join('') + '</div>' : '') +
      foot + '</div>');
    s.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { UI.view(p.files[+b.dataset.view]); }; });
    var ack = s.querySelector('#ackBtn');
    if (ack) ack.onclick = function () {
      Sign.open(p, me(), function () { openPost(id); }, function (at2, sig) {
        if (!at2) { UI.closeSheet(); UI.toast('你已經簽過這則公告'); loadBoard(); return; }   // 重複送出：以伺服器紀錄為準
        v.board.myReads[p.id] = at2;
        UI.toast('已簽名確認'); render(); openPost(id, sig);
      });
    };
  }

  return { start: start, logout: logout, onSheetClosed: onSheetClosed, loadBoard: loadBoard, picker: picker, me: me };
})();
