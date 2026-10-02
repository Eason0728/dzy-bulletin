#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 光復未簽提醒（launchd com.dzy.bulletin.remind，每天 18:00；#26）
 *   小辛辣光復店同仁（staff.src 以 `gf:` 開頭＝光復打卡系統同步進來的）有公告上架滿 3 天還沒簽，
 *   就把「全名＋公告標題」經光復小幫手（訂貨小幫手 @954wknja）的文字候補入口送進光復群組，每天提醒到簽完為止。
 *   小幫手入口：POST { action:'enqueue_text', token, label, text } 到它的 /exec → { ok, queued }。
 *     同一天、同一個 label、同一群組只收一次（GAS 端判重），所以 label 固定 `佈告欄未簽提醒`；手動重跑同一天不會重複洗版。
 *     群組有人說話時用免費 reply 帶出、不吃月額度；18:00 與小幫手 FALLBACK_FROM_HOUR=18 一致。不 @ 人（小幫手沒有同仁的 userId）。
 * 不經 makeSqliteStore（見 job-common.js）：唯讀連線，只做 SELECT。
 *
 * 「上架天數」的定義（台北時間）：N ＝ 今天（L.today()，Asia/Taipei）與上架日（publishOn）的日期差。N ≥ 3 才提醒。
 *   例：10/1 上架 → 10/4 00:00 起提醒（10/3 23:59＝上架 2 天 23 小時，不提醒）。publishOn 是日期、等於上架日 00:00，
 *   所以這與「上架日 00:00 起滿 3×24 小時」是同一條線；程式只用日期差，不算時分。
 * 「目前上架中」沿用 L.status（Service 的 board 用同一個判斷）：state === 'on'＝已到上架日、未過到期日、沒有手動下架。
 * 要不要簽沿用 L.mustSign(staff.unit, post)。已讀＝reads 有 (postId, staffId) 那一列（有沒有簽名圖都算已讀）。
 *
 * 結果寫 DATA_DIR/logs/remind-last.json＝{ at, ok, people, posts, queued, error }；每次一行進 logs/remind.log。
 *   people＝要提醒的人次（同一人兩則公告算 2），posts＝有人未簽的公告則數，queued＝小幫手回的寫入列數（GAS 判重時為 0）。
 * 連線失敗（網路錯誤、逾時、回應不是 JSON）重試 1 次；仍失敗 ok:false、exit 1（佈告欄伺服器是另一個程序，不受影響）。
 *   小幫手明確回 ok:false（例如 token 錯）不重試。
 *
 * 用法：node server/sign-remind.js            （launchd 每天 18:00）
 *       node server/sign-remind.js --dry-run  （只印出訊息內容、不送出、不寫 remind-last.json；不需要先設定 .env 兩個鍵）
 * 環境變數：DATA_DIR  REMIND_ENQUEUE_URL  REMIND_ENQUEUE_TOKEN（server/.env，Eason 親手貼）；
 *   沒設定 → 印出「未設定 REMIND_ENQUEUE_URL／TOKEN，尚未啟用」並 exit 0。REMIND_RETRY_MS（重試前等幾毫秒，預設 5000，只給測試縮短） */
'use strict';
const path = require('path');
const J = require('./job-common.js');
const L = require(path.join(__dirname, '..', 'js', 'logic.js'));

const LAST = 'remind-last.json', LOG = 'remind.log';
const LABEL = '佈告欄未簽提醒';
const MIN_DAYS = 3;
const MAX_CHARS = 4500;                                     // 小幫手寫入候補時截 5000 字（text.slice(0, 5000)），留餘裕
const SITE = 'https://dzy-bulletin.github.io';
const SRC_PREFIX = 'gf:';                                   // gf＝小辛辣光復（cf＝央廚、js＝墨竹亭金山）
const TIMEOUT_SEC = 60;                                     // 小幫手 Apps Script 冷啟動＋寫試算表，60 秒很寬

// 日期差（兩個 YYYY-MM-DD，以 UTC 午夜計，不受夏令時間影響；台灣也沒有）
function daysBetween(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400e3); }

// 從資料庫取資料（唯讀）。posts／staff 存的是 JSON，reads 只要 (postId, staffId)
function loadData(dir) {
  const db = J.openDb(dir, { readOnly: true });
  try {
    const posts = J.rows(db, 'SELECT json FROM posts ORDER BY rowid').map((r) => JSON.parse(r.json));
    const staff = J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => JSON.parse(r.json));
    const reads = J.rows(db, 'SELECT postId, staffId FROM reads');
    return { posts, staff, reads };
  } finally { db.close(); }
}

