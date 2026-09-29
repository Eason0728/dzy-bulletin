/* 鼎兆元｜電子佈告欄 — Google 橋接（Mac mini 伺服器 → 既有 Apps Script）
 * 附件（Drive，保住禁止下載）、打卡名單、搬遷匯出、每日鏡像與備份，這些需要 Google 的動作交給 Apps Script 代辦。
 * Service.js 是同步呼叫，所以這裡用 curl 同步送出（只有主管偶爾的動作會走到，期間其他請求排隊，行為同 GAS 的 ScriptLock）。 */
'use strict';
const { execFileSync } = require('child_process');

function makeBridge(url, key) {
  function call(op, payload, timeoutSec) {
    if (!url || !key) { const e = new Error('未設定 Google 橋接'); e.code = 'SERVER'; throw e; }
    const body = JSON.stringify(Object.assign({ action: 'bridge', key, op }, payload || {}));
    let out;
    try {
      out = execFileSync('curl', ['-sL', '--max-time', String(timeoutSec || 60), '-H', 'Content-Type: text/plain;charset=utf-8',
        '--data-binary', '@-', url], { input: body, maxBuffer: 300 * 1024 * 1024 });
    } catch (e) { const x = new Error('Google 橋接逾時或連不上'); x.code = 'SERVER'; throw x; }
    let j;
    try { j = JSON.parse(out.toString('utf8')); } catch (e) { const x = new Error('Google 橋接回應格式錯誤'); x.code = 'SERVER'; throw x; }
    if (!j.ok) { const x = new Error(j.message || 'Google 橋接失敗'); x.code = j.code || 'SERVER'; throw x; }
    return j.data;
  }
  return {
    call,
    files: {
      upload: (name, mime, b64) => call('upload', { name, mime, data: b64 }, 180),
      share: (ids) => { call('share', { ids }, 90); },
      revoke: (ids) => { try { call('revoke', { ids }, 90); } catch (e) { console.error('revoke: ' + e.message); } },
      quota: () => call('quota', {}, 30)
    },
    clockSrc: { read: () => call('clock', {}, 90) }
  };
}

// 測試用：不連 Google 的假橋接（附件存在記憶體）
function makeFakeBridge() {
  const blobs = {}; let seq = 0; let clock = { rows: [], errors: [], sources: ['gf', 'cf', 'js'], counts: {} };
  const typeOf = (n) => ({ pdf: 'pdf', doc: 'docx', docx: 'docx', xls: 'xlsx', xlsx: 'xlsx' })[String(n).split('.').pop().toLowerCase()] || null;
  return {
    call: () => { throw new Error('fake'); },
    files: {
      upload: (name, mime, b64) => { const id = 'F-' + (++seq); blobs[id] = 'data:' + mime + ';base64,' + b64; return { id, name, type: typeOf(name), size: Math.floor(b64.length * 3 / 4) }; },
      share: () => {}, revoke: (ids) => ids.forEach((i) => delete blobs[i]),
      quota: () => ({ limit: 16106127360, usage: 7935000000 })
    },
    clockSrc: { read: () => JSON.parse(JSON.stringify(clock)) },
    setClock: (rows) => {
      const n = (src) => rows.filter((r) => r.src === src && r.active).length;
      clock = { rows, errors: [], sources: ['gf', 'cf', 'js'], counts: { '小辛辣光復店': n('gf'), '央廚': n('cf'), '墨竹亭金山店': n('js') } };
    },
    blobOf: (id) => blobs[id] || null
  };
}

module.exports = { makeBridge, makeFakeBridge };
