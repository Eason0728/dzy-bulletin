/* 鼎兆元｜電子佈告欄 — Google 橋接（Mac mini 伺服器 → 既有 Apps Script）
 * 附件（Drive，保住禁止下載）、打卡名單、搬遷匯出、每日鏡像與備份，這些需要 Google 的動作交給 Apps Script 代辦。
 * 全部 async（Node 內建 fetch）：橋接打的是會排隊 1.7～72 秒的 Apps Script，絕不能卡住事件迴圈（#6 審查發現 1）。
 * Service.js 是同步的，所以由 index.js 在進 Service 之前或之後 await 這裡，再用每請求的墊片把結果交給 Service。
 * fetch 跟隨 Apps Script 的 302 時 POST 會轉成 GET，與原本 curl -L 行為相同（Apps Script 就是這樣回結果），不是 bug。 */
'use strict';

function bridgeErr(message, code) { const e = new Error(message); e.code = code || 'SERVER'; return e; }

function makeBridge(url, key) {
  async function call(op, payload, timeoutSec) {
    if (!url || !key) throw bridgeErr('未設定 Google 橋接');
    const body = JSON.stringify(Object.assign({ action: 'bridge', key, op }, payload || {}));
    let text;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body,
        redirect: 'follow', signal: AbortSignal.timeout((timeoutSec || 60) * 1000) });
      text = await res.text();
    } catch (e) { throw bridgeErr('Google 橋接逾時或連不上'); }
    let j;
    try { j = JSON.parse(text); } catch (e) { throw bridgeErr('Google 橋接回應格式錯誤'); }
    if (!j.ok) throw bridgeErr(j.message || 'Google 橋接失敗', j.code);
    return j.data;
  }
  return {
    kind: 'real',
    call,
    files: {
      upload: (name, mime, b64) => call('upload', { name, mime, data: b64 }, 180),
      share: async (ids) => { await call('share', { ids }, 90); },
      revoke: async (ids) => { try { await call('revoke', { ids }, 90); } catch (e) { console.error('revoke: ' + e.message); } },
      quota: () => call('quota', {}, 30)
    },
    clockSrc: { read: () => call('clock', {}, 90) }
  };
}

// 測試用：不連 Google 的假橋接（附件存在記憶體）。delayMs＞0 時每個橋接動作都延遲（阻塞測試用）；calls() 回傳各動作呼叫次數。
function makeFakeBridge(delayMs) {
  const blobs = {}; let seq = 0; let clock = { rows: [], errors: [], sources: ['gf', 'cf', 'js'], counts: {} };
  const calls = { upload: 0, share: 0, revoke: 0, quota: 0, clock: 0 };
  const typeOf = (n) => ({ pdf: 'pdf', doc: 'docx', docx: 'docx', xls: 'xlsx', xlsx: 'xlsx' })[String(n).split('.').pop().toLowerCase()] || null;
  const wait = () => (delayMs > 0 ? new Promise((ok) => setTimeout(ok, delayMs)) : Promise.resolve());
  const op = (name, fn) => async (...a) => { calls[name]++; await wait(); return fn(...a); };
  return {
    kind: 'fake',
    call: async () => { throw new Error('fake'); },
    files: {
      upload: op('upload', (name, mime, b64) => { const id = 'F-' + (++seq); blobs[id] = 'data:' + mime + ';base64,' + b64; return { id, name, type: typeOf(name), size: Math.floor(b64.length * 3 / 4) }; }),
      share: op('share', () => {}),
      revoke: op('revoke', (ids) => ids.forEach((i) => delete blobs[i])),
      quota: op('quota', () => ({ limit: 16106127360, usage: 7935000000 }))
    },
    clockSrc: { read: op('clock', () => JSON.parse(JSON.stringify(clock))) },
    getClock: () => JSON.parse(JSON.stringify(clock)),
    setClock: (rows) => {
      const n = (src) => rows.filter((r) => r.src === src && r.active).length;
      clock = { rows, errors: [], sources: ['gf', 'cf', 'js'], counts: { '小辛辣光復店': n('gf'), '央廚': n('cf'), '墨竹亭金山店': n('js') } };
    },
    blobOf: (id) => blobs[id] || null,
    calls: () => Object.assign({}, calls)
  };
}

module.exports = { makeBridge, makeFakeBridge };
