/* 鼎兆元｜電子佈告欄 — 新公告上架通知（#28；伺服器內的計時器，不另開 launchd job）
 *   主管上架的公告若是小辛辣光復同仁要簽的（L.mustSign('mala', post) 為真＝單位含小辛辣或「全部」），
 *   就經光復小幫手（訂貨小幫手 @954wknja）**直接 push** 到光復群組（不走候補、吃小幫手每月額度；額度快滿時小幫手自動退回候補）。
 *   小幫手入口：POST { action:'push_text', token, label:'佈告欄新公告:<postId>', text } 到它的 /exec
 *     → { ok:true, action:'push_text', mode:'push'|'fallback'|'dup', … }｜{ ok:false, action:'push_text', … }。
 *     **只有 ok:true、mode 是 push／fallback／dup、而且帶 action:'push_text' 回聲才算推出**（#29 審查 B1）：
 *     舊版小幫手不認得 push_text 時回裸的 { ok:true }，不能誤記成已推；其他一律算失敗。
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
 * 失敗（連不上、逾時、回應不是 JSON、ok:false、回應不符）：這一則不標記，下一輪重試；當輪內網路類錯誤先重試一次（同 #26）。
 *   失敗次數記在 kv `announceFails`＝{ postId: { n, lastAt } }；**距離上次失敗不到 FAIL_GAP_MS（50 分鐘）的失敗不累加**
 *   （#29 審查 S2：伺服器啟動就跑一輪，重啟或崩潰重起不能幾分鐘內就湊滿次數）。累計 MAX_FAILS（3）次就標 mode:'gaveup' 停止重試並記錄。
 *   放棄後 /health 的 announce.gaveup＞0 會一直黃燈（「有新公告通知已放棄」），直到用 --retry 清掉（#29 審查 S1）。
 * 結果：logs/announce-last.json＝{ at, ok, pending, sent, failed, gaveUp }；/health 帶 { at, ok, pending, gaveup }（gaveup＝kv 裡目前放棄的則數）；
 *   每輪有動作才寫一行 logs/announce.log。ok＝這一輪沒有任何一則失敗；pending＝這一輪結束後仍待通知的則數（失敗待重試的）。
 * 補推（伺服器開著也可以跑；只動 kv 這兩個鍵，計時器每次 await 之後都會重讀，不會蓋回去）：
 *   node server/announce.js --retry <postId>   把這則的放棄標記與失敗計數清掉，下一輪（1 小時內）重新推
 *   node server/announce.js --retry-all        所有放棄的與失敗中的都清掉
 *   小幫手端若其實已推出過，會回 dup，不會重推。
 * 不卡請求：整段 async，只在 await 之間做同步的 kv 讀寫（不進 store.tx、不持有寫鎖）；同一時間只跑一輪。
 * 環境變數：ANNOUNCE_EVERY_MS（間隔，預設 3600000，只給測試縮短）、ANNOUNCE_RETRY_MS（當輪重試前等幾毫秒，預設 5000）。 */
'use strict';
const path = require('path');
const J = require('./job-common.js');
const L = require(path.join(__dirname, '..', 'js', 'logic.js'));

const ANNOUNCE_EVERY_MS = 3600e3;
const MAX_FAILS = 3;                                        // 每小時一輪 → 約 3 小時後放棄
const FAIL_GAP_MS = 50 * 60e3;                              // 距上次失敗不到 50 分鐘不累加（重啟、崩潰重起）
const OK_MODES = new Set(['push', 'fallback', 'dup']);
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

