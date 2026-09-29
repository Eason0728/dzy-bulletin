# 階段關 Phase 1 — 第 1 次（2026-09-29）
審查者：fresh-context sonnet subagent（範本 5）
結論：**不通過**

| # | 問題 | 嚴重度 | 處理 |
|---|---|---|---|
| 1 | Auth.js 沒有 task.md T2 指定的 `applyLoginResult(row, ok)`，實作為 `staffLogin(row, pin)` | 中 | 改契約：驗證與計數放在同一個函式較不易漏寫回，task.md T2 改成 `staffLogin`／`adminLogin` |
| 2 | `adminData` 回傳每則 post 內含 `readCount`/`targetCount`＋`today`，spec 寫的是獨立 `readCounts` | 中 | 改 spec：嵌在 post 內，前端免對照 |
| 3 | `receipts` 回傳 `{rows:[…]}`，spec 寫陣列 | 中 | 改 spec：包一層保留日後擴充欄位 |
| 4 | `changePass` 回傳 `{atoken}`，spec 寫無 | 低 | 改 spec：舊憑證因 ADMIN_VER+1 失效，必須回新憑證 |
| 5 | `savePost` 附件 type 在副檔名無法判斷時信任前端 `f.type` | 低 | **改程式**：副檔名不合法直接拒收 BAD_TYPE，並補測試 |

測試：logic 58／auth 30／service 65 全過；node --check 全過。