// 純函式：算出要提醒的名單，依公告分組 → [{ id, title, days, names:[…] }]
function pending(data, td) {
  const done = new Set(data.reads.map((r) => r.postId + '\t' + r.staffId));
  const people = data.staff.filter((s) => s.active && String(s.src || '').indexOf(SRC_PREFIX) === 0);
  return data.posts
    .filter((p) => L.status(p, td).state === 'on' && L.isDate(p.publishOn) && daysBetween(p.publishOn, td) >= MIN_DAYS)
    .sort(L.sortBoard)
    .map((p) => ({
      id: p.id, title: String(p.title || '').trim(), days: daysBetween(p.publishOn, td),
      names: people.filter((s) => L.mustSign(s.unit, p) && !done.has(p.id + '\t' + s.id)).map((s) => s.name)
    }))
    .filter((g) => g.names.length > 0);
}

// 訊息本文；超過 MAX_CHARS 就截斷中間的名單並加「…等」，第一行與最後的網址一定留著
function buildText(groups) {
  const head = '📋 佈告欄未簽提醒', foot = `請到 ${SITE} 簽名，謝謝！`;
  const body = groups.map((g) => `《${g.title}》上架 ${g.days} 天：${g.names.join('、')}`).join('\n');
  const full = head + '\n' + body + '\n' + foot;
  if (full.length <= MAX_CHARS) return full;
  const room = MAX_CHARS - head.length - foot.length - 2 - '…等'.length;
  return head + '\n' + body.slice(0, room).replace(/[、\n]+$/, '') + '…等\n' + foot;
}

// 打小幫手一次：網路錯誤／逾時／回應不是 JSON → e.retry＝true；小幫手回 ok:false → 不重試
async function postOnce(url, payload) {
  let text;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
      redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_SEC * 1000) });
    text = await res.text();
  } catch (e) {
    const x = new Error((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? '連線小幫手逾時' : '連不上小幫手：' + (e && e.message));
    x.retry = true; throw x;
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { const x = new Error('小幫手回應不是 JSON'); x.retry = true; throw x; }
  if (!j || !j.ok) throw new Error('小幫手拒收：' + String((j && j.error) || '未知原因').slice(0, 100));   // 只留對方的短句，不會含我們的 token
  return j;
}

async function runRemind(o) {
  const dir = o.dir, td = L.today(o.now || new Date());
  const res = { at: new Date().toISOString(), ok: false, people: 0, posts: 0, queued: 0 };
  let groups, text;
  try {
    groups = pending(loadData(dir), td);
    res.posts = groups.length;
    res.people = groups.reduce((n, g) => n + g.names.length, 0);
    text = groups.length ? buildText(groups) : '';
  } catch (e) {
    res.error = J.errText(e);
    if (!o.dryRun) J.writeLast(dir, LAST, res);
    J.logLine(dir, LOG, '讀取資料失敗：' + res.error);
    return res;
  }
  if (o.dryRun) {
    console.log(text || `（${td}：沒有人需要提醒，不會送出）`);
    res.ok = true; res.dryRun = true; res.text = text;   // 只回給呼叫端（測試用），--dry-run 不寫結果檔
    J.logLine(dir, LOG, `試跑（--dry-run，未送出）：${res.posts} 則公告、${res.people} 人次`);
    return res;
  }
  if (!groups.length) {
    res.ok = true;
    J.writeLast(dir, LAST, res);
    J.logLine(dir, LOG, `${td} 沒有人需要提醒，不送出`);
    return res;
  }
  const payload = { action: 'enqueue_text', token: o.token, label: LABEL, text };
  try {
    let r;
    try { r = await postOnce(o.url, payload); }
    catch (e) {
      if (!e.retry) throw e;
      J.logLine(dir, LOG, e.message + '，重試一次');
      await new Promise((ok) => setTimeout(ok, o.retryMs >= 0 ? o.retryMs : 5000));
      r = await postOnce(o.url, payload);
    }
    res.queued = Number(r.queued) || 0;
    res.ok = true;
  } catch (e) { res.error = J.errText(e); }
  J.writeLast(dir, LAST, res);
  J.logLine(dir, LOG, (res.ok ? '已送進小幫手候補' : '送出失敗') + `：${res.posts} 則公告、${res.people} 人次、寫入 ${res.queued} 列` + (res.ok ? (res.queued ? '' : '（今天已送過，小幫手判重）') : '；' + res.error));
  return res;
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.REMIND_ENQUEUE_URL || '', token = process.env.REMIND_ENQUEUE_TOKEN || '';
  if (!dryRun && (!url || !token)) { console.log('未設定 REMIND_ENQUEUE_URL／TOKEN，尚未啟用'); process.exit(0); }
  const retryMs = process.env.REMIND_RETRY_MS === undefined ? 5000 : Number(process.env.REMIND_RETRY_MS);
  const res = await runRemind({ dir: J.dataDir(process.env), url, token, dryRun, retryMs });
  if (!dryRun) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(J.errText(e)); process.exit(1); });
module.exports = { runRemind, pending, buildText, daysBetween, LABEL, MAX_CHARS };
