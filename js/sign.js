/* 手寫簽名板：簽完送 ack，成功後回呼 onDone(at) */
'use strict';
var Sign = (function () {
  function open(post, me, onBack, onDone) {
    var s = UI.sheet('<div class="bar"><b>電子簽名</b><button id="sgBack">返回</button></div>' +
      '<div class="body"><div class="hint" style="margin:0 0 8px" id="sgText"></div>' +
      '<canvas id="sgPad" style="width:100%;height:200px;background:#fff;border:2px dashed #cfc7ba;border-radius:12px;touch-action:none;display:block"></canvas>' +
      '<div class="err" id="sgErr"></div>' +
      '<div class="row" style="margin-top:12px"><button class="btn ghost" id="sgClear">清除重簽</button><button class="btn primary" id="sgOk">確認簽名</button></div></div>', true);
    s.querySelector('#sgText').textContent = '我，' + me.name + '，已閱讀並了解「' + post.title + '」的內容。請在下方框內簽名：';
    s.querySelector('#sgBack').onclick = onBack;

    var c = s.querySelector('#sgPad'), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, r.width * dpr); c.height = Math.max(1, r.height * dpr);
    var x = c.getContext('2d');
    x.scale(dpr, dpr); x.lineWidth = 2.6; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#1a1a1a';
    var drawing = false, len = 0, last = null;
    function pt(e) { var b = c.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
    c.onpointerdown = function (e) { drawing = true; last = pt(e); try { c.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); };
    c.onpointermove = function (e) {
      if (!drawing) return;
      var q = pt(e); x.beginPath(); x.moveTo(last.x, last.y); x.lineTo(q.x, q.y); x.stroke();
      len += Math.hypot(q.x - last.x, q.y - last.y); last = q;
    };
    c.onpointerup = c.onpointercancel = function () { drawing = false; };
    s.querySelector('#sgClear').onclick = function () { x.clearRect(0, 0, c.width, c.height); len = 0; };

    var okBtn = s.querySelector('#sgOk');
    okBtn.onclick = function () {
      var errEl = s.querySelector('#sgErr');
      if (len < 40) { errEl.textContent = '請先簽名'; return; }
      // 縮成 360px 寬、白底
      var o = document.createElement('canvas'); o.width = 360; o.height = Math.round(360 * c.height / c.width);
      var ox = o.getContext('2d'); ox.fillStyle = '#fff'; ox.fillRect(0, 0, o.width, o.height); ox.drawImage(c, 0, 0, o.width, o.height);
      var sig = o.toDataURL('image/png');                               // 線條圖用 PNG 最小
      if (sig.length > DZYB.SIG_MAX_CHARS) sig = o.toDataURL('image/jpeg', 0.5);
      var done = UI.busy(okBtn, '送出中…');
      API.staff('ack', { postId: post.id, sig: sig }).then(function (res) {
        done();
        if (res.ok) { onDone(res.data.at, sig); return; }
        if (res.code === 'ALREADY') { onDone(null, null); return; }
        if (res.code !== 'AUTH') errEl.textContent = res.message;
      });
    };
  }
  return { open: open };
})();
