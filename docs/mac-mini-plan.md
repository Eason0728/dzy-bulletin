# 後端搬到 Mac mini 規劃（方案 C）

- 版本：v1 / 2026-09-30
- 狀態：**已實施（2026-09-30 19:54 正式切換到 Mac mini）**，實作與審查紀錄見 issue #5～#11、#18；部署、切換、回退手冊在 `server/DEPLOY.md`、`server/CUTOVER.md`、`server/ROLLBACK.md`
- 已定案（2026-09-30）：後端走 Mac mini；Mac mini 已在公司開機連網；附件繼續放 Google 雲端硬碟；對外連線用 Tailscale Funnel；暫不加 UPS。

## 1. 為什麼
2026-09-30 實測同一種呼叫：個人帳號 Apps Script 1.2～2.7 秒；madesiaosinla 帳號 1.7～72 秒（帳號底下系統多、排隊）。
Mac mini 本機處理預估 0.1～0.3 秒（加上 Tailscale 通道約 0.2～0.5 秒）。

## 2. 架構

```
同仁手機 ── dzy-bulletin.github.io（前端，不變）
              │ fetch
              ▼
   Tailscale Funnel（https://<mini>.<tailnet>.ts.net，免費加密通道，不動公司路由器）
              ▼
   Mac mini：佈告欄伺服器（Node.js，無第三方套件）
     ├─ 服務層：沿用 gas/Service.js、gas/Auth.js、js/logic.js（同一份，不重寫商業邏輯）
     ├─ 資料：SQLite 單一檔案（公告／同仁／已讀／操作紀錄）
     ├─ 簽名圖：Mac mini 硬碟資料夾
     └─ 需要 Google 的動作 → 轉給既有 Apps Script（改當「Google 橋接」，只有伺服器能呼叫）
                                ├─ 附件上傳、分享、撤銷、查空間（Drive，保住禁止下載）
                                └─ 打卡名單同步（讀三份打卡試算表）
```

- **同仁天天用的動作全在 Mac mini**：選名字、登入、看公告、歷史區、簽名、看回條 → 快。
- **只有主管偶爾的動作**會多繞一次 Google：上傳附件、儲存有附件的公告、打卡同步、看雲端空間 → 速度跟現在差不多。
- 名單快照（公開名單試算表）與發布 CSV **不再需要**：Mac mini 回應夠快，停用這條路（程式保留但不發布）。

## 3. 資料搬遷（一次性）
1. Apps Script 加一個只能用伺服器金鑰呼叫的「匯出」動作：輸出公告、同仁（含密碼雜湊）、已讀、操作紀錄，以及簽名圖。
2. Mac mini 匯入 SQLite；簽名圖存到硬碟。
3. **登入憑證的簽章金鑰與管理通行碼雜湊一起搬** → 同仁、主管都不用重新登入，密碼照舊。
4. 切換：前端 `GAS_URL` 改指向 Mac mini；切換前後各比對一次筆數與內容（逐筆）。
5. 回退：出問題時前端改回原本 Apps Script 網址即可（舊資料保留、不刪）。

## 4. Mac mini 上要跑的東西
| 項目 | 做法 |
|---|---|
| 佈告欄伺服器 | launchd 常駐（`com.dzy.bulletin`），當掉自動重啟，開機自動啟動 |
| 對外通道 | Tailscale Funnel（Eason 帳號），把伺服器的連接埠開放成 https 網址 |
| 每日備份 | launchd 每天 03:00 把 SQLite 與簽名資料夾打包，傳到 Google 雲端硬碟（經橋接）並保留本機 14 天 |
| 監看 | 排程守門（雲端 Apps Script）每天呼叫健康檢查網址；指揮台艦隊加一格「佈告欄伺服器」 |
| 電源 | 系統設定：不睡眠、斷電後自動開機 |

## 5. 風險（已告知、Eason 接受）
- 公司停電、斷網、Mac mini 當機 → 佈告欄暫停（來電後自動恢復）。未加 UPS。
- Tailscale Funnel 為免費服務，網址由 Tailscale 產生；流量有上限（本系統流量小）。
- 附件仍靠 Google；Google 慢時上傳附件仍慢。

## 6. 需要 Eason 先做的（約 15 分鐘）
1. **Mac mini 開啟遠端登入**：系統設定 → 一般 → 共享 → 開啟「遠端登入」。
2. **Mac mini 電源**：系統設定 → 能源 → 開啟「防止自動進入睡眠」「停電後自動啟動」。
3. **安裝 Tailscale**：Mac mini 與這台 MacBook 都安裝 Tailscale（App Store 或 tailscale.com），用**同一個帳號**登入。
4. 告訴我：Mac mini 的**使用者名稱**，以及 Tailscale App 裡顯示的 **Mac mini 名稱**。
（Funnel 的開啟由我在 Mac mini 上用指令完成；若需要在 Tailscale 網頁後台按同意，我會提示。）

## 7. 開發順序與驗收
| 階段 | 內容 | 驗收 |
|---|---|---|
| M1 | 本機（MacBook）寫好伺服器：SQLite store、簽名檔存硬碟、橋接呼叫 | 現有 service／logic／auth 測試全過；新增 server 測試；judge.py、run.py 對本機伺服器全綠 |
| M2 | Apps Script 改當橋接（加伺服器金鑰、匯出動作），Fable 審查 | 橋接動作只接受伺服器金鑰；匯出資料逐筆比對 |
| M3 | 部署到 Mac mini：Node、launchd、Tailscale Funnel、備份、監看 | 手機實測；關機重開自動恢復；停掉 Tailscale 時前端顯示錯誤不白屏 |
| M4 | 搬資料、切換前端網址、觀察 1 天 | 切換前後逐筆一致；同仁不用重新登入 |
