#!/bin/sh
# 把共用邏輯複製成 GAS 檔並檢查語法。改完 js/logic.js 或 gas/*.js 後、clasp push 前執行。
set -e
cd "$(dirname "$0")/.."
{ echo "/* 自動產生：來源 js/logic.js，請勿手改（執行 tools/build.sh 重建） */"; cat js/logic.js; } > gas/Logic.js
for f in gas/*.js js/*.js; do node --check "$f"; done
for t in test/*.test.js; do node "$t"; done
grep -n "VERSION" js/config.js gas/Code.js | grep -o "'[0-9.]*'" | sort -u | awk 'END{ if (NR!=1) { print "✗ 前後端版本號不一致"; exit 1 } else print "版本號一致" }'
echo "build OK"
