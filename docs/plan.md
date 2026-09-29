# 技術方案：鼎兆元｜電子佈告欄

- 版本：v1 / 2026-09-29
- 對應：spec.md v1（Eason 已確認）

## 目錄結構

```
~/dzy-bulletin/                    repo Eason0728/dzy-bulletin（public，Pages 用 main 分支根目錄）
├── index.html                     單頁：同仁端＋設定面板
├── css/app.css                    從預覽頁抽出
├── js/
│   ├── logic.js                   共用純函式（前端、後端、node 測試三方共用，正本只有這一份）
│   ├── config.js                  MODE、GAS 網址、逾時、版本號
│   ├── api.js                     cloud：fetch GAS；local：轉給 mock.js
│   ├── mock.js                    本機假後端：Service.js＋localStorage store＋假加密
│   ├── staff.js                   名單／密碼／公告／歷史／內容頁／附件檢視
│   ├── sign.js                    手寫簽名板
│   └── admin.js                   設定面板（公告管理、表單、上傳、回條、同仁、通行碼）
├── gas/                           clasp rootDir（.clasp.json 已 gitignore）
│   ├── appsscript.json
│   ├── Code.js                    路由（doPost）＋把 Service 接到 Store／Files
│   ├── Service.js                 API 契約 17 個 action 的唯一實作（本機假後端也用這份）
│   ├── Auth.js                    雜湊、憑證、鎖定（加密原語注入）
│   ├── Store.js                   試算表讀寫
│   ├── Files.js                   Drive 上傳／分享／撤銷／空間
│   └── Logic.js                   ← 由 tools/build.sh 從 js/logic.js 複製產生，不手改
├── tools/build.sh                 複製 logic.js → gas/Logic.js，並做 node --check
├── test/                          node 單元測試（logic、auth）
├── e2e/                           Playwright（local 模式）
├── preview/                       現有假資料預覽（保留作為對照，不上線引用）
├── spike/                         ② 探的試探程式（不被正式程式引用）
└── docs/                          四份文件＋progress.md
```

## 開發階段

### Phase 1：共用邏輯＋本機假後端＋完整前端（里程碑：local 模式能完整操作）
- 用 `?mode=local` 走完需求的全部功能，行為跟預覽頁一致，但已經改成照 API 契約呼叫。
- 這一階段完成後，前端就定型了。Phase 2 只接上真的後端，不再改畫面。
- 任務：T1–T7。

### Phase 2：Apps Script 後端＋Drive（里程碑：cloud 模式在真環境跑通）
- 後端照同一份 API 契約實作，並把 local 模式的端到端測試換成真後端，手動跑一輪。
- 要 Eason 做兩件事（T10）：
  1. 在編輯器跑一次 `setup()` 完成授權。
  2. 在指令碼屬性填 `ADMIN_INIT`，也就是正式的管理通行碼。
- 任務：T8–T10。

### Phase 3：驗收與上線（里程碑：Eason 手機實測通過、落地清單全部打勾）
- 任務：T11–T13。

## 關鍵技術決定
1. **`logic.js` 只有一份正本**：前端用 `<script>` 載入；後端靠 build 複製成 `gas/Logic.js`；node 測試用 `require`。檔尾用 `if (typeof module!=='undefined') module.exports=…` 同時支援三種用法。
2. **憑證不存資料表**：用 HMAC 簽章，驗證時重新算一次比對。
   - 後端用 `Utilities.computeHmacSha256Signature`。
   - node 測試用 `crypto.createHmac` 包成同一個介面，兩邊輸出要一致，有測試對照。
3. **LockService**：所有寫入動作包在 `withLock_()` 裡，等待上限 20 秒。
4. **快取**：`board` 回應用 `CacheService` 快取 60 秒，任何公告或已讀的寫入就清掉快取。這是為了早上同仁同時打開時不要重複讀試算表。
5. **逾時**：一般 20 秒，`uploadFile` 120 秒，`adminData` 40 秒。
6. **XSS**：所有使用者輸入的文字（標題、內容、姓名、檔名）一律用 `textContent` 或 `esc()` 輸出。這是從打卡系統店內公告沿用的規矩。

## 風險與停損
| 風險 | 訊號 | 處理 |
|---|---|---|
| LINE 內建瀏覽器的 localStorage 被清掉 | Eason 實測每次打開都要重新選名字 | 提示同仁「用預設瀏覽器開啟」。LINE 連結尾端加 `?openExternalBrowser=1`，讓 LINE 直接用外部瀏覽器開啟 |
| Drive 預覽在 LINE 內建瀏覽器打不開 | Eason 實測出現空白 | 改成在新視窗開 `/view`，一樣沒有下載鈕 |
| 試算表讀取變慢 | `board` 超過 5 秒 | 已有快取；再慢就把已下架的公告搬到另一個分頁 |
| 同一個卡點修 3 次還不行 | — | 停下來回報 Eason（鐵律） |
