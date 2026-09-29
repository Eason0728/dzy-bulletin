/* 鼎兆元｜電子佈告欄 — /health 燈號判定（#8「監看判定」寫死在這裡；給 #10 的守門與 /health 的 level 共用同一份規則）
 * 輸入：/health 的 { mirror:{ at, ok, sigPending, fails }, backup:{ at, ok }, disk:{ freeMB } }；輸出 { level, why }。
 *   紅：mirror.at 距今 > 6 小時（或從沒跑過）、backup.at 距今 > 26 小時（或從沒跑過）
 *   黃：mirror.at 距今 > 3 小時、mirror 連續失敗 ≥ 2 次、backup.ok=false、diskFreeMB < 5000、mirror.sigPending > 200
 *   「/health 打不通或非 200 → 紅」由守門自己判（打不通就拿不到這份）。
 * why 只放固定短句（不帶任何錯誤原文）。純函式，無副作用。 */
'use strict';

const H = 3600e3;
const RULES = { mirrorYellowH: 3, mirrorRedH: 6, backupRedH: 26, mirrorFailYellow: 2, diskYellowMB: 5000, pendingYellow: 200 };

function judgeHealth(h, nowMs) {
  const now = nowMs || Date.now(), red = [], yellow = [];
  const age = (at) => { const t = Date.parse(at || ''); return isNaN(t) ? Infinity : (now - t) / H; };
  const m = h && h.mirror, b = h && h.backup, freeMB = h && h.disk ? h.disk.freeMB : null;
  const ma = age(m && m.at), ba = age(b && b.at);
  if (ma > RULES.mirrorRedH) red.push(m ? '鏡像超過 6 小時沒跑' : '沒有鏡像紀錄');
  else if (ma > RULES.mirrorYellowH) yellow.push('鏡像超過 3 小時沒跑');
  if (ba > RULES.backupRedH) red.push(b ? '快照超過 26 小時沒跑' : '沒有快照紀錄');
  if (m && Number(m.fails) >= RULES.mirrorFailYellow) yellow.push('鏡像連續失敗');
  if (b && b.ok === false) yellow.push('快照失敗');
  if (typeof freeMB === 'number' && freeMB < RULES.diskYellowMB) yellow.push('磁碟剩餘不足 5GB');
  if (m && Number(m.sigPending) > RULES.pendingYellow) yellow.push('待回填簽名超過 200 張');
  return { level: red.length ? 'red' : yellow.length ? 'yellow' : 'green', why: red.concat(yellow) };
}

module.exports = { judgeHealth, RULES };