// 小幫手回應是否真的是新版 push_text 的成功回應（舊版回裸的 {ok:true}）
const accepted = (j) => !!(j && j.ok === true && j.action === 'push_text' && OK_MODES.has(j.mode));
// 失敗計數：舊格式（純數字）也讀得懂
const failOf = (v) => (v && typeof v === 'object' ? { n: Number(v.n) || 0, lastAt: Number(v.lastAt) || 0 } : { n: Number(v) || 0, lastAt: 0 });
const gaveupCount = (done) => Object.keys(done || {}).filter((k) => done[k] && done[k].mode === 'gaveup').length;

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
    const nowD = o.now ? o.now() : new Date(), td = L.today(nowD), nowMs = nowD.getTime();
    const res = { at: new Date().toISOString(), ok: true, pending: 0, sent: 0, failed: 0, gaveUp: 0 };
    try {
      const posts = o.store.getPosts();
      initIfNeeded(posts, td);
      const done0 = readJson(o.store, KV_DONE) || {};
      const todo = posts.filter((p) => eligible(p, td) && !done0[p.id]).sort(L.sortBoard);
      for (const p of todo) {
        const payload = { action: 'push_text', token: o.token, label: LABEL_PREFIX + p.id, text: buildText(p.title) };
        let r = null, err = null;
        try {
          r = await J.postHelperRetry(o.url, payload, { retryMs: o.retryMs, onRetry: (m) => note(`《${p.id}》${m}`) });
          if (!accepted(r)) { r = null; throw new Error('小幫手回應不符（沒有 push_text 回聲或 mode，可能還沒部署 push_text 版）'); }
        }
        catch (e) { r = null; err = J.errText(e); }
        // await 之後重讀再寫（只有本計時器寫這兩個鍵，同一時間只跑一輪）
        const done = readJson(o.store, KV_DONE) || {}, fails = readJson(o.store, KV_FAILS) || {};
        if (r) {
          done[p.id] = { at: new Date().toISOString(), mode: String(r.mode || 'push') };
          delete fails[p.id];
          res.sent++;
          note(`已通知 ${p.id}（${done[p.id].mode}` + (Number(r.fail) > 0 ? `，${Number(r.fail)} 個群組失敗` : '') + (r.capped ? '，已達每日 push 上限改走候補' : '') + '）');
        } else {
          const f = failOf(fails[p.id]);
          const counted = !f.lastAt || nowMs - f.lastAt >= FAIL_GAP_MS;   // 50 分鐘內的再次失敗不累加
          const n = counted ? f.n + 1 : f.n;
          res.ok = false; res.failed++;
          if (n >= MAX_FAILS) {
            done[p.id] = { at: new Date().toISOString(), mode: 'gaveup', error: err };
            delete fails[p.id];
            res.gaveUp++;
            note(`通知 ${p.id} 連續失敗 ${n} 次，停止重試：${err}`);
          } else {
            fails[p.id] = { n, lastAt: counted ? nowMs : f.lastAt };
            res.pending++;
            note(`通知 ${p.id} 失敗（第 ${n} 次` + (counted ? '' : '，距上次不到 50 分鐘不累加') + `，下一輪重試）：${err}`);
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
    // gaveup 每次從 kv 算：--retry 清掉後立刻轉回綠燈，不必等下一輪
    health: () => (last ? { at: last.at, ok: last.ok, pending: last.pending, gaveup: gaveupCount(readJson(o.store, KV_DONE)) } : null)
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

// ---- 指令列：--retry <postId>／--retry-all（直接改 kv，不經 makeSqliteStore，見 job-common.js）----
function retry(dir, id) {
  const db = J.openDb(dir);
  try {
    const get = (k) => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); try { return (r && JSON.parse(r.v)) || {}; } catch (e) { return {}; } };
    const put = (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
    const done = get(KV_DONE), fails = get(KV_FAILS), out = [];
    const ids = id ? [id] : Array.from(new Set(Object.keys(done).filter((k) => done[k] && done[k].mode === 'gaveup').concat(Object.keys(fails))));
    ids.forEach((k) => {
      if (done[k] && done[k].mode !== 'gaveup') { out.push(`${k}：已通知過（${done[k].mode}），不動`); return; }
      if (!done[k] && !fails[k]) { out.push(`${k}：沒有放棄或失敗紀錄，不用處理`); return; }
      delete done[k]; delete fails[k];
      out.push(`${k}：已清除，下一輪重新推`);
    });
    db.exec('BEGIN IMMEDIATE');
    try { put(KV_DONE, done); put(KV_FAILS, fails); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return out;
  } finally { db.close(); }
}
function main() {
  const a = process.argv.slice(2), i = a.indexOf('--retry');
  const id = i >= 0 ? String(a[i + 1] || '') : '';
  if (!(a.includes('--retry-all') || (i >= 0 && id && !id.startsWith('--')))) {
    console.log('用法：node server/announce.js --retry <公告ID>｜--retry-all（計時器在伺服器裡，不用單獨執行本檔）'); process.exit(2);
  }
  const dir = J.dataDir(process.env);
  const out = retry(dir, a.includes('--retry-all') ? '' : id);
  const s = out.length ? out.join('\n') : '沒有放棄或失敗中的公告';
  console.log(s); try { J.logLine(dir, LOG, '手動補推：' + out.join('；')); } catch (e) {}
}
if (require.main === module) { try { main(); } catch (e) { console.error(J.errText(e)); process.exit(1); } }

module.exports = { makeAnnouncer, startAnnouncer, buildText, eligible, accepted, retry, ANNOUNCE_EVERY_MS, MAX_FAILS, FAIL_GAP_MS, MAX_TITLE, LABEL_PREFIX, KV_DONE, KV_FAILS };
