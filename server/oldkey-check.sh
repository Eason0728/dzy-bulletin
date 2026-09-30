#!/bin/sh
set +x   # 絕不可用 sh -x 執行或除錯：trace 會把金鑰印出來
# 鼎兆元｜電子佈告欄 — 換 BRIDGE_KEY 時確認「舊金鑰已失效」（CUTOVER.md 第 7 步）
# 時機：Eason 已經把新金鑰貼進 GAS 指令碼屬性、還沒換 server/.env（這時 .env 裡的就是舊金鑰）。
# 用法（Mac mini、repo 根目錄）：sh server/oldkey-check.sh            # 預設讀 server/.env
#                                sh server/oldkey-check.sh <env 檔>   # 測試用
# 金鑰與網址從 .env 讀，用 shell 內建 printf 經 stdin 送出：不出現在任何程序的指令列、環境變數，也不印出來。
# 不加 -X POST：--data 本身就是 POST，Apps Script /exec 回 302 轉到只收 GET 的 echo 網址時，curl 才會照規矩改用 GET
# （加了 -X POST 轉址後仍用 POST，永遠拿不到 JSON；與 server/bridge.js 開頭的說明同一件事）。
# 結束碼：0＝回 AUTH（舊金鑰已失效，通過）；1＝回 ok:true（舊金鑰仍有效）；2＝讀不到 .env 設定；
#         3＝其他回應，或 .env 有多行 BRIDGE_KEY（停下，看原文）
ENVF="${1:-$(dirname "$0")/.env}"
# 多行 BRIDGE_KEY：伺服器（server/index.js loadEnv）只取第一行，這裡若照抄會把兩把接成一串送出、一定回 AUTH → 誤判通過，所以直接拒絕
NK="$(grep -c '^BRIDGE_KEY=' "$ENVF" 2>/dev/null)"
if [ "${NK:-0}" -gt 1 ]; then echo "✗ $ENVF 有 $NK 行 BRIDGE_KEY（伺服器只讀第一行，無法判斷要驗哪一把）。請 Eason 整理成只剩一行後再跑。"; exit 3; fi
# 去掉引號與 CR（Windows 換行的 .env 伺服器讀得到，腳本也要讀得到）
K="$(sed -n 's/^BRIDGE_KEY=//p' "$ENVF" 2>/dev/null | head -1 | tr -d "\"'\r")"
W="$(sed -n 's/^BRIDGE_URL=//p' "$ENVF" 2>/dev/null | head -1 | tr -d "\"'\r")"
if [ -z "$K" ] || [ -z "$W" ]; then echo "✗ 讀不到 $ENVF 的 BRIDGE_KEY／BRIDGE_URL（不做判定）"; exit 2; fi
# -sS：錯誤訊息（連不上、逾時）照樣收進 OUT 印出來；curl 的錯誤訊息只含網址與原因，不含送出的內容（金鑰）
OUT="$(printf '{"action":"bridge","key":"%s","op":"quota"}' "$K" | curl -sSL --max-time 90 -H 'Content-Type: text/plain' --data @- "$W" 2>&1)"
K=''; unset K W
if printf '%s' "$OUT" | grep -Eq '"code" *: *"AUTH"'; then
  echo '✅ 回 AUTH：舊金鑰已失效，通過。接著請 Eason 把新金鑰貼進 server/.env。'; exit 0
elif printf '%s' "$OUT" | grep -Eq '"ok" *: *true'; then
  echo '❌ 回正常結果：舊金鑰仍然有效。請 Eason 確認 GAS 指令碼屬性 BRIDGE_KEY 有沒有存到（存完再跑一次）。'; exit 1
else
  echo '✗ 其他回應（不是 AUTH 也不是正常結果），停下來，把下面原文貼給 MacBook 的 Claude：'
  printf '%s\n' "$OUT" | head -c 400; echo; exit 3
fi
