# 進度：鼎兆元｜電子佈告欄
- 開案日：2026-09-29
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：④（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：正式 GAS 跑 setup() 授權＋填 ADMIN_INIT

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
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-09-29 | 預覽自測 | preview/index.html 同仁端＋管理端全流程 | 通過（修 2 bug：日期少一天、他單位紅點） | 1 | 內建瀏覽器 JS 點擊驗證，errs=[] |
| 2026-09-29 | 預覽自測 | 個人密碼：設定／驗證／鎖定／忘記重設／主管重設踢登出 | 通過（修：重設後空白頁、focus 空指標） | 2 | 同上，errs=[] |
| 2026-09-29 | 任務關 | T1–T7 | 通過：node 153 項＋瀏覽器 local 全流程（同仁端、管理端）pageerror=0 | 1 | test/*.test.js、內建瀏覽器 JS 驗證 |
| 2026-09-29 | 階段關 | Phase 1（T1–T7） | 不通過：5 處程式與契約不一致（4 改文件、1 改程式） | 1 | docs/gate/phase1-r1.md |
| 2026-09-29 | 階段關 | Phase 1（T1–T7） | 不通過：debug 欄位外洩（中）、回條 active 語意（低），均已改程式＋補測試 | 2 | docs/gate/phase1-r2.md |
| 2026-09-29 | 階段關 | Phase 1（T1–T7） | **通過**；3 項非阻斷建議已處理 | 3 | docs/gate/phase1-r3.md |

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：

## spike 資源（④ 結束後清理）
- spike GAS：scriptId `1DVAHktjmJOHWVDRLYZnPg5OpI3_CLVhd_osLGC9F6KRq2mtPXroU_wPZ`（madesiaosinla），部署 `AKfycbwjSqM-r4kL8Xep7mejf3rG_W09G1dLveC8DcZy25kF0hT_tzykY759gIlySkRkqICr`
- Drive 測試資料夾「【spike】佈告欄附件測試」已丟垃圾桶、4 個測試檔已取消分享（2026-09-29）

## 正式資源（2026-09-29 建立）
- 正式 GAS：scriptId `13cscE_m0bv7mI4ArvR-EbTTc-bca27coHFxf-cRjjxXN15fvNOqm8RuL`（madesiaosinla），rootDir `gas/`
- 部署 ID：`AKfycbzQXAnMnrYGoUEMDzr6XbtsuIDYyGWbGLcFW1xVDpa64NcBrMzI9GaVKJhIlC-WxnGK5g`（@1）。**之後一律 `clasp deploy -i <此 ID>` 更新，不要建新部署**（會換網址）
- 等 Eason：正式 GAS 跑 setup() 授權＋填 ADMIN_INIT
