#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 切換後效能量測（#10 步驟 9、驗收「效能」）
 *
 * (a) 伺服器端：從伺服器 stdout 紀錄（launchd 寫到 $DATA_DIR/logs/server.log）算各動作處理時間的 p50／p95。
 *     紀錄每請求一行：`<ISO 時間> <action> <毫秒>ms <ok|錯誤碼>`（server/index.js logLine，不含參數）。
 *       node server/latency.js "$DATA_DIR/logs/server.log"                    # 預設看 board、ack，門檻 p95 < 200ms
 *       node server/latency.js --since 2026-10-01T07:00:00Z --actions board,ack,roster server.log
 *       node server/latency.js --hours 24 server.log
 * (b) 端到端：把 curl 的「http_code time_total」（一行一次）餵進來，算中位數與 90 百分位（門檻：中位數 < 1 秒、p90 < 1.5 秒）。
 *       for i in $(seq 30); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -X POST -H 'Content-Type: text/plain' \
 *         --data '{"action":"roster"}' "$URL"; done | node server/latency.js --values
 *     空行略過；http_code 不是 200（連不上時 curl 印 000）或耗時 ≤ 0 的算「失敗」，不進百分位、另外列出。
 *     只要有 1 次失敗、或成功次數少於 --expect（預設 30），就不算達標。也接受只有秒數的舊格式（沒有 http_code 時只看耗時 > 0）。
 * 百分位用「最近排名法」（nearest-rank：排序後取第 ceil(p×n) 個），30 筆的 p90＝第 27 個。
 * 結束碼：0＝全部達標；1＝有未達標或沒有資料；2＝用法錯誤。 */
'use strict';
const fs = require('fs');

function pct(sorted, p) { if (!sorted.length) return null; return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]; }
function median(sorted) { const n = sorted.length; if (!n) return null; return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; }

const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ([A-Za-z-]{1,32}) (\d+)ms (\S+)$/;
// 從紀錄文字算：{ action: { n, p50, p95, max, errors } }；只算成功（ok）的請求，錯誤另計
function fromLog(text, o) {
  o = o || {};
  const acts = o.actions || null, since = o.since ? Date.parse(o.since) : -Infinity, by = {};
  String(text).split('\n').forEach((l) => {
    const m = LINE.exec(l.trim());
    if (!m || Date.parse(m[1]) < since) return;
    if (acts && acts.indexOf(m[2]) < 0) return;
    const a = by[m[2]] || (by[m[2]] = { ms: [], errors: 0 });
    if (m[4] === 'ok') a.ms.push(Number(m[3])); else a.errors++;
  });
  const out = {};
  Object.keys(by).sort().forEach((k) => {
    const s = by[k].ms.sort((x, y) => x - y);
    out[k] = { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.length ? s[s.length - 1] : null, errors: by[k].errors };
  });
  return out;
}
function fromValues(text) {
  const ok = [], failed = [];
  String(text).split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
    const t = l.split(/\s+/), code = t.length >= 2 ? t[0] : null, sec = Number(t[t.length - 1]);
    if ((code !== null && code !== '200') || !Number.isFinite(sec) || sec <= 0) failed.push(l); else ok.push(sec);
  });
  const s = ok.sort((a, b) => a - b);
  return { n: s.length, failed: failed.length, failedLines: failed.slice(0, 5), median: median(s), p90: pct(s, 0.9), max: s.length ? s[s.length - 1] : null };
}
// 達標判定（--values）：沒有任何失敗、成功次數 ≥ expect、中位數 < 1 秒、p90 < 1.5 秒
function valuesPass(r, expect) { return r.failed === 0 && r.n >= expect && r.median < 1 && r.p90 < 1.5; }

function main() {
  const a = process.argv.slice(2), o = { actions: ['board', 'ack'], limit: 200, files: [], expect: 30 };
  const num = (flag, v) => { const n = Number(v); if (!(v !== undefined && Number.isFinite(n) && n > 0)) { console.log(`✗ ${flag} 後面要接正數`); process.exit(2); } return n; };
  let values = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--values') values = true;
    else if (a[i] === '--actions') o.actions = String(a[++i] || '').split(',').filter(Boolean);
    else if (a[i] === '--since') o.since = a[++i];
    else if (a[i] === '--hours') o.since = new Date(Date.now() - num('--hours', a[++i]) * 3600e3).toISOString();
    else if (a[i] === '--limit') o.limit = num('--limit', a[++i]);
    else if (a[i] === '--expect') o.expect = num('--expect', a[++i]);
    else if (a[i].startsWith('--')) { console.log('✗ 不認得的參數 ' + a[i]); process.exit(2); }
    else o.files.push(a[i]);
  }
  const text = o.files.length ? o.files.map((f) => fs.readFileSync(f, 'utf8')).join('\n') : fs.readFileSync(0, 'utf8');
  if (values) {
    const r = fromValues(text), ok = valuesPass(r, o.expect);
    if (r.failed) console.log(`❌ 失敗 ${r.failed} 次（http_code 不是 200 或耗時 0，例如：${r.failedLines.join('｜')}）`);
    if (r.n < o.expect) console.log(`❌ 成功只有 ${r.n} 次，少於要求的 ${o.expect} 次`);
    if (!r.n) process.exit(1);
    console.log(`端到端成功 ${r.n} 次、失敗 ${r.failed} 次：中位數 ${r.median.toFixed(3)} 秒、90 百分位 ${r.p90.toFixed(3)} 秒、最慢 ${r.max.toFixed(3)} 秒 → ${ok ? '✅ 達標' : '❌ 未達標'}（0 失敗、≥${o.expect} 次、中位數 < 1、p90 < 1.5）`);
    process.exit(ok ? 0 : 1);
  }
  const r = fromLog(text, o);
  let bad = 0;
  o.actions.forEach((k) => {
    const x = r[k];
    if (!x || !x.n) { bad++; console.log(`❌ ${k}：沒有成功的請求紀錄`); return; }
    const ok = x.p95 < o.limit;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${k}：${x.n} 次，p50 ${x.p50}ms、p95 ${x.p95}ms、最慢 ${x.max}ms${x.errors ? `（另有 ${x.errors} 次錯誤回應）` : ''}（門檻 p95 < ${o.limit}ms）`);
  });
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { fromLog, fromValues, valuesPass, pct, median };
