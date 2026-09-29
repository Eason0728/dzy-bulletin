#!/bin/sh
# 把共用邏輯複製成 GAS 檔並檢查語法。改完 js/logic.js 或 gas/*.js 後、clasp push 前執行。
set -e
cd "$(dirname "$0")/.."
{ echo "/* 自動產生：來源 js/logic.js，請勿手改（執行 tools/build.sh 重建） */"; cat js/logic.js; } > gas/Logic.js
for f in gas/*.js js/*.js; do node --check "$f"; done
# test/server.test.js 會自己開暫存埠與暫存資料夾啟動真伺服器（含 10 秒阻塞測試），不需先手動起伺服器
for t in test/*.test.js; do node "$t"; done
grep -n "VERSION" js/config.js gas/Code.js | grep -o "'[0-9.]*'" | sort -u | awk 'END{ if (NR!=1) { print "✗ 前後端版本號不一致"; exit 1 } else print "版本號一致" }'
V=$(grep -o "VERSION: '[0-9.]*'" js/config.js | grep -o "[0-9.]*[0-9]")
sed -i '' -E "s/\?v=[0-9.]+\"/?v=$V\"/g" index.html
echo "index.html 快取版本號：$V（$(grep -c "?v=$V" index.html) 處）"
echo "build OK"
