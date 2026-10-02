/* 鼎兆元｜電子佈告欄 — 新公告上架通知（#28；伺服器內的計時器，不另開 launchd job）
 *   主管上架的公告若是小辛辣光復同仁要簽的（L.mustSign('mala', post) 為真＝單位含小辛辣或「全部」），
 *   就經光復小幫手（訂貨小幫手 @954wknja）**直接 push** 到光復群組（不走候補、吃小幫手每月額度；額度快滿時小幫手自動退回候補）。
 *   小幫手入口：POST { action:'push_text', token, label:'佈告欄新公告:<postId>', text } 到它的 /exec
 *     → { ok:true, mode:'push'|'fallback'|'dup', … }｜{ ok:false, mode:'push', fail }。
 *     小幫手端以 label 永久判重（同一則公告只推一次，跨日也擋），所以這邊重送（逾時後重試）不會重推。
 *   .env 沿用 #26 未簽提醒的兩個鍵（REMIND_ENQUEUE_URL／REMIND_ENQUEUE_TOKEN，見 job-common.js helperEnv）。
 *
 * 時機：伺服器啟動時先跑一次，之後每 ANNOUNCE_EVERY_MS（預設 1 小時）一次。
 *   對象＝L.status(p, today).state==='on'（已到上架日、未到期、沒下架）且 mustSign('mala') 且還沒通知過的公告。
 *   排定未來上架（state 'plan'）的，到上架日那一輪才推。
 * 已通知紀錄放 SQLite kv `announced`＝{ postId: { at, mode } }（mode：push／fallback／dup／init／gaveup）：
 *   - 同一個 postId 只推一次：編輯公告（id 不變）不重推；下架後重新上架也不重推。
 *   - **第一次啟用**（kv 沒有 `announced`）：把現有所有公告（排定未來上架的除外）標成已通知（mode:'init'），不補推舊公告；
 *     印出「首次啟用：已將 N 則現有公告標記為已通知」。排定未來上架的舊公告到上架日照樣會推（對同仁來說那是新公告）。
 * 失敗（連不上、逾時、回應不是 JSON、ok:false）：這一則不標記，下一輪重試；當輪內網路類錯誤先重試一次（同 #26）。
 *   連續失敗次數記在 kv `announceFails`＝{ postId: n }；同一則連續失敗 MAX_FAILS（3）輪就標 mode:'gaveup' 停止重試並記錄。
 * 結果：logs/announce-last.json＝{ at, ok, pending, sent, failed, gaveUp }（/health 只帶 at／ok／pending）；每輪有動作才寫一行 logs/announce.log。
 *   ok＝這一輪沒有任何一則失敗；pending＝這一輪結束後仍待通知的則數（失敗待重試的）。
 * 不卡請求：整段 async，只在 await 之間做同步的 kv 讀寫（不進 store.tx、不持有寫鎖）；同一時間只跑一輪。
 * 環境變數：ANNOUNCE_EVERY_MS（間隔，預設 3600000，只給測試縮短）、ANNOUNCE_RETRY_MS（當輪重試前等幾毫秒，預設 5000）。 */
'use strict';
const path = require('path');
const J = require('./job-common.js');
const L = require(path.join(__dirname, '..', 'js', 'logic.js'));

const ANNOUNCE_EVERY_MS = 3600e3;
const MAX_FAILS = 3;                                        // 每小時一輪 → 約 3 小時後放棄
const MAX_TITLE = 200;
const SITE = 'https://dzy-bulletin.github.io';
const LABEL_PREFIX = '佈告欄新公告:';
const KV_DONE = 'announced', KV_FAILS = 'announceFails';
const LAST = 'announce-last.json', LOG = 'announce.log';

// 訊息本文（標題以碼點截 200 字，不切出孤立代理字元）
function buildText(title) {
  const t = Array.from(String(title || '').trim()).slice(0, MAX_TITLE).join('');
  return `📢 佈告欄新公告\n《${t}》\n請到 ${SITE} 閱讀並簽名`;
}
// 這則公告該不該通知（不看是否已通知）
const eligible = (p, td) => L.status(p, td).state === 'on' && L.mustSign('mala', p);

