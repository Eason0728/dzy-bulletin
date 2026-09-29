# 階段關 Phase 1 — 第 2 次（2026-09-29）
審查者：fresh-context sonnet subagent（範本 5，新開，未看過 r1）
結論：**不通過**（契約逐字元比對、安全、邏輯、前端、測試其餘項目全部通過；build 154 項全過）

| # | 問題 | 嚴重度 | 處理 |
|---|---|---|---|
| 1 | Service.call() 非預期例外回傳多出 `debug` 欄位，違反 C12、可能外洩內部錯誤字串（GAS 的 json_ 雖已剝除，本機假後端仍會回） | 中 | 改程式：Service 不再回傳 debug，改 console.error；Code.js 移除剝除邏輯 |
| 2 | receipts：仍在職但公告編輯後不在公告單位的簽名者被標 `active:false`，前端顯示「已刪除」語意錯誤 | 低 | 改程式：`active` 依同仁實際在職狀態，另加 `inTarget`；前端分別顯示「已刪除」「已不在公告單位」；spec 同步 |
