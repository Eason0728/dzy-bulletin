/* 手寫簽名板：簽完送 ack，成功後回呼 onDone(at) */
'use strict';
var Sign = (function () {
  function open(post, me, onBack, onDone) {
    var s = UI.sheet('<div class="bar"><b>電子簽名</b><button id="sgBack">返回</button></div>' +
      '<div class="body"><div class="hint" style="margin:0 0 8px" id="sgText"></div>' +
      '<canvas id="sgPad" class="sg-pad"></canvas>' +
      '<div class="err" id="sgErr"></div>' +
      '<div class="row" style="margin-top:12px"><button class="btn ghost" id="sgClear">清除重簽</button><button class="btn primary" id="sgOk">確認簽名</button></div></div>', true);
    // 手機上簽名板佔滿整個畫面（css/app.css 的 .sheet.full，只在窄螢幕生效；電腦維持面板、簽名框加高）
    s.classList.add('full'); UI.$('mask').classList.add('full');
    s.querySelector('#sgText').textContent = '我，' + me.name + '，已閱讀並了解「' + post.title + '」的內容。請在下方框內簽名：';
    // LINE 等 App 內建瀏覽器：簽名時手指移動會帶動背景捲動、工具列伸縮讓視窗高度一直變 → 畫面晃（2026-09-30 回報）。
    // 簽名期間鎖住背景（body 固定在原位置），離開時還原捲動位置。
    var scrollY = window.scrollY || 0, bs = document.body.style;
    bs.position = 'fixed'; bs.top = -scrollY + 'px'; bs.left = '0'; bs.right = '0'; bs.overflow = 'hidden';
    var locked = true;
    function unlock() { if (!locked) return; locked = false; s.classList.remove('full'); UI.$('mask').classList.remove('full'); bs.position = ''; bs.top = ''; bs.left = ''; bs.right = ''; bs.overflow = ''; window.scrollTo(0, scrollY); }
    UI.onLeave(unlock);                                               // 面板被換掉或關閉（例如登入過期跳回選名字）也會解鎖
    s.querySelector('#sgBack').onclick = function () { unlock(); onBack(); };

    var c = s.querySelector('#sgPad'), dpr = window.devicePixelRatio || 1, x = c.getContext('2d');
    var drawing = false, len = 0, last = null;
    function fit() {                                                  // 依目前顯示大小設定畫布解析度（會清空畫布）
      var r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.lineWidth = 2.6; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#1a1a1a';
    }
    fit();
    // 轉向或視窗大小改變：還沒簽就重新對齊；已經簽了就保留筆跡（畫面會等比縮放，不影響送出）
    function onResize() { if (!locked) { window.removeEventListener('resize', onResize); return; } if (len === 0 && !drawing) fit(); }
    window.addEventListener('resize', onResize);
    function pt(e) { var b = c.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
    c.onpointerdown = function (e) { drawing = true; last = pt(e); try { c.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); };
    c.onpointermove = function (e) {
      if (!drawing) return;
      var q = pt(e); x.beginPath(); x.moveTo(last.x, last.y); x.lineTo(q.x, q.y); x.stroke();
      len += Math.hypot(q.x - last.x, q.y - last.y); last = q;
    };
    c.onpointerup = c.onpointercancel = function () { drawing = false; };
    // 有些 WebView 不理會 touch-action:none：直接擋掉簽名框內的觸控捲動（passive:false 才能 preventDefault）
    ['touchstart', 'touchmove'].forEach(function (t) { c.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false }); });
    s.querySelector('#sgClear').onclick = function () { x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.restore(); len = 0; };

    var okBtn = s.querySelector('#sgOk');
    okBtn.onclick = function () {
      var errEl = s.querySelector('#sgErr');
      if (len < 40) { errEl.textContent = '請先簽名'; return; }
      // 縮成最長邊 360px、白底（全螢幕簽名板是直的，只限寬會讓圖變太大，超過 SIG_MAX_CHARS）
      var k = 360 / Math.max(c.width, c.height), o = document.createElement('canvas');
      o.width = Math.max(1, Math.round(c.width * k)); o.height = Math.max(1, Math.round(c.height * k));
      var ox = o.getContext('2d'); ox.fillStyle = '#fff'; ox.fillRect(0, 0, o.width, o.height); ox.drawImage(c, 0, 0, o.width, o.height);
      var sig = o.toDataURL('image/png');                               // 線條圖用 PNG 最小
      if (sig.length > DZYB.SIG_MAX_CHARS) sig = o.toDataURL('image/jpeg', 0.5);
      var done = UI.busy(okBtn, '送出中…');
      API.staff('ack', { postId: post.id, sig: sig }).then(function (res) {
        done();
        if (res.ok) { unlock(); onDone(res.data.at, sig); return; }
        if (res.code === 'ALREADY') { unlock(); onDone(null, null); return; }
        if (res.code !== 'AUTH') errEl.textContent = res.message;
      });
    };
  }
  return { open: open };
})();