function readJson(store, k) { try { const o = JSON.parse(store.kvGet(k) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }

// o = { store, dir, url, token, retryMs, now()（測試注入）, log(訊息)（預設 console.log） }
function makeAnnouncer(o) {
  const log = o.log || ((s) => console.log(new Date().toISOString() + ' ' + s));
  const note = (s) => { log(s); try { J.logLine(o.dir, LOG, s); } catch (e) {} };
  let running = null, last = null;

  // 第一次啟用：kv 沒有 announced → 把現有公告（排定未來上架的除外）全標成已通知
  function initIfNeeded(posts, td) {
    if (readJson(o.store, KV_DONE)) return;
    const at = new Date().toISOString(), done = {};
    posts.forEach((p) => { if (L.status(p, td).state !== 'plan') done[p.id] = { at, mode: 'init' }; });
    o.store.kvSet(KV_DONE, JSON.stringify(done));
    note(`首次啟用：已將 ${Object.keys(done).length} 則現有公告標記為已通知`);
  }

  async function runOnce() {
    const td = L.today(o.now ? o.now() : new Date());
    const res = { at: new Date().toISOString(), ok: true, pending: 0, sent: 0, failed: 0, gaveUp: 0 };
    try {
      const posts = o.store.getPosts();
      initIfNeeded(posts, td);
      const done0 = readJson(o.store, KV_DONE) || {};
      const todo = posts.filter((p) => eligible(p, td) && !done0[p.id]).sort(L.sortBoard);
      for (const p of todo) {
        const payload = { action: 'push_text', token: o.token, label: LABEL_PREFIX + p.id, text: buildText(p.title) };
        let r = null, err = null;
        try { r = await J.postHelperRetry(o.url, payload, { retryMs: o.retryMs, onRetry: (m) => note(`《${p.id}》${m}`) }); }
        catch (e) { err = J.errText(e); }
        // await 之後重讀再寫（只有本計時器寫這兩個鍵，同一時間只跑一輪）
        const done = readJson(o.store, KV_DONE) || {}, fails = readJson(o.store, KV_FAILS) || {};
        if (r) {
          done[p.id] = { at: new Date().toISOString(), mode: String(r.mode || 'push') };
          delete fails[p.id];
          res.sent++;
          note(`已通知 ${p.id}（${done[p.id].mode}）`);
        } else {
          const n = (Number(fails[p.id]) || 0) + 1;
          res.ok = false; res.failed++;
          if (n >= MAX_FAILS) {
            done[p.id] = { at: new Date().toISOString(), mode: 'gaveup', error: err };
            delete fails[p.id];
            res.gaveUp++;
            note(`通知 ${p.id} 連續失敗 ${n} 次，停止重試：${err}`);
          } else {
            fails[p.id] = n;
            res.pending++;
            note(`通知 ${p.id} 失敗（第 ${n} 次，下一輪重試）：${err}`);
          }
        }
        o.store.kvSet(KV_DONE, JSON.stringify(done));
        o.store.kvSet(KV_FAILS, JSON.stringify(fails));
      }
    } catch (e) {
      res.ok = false; res.error = J.errText(e);
      note('新公告通知這一輪出錯：' + res.error);
    }
    last = res;
    try { J.writeLast(o.dir, LAST, res); } catch (e) {}
    return res;
  }

  return {
    // 同一時間只跑一輪：上一輪還沒跑完（小幫手很慢）就沿用那一輪
    run: () => running || (running = runOnce().finally(() => { running = null; })),
    last: () => last,
    health: () => (last ? { at: last.at, ok: last.ok, pending: last.pending } : null)
  };
}

// 伺服器用：沒設定 .env 兩個鍵 → 不啟動（印一行說明）；E2E 不啟動。啟動時先跑一次，之後每 everyMs 一次。
function startAnnouncer(o) {
  if (o.e2e) return null;
  if (!o.url || !o.token) { console.log('新公告通知：未設定 REMIND_ENQUEUE_URL／TOKEN，不啟動'); return null; }
  const a = makeAnnouncer(o);
  const every = o.everyMs > 0 ? o.everyMs : ANNOUNCE_EVERY_MS;
  a.run();
  a.timer = setInterval(() => { a.run(); }, every);
  console.log(new Date().toISOString() + ` 新公告通知：已啟動（每 ${Math.round(every / 60e3 * 10) / 10} 分鐘一次）`);
  return a;
}

module.exports = { makeAnnouncer, startAnnouncer, buildText, eligible, ANNOUNCE_EVERY_MS, MAX_FAILS, MAX_TITLE, LABEL_PREFIX, KV_DONE, KV_FAILS };
