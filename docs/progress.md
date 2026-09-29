# 進度：鼎兆元｜電子佈告欄
- 開案日：2026-09-29
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：結案（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：清除手機實測時的【測試】公告（系統不能刪公告，需在試算表手動刪列）

## Eason 已定案（2026-09-29）
1. 獨立網址（不併入 dzy、不擴充打卡店內公告）
2. 同仁不登入；首次從同仁名單點選自己，手機記住
3. 同仁名單用途＝追蹤誰讀過
4. 要已讀回條
5. 單一通行碼，持有者可上架／下架、管理名單
6. 附件只能在手機上打開看、不能下載；每則最多 5 檔、單檔 20MB；Word／PDF／Excel
7. 上架不發 LINE 通知
8. 單位只有墨竹亭、小辛辣、央廚；「全部」＝三區都出現
9. 到期自動下架；依下架日期的月份封存；同仁可查歷史區；要置頂
10. 「我已閱讀」要手寫電子簽名（2026-09-29 追加）
11. 選「我是誰」要 4 位數個人密碼；忘記可重設（2026-09-29 追加）。Eason 定案：忘記密碼只顯示「請主管到設定→同仁名單按重設密碼」，主管不在同仁手機上輸入通行碼；無自助重設

## ① 查紀錄
- 打卡系統「店內公告」（mala-clock-in，2026-08-28）：120 字純文字、無附件、各店分開 → 不適用
- dzy 集團管理系統：可當模組，但 Eason 選獨立網址（1B）
- 記憶庫、skill 清單、dispatch-resources 無同名佈告欄系統

## 關卡紀錄
> 2026-09-29 起階段關改用 GitHub issue（Eason 指定）：審查員＝fresh-context **Fable**，每輪讀整串 issue、對抗性驗證每條、**直接改寫 issue 本文**，不另開 issue、不再寫 docs/gate/rN.md。Phase 1 彙整於 #1（已關），Phase 2 於 #2。

| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-09-29 | 預覽自測 | preview/index.html 同仁端＋管理端全流程 | 通過（修 2 bug：日期少一天、他單位紅點） | 1 | 內建瀏覽器 JS 點擊驗證，errs=[] |
| 2026-09-29 | 預覽自測 | 個人密碼：設定／驗證／鎖定／忘記重設／主管重設踢登出 | 通過（修：重設後空白頁、focus 空指標） | 2 | 同上，errs=[] |
| 2026-09-29 | 任務關 | T1–T7 | 通過：node 153 項＋瀏覽器 local 全流程（同仁端、管理端）pageerror=0 | 1 | test/*.test.js、內建瀏覽器 JS 驗證 |
| 2026-09-29 | 階段關 | Phase 1（T1–T7） | 不通過：5 處程式與契約不一致（4 改文件、1 改程式） | 1 | docs/gate/phase1-r1.md |
| 2026-09-29 | 階段關 | Phase 1（T1–T7） | 不通過：debug 欄位外洩（中）、回條 active 語意（低），均已改程式＋補測試 | 2 | docs/gate/phase1-r2.md |
| 2026-09-29 | 階段關 | Phase 1（T1–T7） | **通過**；3 項非阻斷建議已處理 | 3 | docs/gate/phase1-r3.md |
| 2026-09-29 | 階段關 | Phase 2（後端＋追加需求） | 不通過：r1 阻斷 3（試算表可被分享、無 flush、純文字格式） | 1 | issue #2 |
| 2026-09-29 | 階段關 | Phase 2 | 不通過：r2 阻斷 1（鎖外 gen 快照→重複簽名） | 2 | issue #2 |
| 2026-09-29 | 階段關 | Phase 2 | 不通過：r3 阻斷 1（savePost reqId 綁面板而非草稿，逾時後修改無聲丟失） | 3 | issue #2 |
| 2026-09-29 | 階段關 | Phase 2 | Eason 選 A（修完審 r4） | — | 對話 |
| 2026-09-29 | 階段關 | Phase 2 | **通過**（r4，Fable）；5 條低度非阻斷另行處理（#20–#23 修、#24 接受） | 4 | issue #2 |
| 2026-09-29 | 任務關 | T12 手機實測 | 通過（Eason 回報：手機已實測） | 1 | Eason 對話 |
| 2026-09-29 | 整套關 | e2e/judge.py（local，真實 Word/PDF/Excel） | 先以 --break sign 證明裁判會 FAIL（38/39，A10 抓到），正常版 39/39 PASS；加入複製未簽名名單後 41/41 PASS | 1 | e2e/judge.py 輸出 |
| 2026-09-29 | 資料帶入測試 | e2e/run.py（data-drive-test：隨機分層資料＋獨立驗算＋按鈕稽核＋假日期跳 4 天） | 通過：種子 20260929／7741／918273／980147512 分別 97／99／112／114 項全過，按鈕 53～57 種全點；途中抓到示範模式黃色條被遮罩蓋住（已修 v0.4.3） | 1 | /tmp 輸出＋e2e/artifacts |
| 2026-09-30 | 審查 | v0.5.0～0.5.3 墨竹亭門市／名單快照／快取／主管 7 天（issue #4） | r1～r3 不通過（阻斷 3→2→1，皆為上一輪修法引入），第 3 輪停下請示 Eason 選 A；**r4 通過** | 4 | issue #4 |

## 落地清單
- [x] 1 排程上線：不適用——系統沒有任何排程（到期下架是讀取時判斷日期）
- [x] 2 掛進監看：不適用——無排程可漏跑；前端錯誤網頁片段存同仁手機 `dzyb_lastBad` 供診斷
- [x] 3 納入故障追蹤：不適用——累犯摘要追的是自動化排程艦隊，本系統無排程
- [x] 4 登錄資源：`~/.claude/mala-ops/dispatch-resources.md`「鼎兆元｜電子佈告欄」列（scriptId、部署 ID @17、repo、網址）
- [x] 5 建 skill 並登錄路由：`~/.claude/skills/dzy-bulletin/SKILL.md`＋CLAUDE.md 路由列＋dispatch-rules 第 42 列＋dispatch-details §42
- [x] 6 寫一則記憶：主庫 `dzy-bulletin-project.md`（另有 `gate-review-github-issue-fable.md`）＋MEMORY.md 索引
- [x] 7 進版控：專案 `dzy-bulletin/dzy-bulletin.github.io`、`~/.claude`（mala-playbook）、`~/.agents`（mala-institution v2 教訓）皆已 push；spike 未被正式程式引用
- [x] 8 回報未完成與等待事項：見 2026-09-29 最後回報

## spike 資源（④ 結束後清理）
- spike GAS：scriptId `1DVAHktjmJOHWVDRLYZnPg5OpI3_CLVhd_osLGC9F6KRq2mtPXroU_wPZ`（madesiaosinla），部署 `AKfycbwjSqM-r4kL8Xep7mejf3rG_W09G1dLveC8DcZy25kF0hT_tzykY759gIlySkRkqICr`
- Drive 測試資料夾「【spike】佈告欄附件測試」已丟垃圾桶、4 個測試檔已取消分享（2026-09-29）

## 正式資源（2026-09-29 建立）
- 正式 GAS：scriptId `13cscE_m0bv7mI4ArvR-EbTTc-bca27coHFxf-cRjjxXN15fvNOqm8RuL`（madesiaosinla），rootDir `gas/`
- 部署 ID：`AKfycbzQXAnMnrYGoUEMDzr6XbtsuIDYyGWbGLcFW1xVDpa64NcBrMzI9GaVKJhIlC-WxnGK5g`（@1）。**之後一律 `clasp deploy -i <此 ID>` 更新，不要建新部署**（會換網址）
- 等 Eason：窗格登入設定→按「從打卡系統同步」做真環境測試

- GitHub：repo `dzy-bulletin/dzy-bulletin.github.io`（組織 dzy-bulletin，public），網址 **https://dzy-bulletin.github.io**（2026-09-29 由 Eason0728/dzy-bulletin 轉移改名；舊網址已 404）
- 打卡同步來源 ID 放 `gas/Config.local.js`（gitignore，只經 clasp 推送）
