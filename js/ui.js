/* 共用畫面元件：面板、提示、檔案檢視、儲存 */
'use strict';
var UI = (function () {
  var $ = function (id) { return document.getElementById(id); };
  var locked = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(t) {
    var el = $('toast'); el.textContent = t; el.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }
  // 面板：lock=true 時點遮罩不會關
  function sheet(html, lock) {
    locked = !!lock;
    var s = $('sheet'); s.innerHTML = html; s.scrollTop = 0;
    $('mask').classList.add('show');
    s.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeSheet; });
    return s;
  }
  function closeSheet() {
    $('mask').classList.remove('show');
    if (typeof Staff !== 'undefined') Staff.onSheetClosed();
  }
  function sheetOpen() { return $('mask').classList.contains('show'); }
  $('mask').onclick = function (e) { if (e.target.id === 'mask' && !locked) closeSheet(); };

  // 按鈕送出中：停用並顯示秒數，完成後還原
  function busy(btn, label) {
    if (!btn) return function () {};
    var orig = btn.textContent, t0 = Date.now();
    btn.disabled = true; btn.textContent = label || '處理中…';
    var iv = setInterval(function () { var s = Math.floor((Date.now() - t0) / 1000); if (s >= 3) btn.textContent = (label || '處理中…') + ' ' + s + ' 秒'; }, 1000);
    return function () { clearInterval(iv); btn.disabled = false; btn.textContent = orig; };
  }

  function ficon(type) {
    return '<span class="ficon ' + esc(type) + '">' + (type === 'docx' ? 'DOC' : type === 'xlsx' ? 'XLS' : 'PDF') + '</span>';
  }
  function fileRow(f, attr, extra) {
    return '<button class="file" ' + (attr || '') + '>' + ficon(f.type) + '<span class="fn">' + esc(f.name) +
      '</span><span class="fs">' + DZYB.fmtSize(f.size) + '</span>' + (extra || '') + '</button>';
  }

  // 附件檢視：cloud＝Drive 預覽器（已禁止下載）；local＝本機上傳的 PDF 或示意畫面
  function view(f) {
    $('vname').textContent = f.name;
    var body = $('vbody');
    body.innerHTML = '';
    if (CFG.MODE === 'cloud') {
      var fr = document.createElement('iframe');
      fr.src = 'https://drive.google.com/file/d/' + encodeURIComponent(f.id) + '/preview';
      fr.setAttribute('allow', 'autoplay');
      body.appendChild(fr);
    } else {
      var blob = window.DZYB_MOCK && DZYB_MOCK.blobOf(f.id);
      if (blob && f.type === 'pdf') {
        var fr2 = document.createElement('iframe'); fr2.src = blob + '#toolbar=0'; body.appendChild(fr2);
      } else {
        body.innerHTML = '<div class="page"><h4></h4>' + Array.from({ length: 14 }, function (_, i) {
          return '<div class="ln" style="width:' + (60 + (i * 37) % 40) + '%"></div>';
        }).join('') + '</div><div class="hint" style="color:#aaa;text-align:center">（本機假資料：示意畫面。正式版以 Google Drive 預覽器顯示真實內容）</div>';
        body.querySelector('h4').textContent = f.name;
      }
    }
    $('viewer').classList.add('show');
  }
  $('vclose').onclick = function () { $('viewer').classList.remove('show'); $('vbody').innerHTML = ''; };
  $('viewer').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // localStorage 一律 try/catch（LINE、無痕模式可能丟例外）；鍵名前綴 dzyb_（契約 C13）
  var store = {
    get: function (k) { try { return localStorage.getItem('dzyb_' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('dzyb_' + k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('dzyb_' + k); } catch (e) {} }
  };

  function fmtTime(isoStr) {
    if (!isoStr) return '';
    return new Date(isoStr).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fatal(msg) { $('app').innerHTML = '<div class="errbox"></div>'; $('app').firstChild.textContent = msg; }

  return { $: $, esc: esc, toast: toast, sheet: sheet, closeSheet: closeSheet, sheetOpen: sheetOpen, busy: busy,
    ficon: ficon, fileRow: fileRow, view: view, store: store, fmtTime: fmtTime, fatal: fatal };
})();
