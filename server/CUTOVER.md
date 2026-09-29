# 切換手冊：Apps Script → Mac mini（#10）

本手冊把 #10〈切換步驟〉寫成可以照做的清單。順序固定，不可調換。

每一步都標了三件事：負責人、驗證方式、失敗時怎麼辦。

角色：

- **Eason**：GAS 指令碼屬性、LINE 公告、手機與主管瀏覽器實測、核准 push。
- **Mac mini 的 Claude**：只在 Mac mini 上跑 `server/` 的指令。
- **MacBook 的 Claude**：前端 `js/config.js`、push、守門／指揮台。

硬規則：

- **`BRIDGE_KEY` 只有 Eason 經手**。Claude 不經手、不印出、不寫進任何檔案或留言。
- **Funnel 網址不貼進 repo、issue、留言**。量測時放在本機環境變數。
- 匯出檔（`dzy-bulletin-export-*.json`）內含全部密碼雜湊與登入金鑰。切換驗證完成後刪掉，而且**不 commit、不外傳**。

回退一律照 [`ROLLBACK.md`](ROLLBACK.md)。

以下 Mac mini 指令都在 repo 根目錄執行，並先設好變數：

```sh
cd ~/dzy-bulletin
export DATA_DIR="$(sed -n 's/^DATA_DIR=//p' server/.env | tr -d "\"'")"; DATA_DIR="${DATA_DIR:-$HOME/dzy-bulletin-data}"; DATA_DIR="${DATA_DIR/#\~/$HOME}"
counts() { node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});console.log(['posts','staff','reads','log'].map(t=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join('  '))" "$DATA_DIR"; }
```

---

## 0. 前置檢查（切換日前一天完成）

| # | 項目 | 負責人 | 怎麼確認 |
|---|---|---|---|
| 0-1 | M2 的 GAS（橋接、`PRIMARY`、`EXPORT_ONCE`、`sigs` get）已 clasp 部署 | MacBook 的 Claude（clasp）＋Eason 核准 | 部署後 `doGet` 回的版本號＝`gas/Code.js` 的 `VERSION_` |
| 0-2 | 含 `MOVED` 處理的前端**已上線滿 1 天**（#7【Opus】） | MacBook 的 Claude | Pages 上的 `js/config.js` 版本號＝含 MOVED 處理的版本 |
| 0-3 | Mac mini 部署完成（M4 `DEPLOY.md`）：伺服器常駐、Funnel 通、`server/.env` 有 `DATA_DIR`／`BRIDGE_URL`／`BRIDGE_KEY` | Mac mini 的 Claude（`.env` 的金鑰由 Eason 親手貼） | `curl -s http://127.0.0.1:8793/health` 回 JSON；`grep -c '^BRIDGE_KEY=' server/.env` 回 `1`（只數行數，不印內容） |
| 0-4 | **停掉每小時鏡像 job**（M4 已經裝好並載入，見 DEPLOY.md〈交接給 M5〉第 1 條），並確認目標庫是空的 | Mac mini 的 Claude | `launchctl bootout gui/$(id -u)/com.dzy.bulletin.mirror`；之後 `launchctl list \| grep com.dzy.bulletin.mirror` 沒有東西；`counts` 四個數字都是 0（M4 前景試跑建的空庫只有 kv 裡的一把 secret，migrate.js 不算它、搬遷時會被換掉） |
| 0-5 | Mac mini 上 `bash tools/build.sh` 全綠 | Mac mini 的 Claude | 最後一行 `build OK` |
| 0-6 | 記下切換前的 `js/config.js` 三行（`VERSION`／`ROSTER_CSV`／`GAS_URL`），回退時要用 | MacBook 的 Claude | 貼在 #10 留言（`GAS_URL` 本來就在 repo 裡，可以貼；Funnel 網址不貼） |

為什麼 0-4 要特別注意：第 2 步設下 `PRIMARY=mini` 之後，GAS 就會接受 `mirror`。若這時每小時鏡像先跑到，會把 Mac mini 的空庫整份蓋掉試算表，之後的 export 也就是空的。

- 已有兩道保險：GAS 端（M2）拒收四份全空的鏡像；`server/mirror.js`（本 PR）在 Mac mini 端也拒絕鏡像空庫（沒有同仁也沒有公告）。
- 保險之外，程序上仍要求：**第 2 步之前先 bootout，搬遷驗證完成（第 4 步）之後才 bootstrap 回來**。
- M4 之後每小時鏡像都被 `PRIMARY=gas` 擋下，`/health` 會是 yellow「鏡像連續失敗」，這是預期；第 4 步鏡像成功後自動轉綠。

---

## 1. LINE 公告（選離峰，例如 15:00）

**負責人**：Eason

搬家前約 30 分鐘發：

> 【電子佈告欄搬家通知】
> 今天 15:00～15:20 佈告欄要搬到新主機，這段時間**暫時不能簽名、不能上架**。畫面若出現「系統已搬家」或「系統搬家中」是正常的，不是壞掉。
> 15:20 之後請把佈告欄關掉再重新打開（或下拉重新整理），**不用重新登入**，之前簽過的紀錄都在。
> 有任何問題直接在群組說，謝謝！

搬家完成（第 7 步通過）後發：

> 【佈告欄搬家完成】
> 佈告欄已經搬好了，請關掉再重新打開一次就能正常使用，不用重新登入。如果畫面還是顯示「搬家中」，請等 10 分鐘再重新打開。

需要回退時發（ROLLBACK.md 第 6 步）：

> 【佈告欄暫時換回舊主機】
> 佈告欄暫時換回原本的系統，請關掉再重新打開一次，不用重新登入，資料都在。〈Mac mini 死了才加這句：〉○月○日 ○○:○○ 之後簽過名的同仁，麻煩再簽一次。

**預期行為（不是故障）**：從凍結（第 2 步）到新 `config.js` 生效（第 6 步），中間包含搬遷時間，加上 Pages 快取約 10 分鐘。這段時間寫入一律回 MOVED，讀取照常。

---

## 2. GAS 凍結：`PRIMARY=mini`、`EXPORT_ONCE=1`

**負責人**：**Eason 親手**

Apps Script →「專案設定」→「指令碼屬性」：新增或修改 `PRIMARY` = `mini`，並新增 `EXPORT_ONCE` = `1`。

**驗證**
- Eason 用手機打開佈告欄簽一筆，應該顯示「系統已搬家」並自動重新整理一次；之後 5 分鐘內不會再重載。看公告照常。
- Eason 記下試算表「操作紀錄」分頁**最後一列的時間與總列數**，第 5 步要用。

**失敗怎麼辦**
- 簽名仍然成功：屬性沒存成功，重新整理 Apps Script 頁面再設一次。
  - 已經簽進去的那筆沒問題，它在 GAS 裡，等一下會跟著 export 一起搬過去。
- 想中止：把 `PRIMARY` 改回 `gas`、刪掉 `EXPORT_ONCE`，就等於什麼都沒發生。

---

## 3. 搬遷：`migrate.js`（dry-run → 正式）

**負責人**：Mac mini 的 Claude

```sh
node server/migrate.js --dry-run
```

- 會呼叫 GAS `export`，**這一次就把 `EXPORT_ONCE` 用掉了**，GAS 成功後會自動刪掉它。
- 結果立刻存成 `<DATA_DIR 上一層>/dzy-bulletin-export-<台北時間>.json`，權限 600。
- 接著印出：各表筆數、簽名圖張數、`sigs` 批次呼叫次數（一批 20 張）、預估下載時間、目標資料夾是否為空。
- 最後一行印出下一步要用的指令。

看過沒問題（筆數合理、目標是空的、沒有「缺 secret」）就接著跑：

```sh
node server/migrate.js --from <dry-run 印出的匯出檔>
```

- 會做三件事：下載簽名圖（`sigs` 批次 get）→ 一筆交易寫入 → 另開唯讀連線逐筆比對。
- 結果要**六項全 ✅**、exit 0：
  1. 公告（逐筆內容）
  2. 同仁（含密碼雜湊，逐筆）
  3. 已讀（逐筆，含 Drive 簽名 id → `driveSigId`）
  4. 操作紀錄（逐筆、依順序）
  5. 簽名圖（逐張 sha256＋長度）
  6. 登入金鑰＋管理通行碼雜湊

**與 #10 原文的差異**：#10 寫的是 `--dry-run` 之後跑 `node server/migrate.js`。但 export 只能用一次，dry-run 已經用掉了，所以正式匯入一律用 `--from <檔>`。這樣 dry-run 與正式匯入看的是同一份資料，GAS 在第 2 步後已凍結，資料也不會變。

**失敗怎麼辦**（前端還沒動，任何失敗都可以安全中止：Eason 把 `PRIMARY` 改回 `gas`，同仁就恢復正常）

| 狀況 | exit | 怎麼辦 |
|---|---|---|
| 「缺 secret」或「缺 admin.hash」 | 3（GAS 端擋下時是 4） | **不要繼續**。這種狀態搬過去，所有人都要重新登入、主管也進不去。請 Eason 檢查 GAS 指令碼屬性 `TOKEN_SECRET`／`ADMIN_HASH`，補好後重設 `EXPORT_ONCE=1` 再從頭跑。 |
| export 回 AUTH | 4 | 通常是 `EXPORT_ONCE` 已被用掉：手上有存檔就用 `--from`，沒有就請 Eason 重設 `EXPORT_ONCE=1`。也可能是 `PRIMARY` 不是 `mini`，或 `BRIDGE_KEY` 兩邊不一致（請 Eason 核對，Claude 不看金鑰）。 |
| export 逾時 | 4 | GAS 可能已刪掉 `EXPORT_ONCE`，但結果沒收到。請 Eason 重設 `EXPORT_ONCE=1` 再跑 dry-run。 |
| 「目標已有資料」 | 2 | 0-4 沒做好。先弄清楚那是什麼資料：測試資料就移走整個 DATA_DIR，確定可以覆蓋才加 `--force`（會先備份）。 |
| 簽名圖某批下載失敗 3 次 | 5 | 資料庫沒有動，直接 `--from <同一個檔>` 重跑。 |
| 有 ❌ | 1 | **不要切前端**。把整段輸出貼到 #10（只含筆數與 id，不含雜湊），先回報。只有「簽名圖」❌、而且原因是 Drive 上本來就讀不到的圖時，由 Eason 決定是否接受（那幾筆的 Drive id 仍保留）。 |

---

## 4. 比對與開鏡像

**負責人**：Eason（看試算表）＋Mac mini 的 Claude

- [ ] GAS 試算表四個分頁的列數（扣掉表頭）＝ `counts` 的四個數字。
- [ ] 試算表「操作紀錄」的總列數與最後一列時間，**與第 2 步記下的相同**，代表凍結後 GAS 0 筆新增。
- [ ] Mac mini 的 Claude 裝回每小時鏡像（與 DEPLOY.md〈交接給 M5〉第 1 條相同）：
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dzy.bulletin.mirror.plist && launchctl kickstart gui/$(id -u)/com.dzy.bulletin.mirror`
  - 等它跑完（`logs/mirror.lock` 消失），`logs/mirror-last.json` 要是 `ok:true`、`pending:0`。
  - 剛搬來的已讀都已經有 Drive id，所以 pending 是 0。

**失敗怎麼辦**
- 操作紀錄有新增：代表凍結沒生效期間有人寫入，而且在 export 之後。
  - 把新增的那幾列記下來（誰、做了什麼）。
  - 切換完成後，請當事人在新系統重做一次（通常是簽名）。
  - 數量多就中止：Eason 設回 `PRIMARY=gas`，查明原因再從頭來。
- 鏡像失敗：不影響切換，可以繼續第 5 步，下一輪會自動重做。但第 8 步觀察日要盯 `/health`。

---

## 5. 前端切到 Mac mini

**負責人**：MacBook 的 Claude（Eason 核准 push）

**只改這幾行**（本 PR 刻意不改，切換當天才改）：

| 檔案 | 行 | 改成 |
|---|---|---|
| `js/config.js` | `VERSION: '0.5.5',`（以當天為準） | 進位，例如 `'0.6.0'` |
| `js/config.js` | `ROSTER_CSV: '…',` | **清空成 `''`**。切到 Mac mini 後 GAS 不再更新公開名單試算表，留著會先顯示凍結的舊名單。2026-09-30 已經是空白，只要確認一下。 |
| `js/config.js` | `GAS_URL: 'https://script.google.com/…/exec',` | Mac mini 的 Funnel 網址（Eason 提供，結尾不加 `/exec`）。**網址只出現在這個 commit 裡，不貼進 issue 或留言。** |
| `gas/Code.js` | `var VERSION_ = '0.5.5';` | 與 `js/config.js` 同號（`tools/build.sh` 會檢查兩邊一致；GAS 不需重新部署，版本號只影響 doGet 顯示） |
| `index.html` | `?v=…` | 不手改，`tools/build.sh` 會自動同步 |

```sh
bash tools/build.sh
git add js/config.js gas/Code.js index.html && git commit -m "切換：前端改指 Mac mini（#10）" && git push
```

**驗證**
- `curl -s "https://dzy-bulletin.github.io/js/config.js?v=<新版本>" | grep VERSION` 看到新版本號。
- 在 MacBook 的瀏覽器用無痕視窗打開佈告欄：名單出得來、Network 面板的請求打向 Funnel 網址。
- Mac mini 的 Claude 同時看 `tail -f "$DATA_DIR/logs/server.log"`，要出現 `roster …ms ok`。

**失敗怎麼辦**
- Pages 沒更新：GitHub → Actions 重跑 pages build。這段期間同仁看得到、簽不了，資料不會丟。
- 打開後顯示「連不上伺服器」：Funnel 或伺服器有問題。
  - Mac mini 的 Claude 先查 `curl -s http://127.0.0.1:8793/health` 與 `tailscale funnel status`。
  - 10 分鐘內修不好就照 ROLLBACK.md 回退。這時 Mac mini 還沒收到任何寫入，回退第 2 步很快就會完成。

---

## 6. 驗證四個動作（不重新登入）

**負責人**：Eason 操作，Mac mini 的 Claude 看紀錄

- [ ] **同仁**：用切換前就已登入的手機，重新整理後直接簽一筆，**沒有被要求重新登入**。
- [ ] **主管**：用切換前就已登入的瀏覽器，直接上架一則測試公告，**沒有被要求重新登入**。
- [ ] **主管**：上傳一個附件（走橋接到 Drive），並確認附件打得開。
- [ ] **主管**：按一次「從打卡系統同步」（`syncClock`，走橋接）。

Mac mini 的 Claude 確認：

```sh
grep -E " (ack|savePost|uploadFile|syncClock) [0-9]+ms " "$DATA_DIR/logs/server.log" | tail -n 8
```

四種動作各至少一行，結尾是 `ok`。

**失敗怎麼辦**
- 被要求重新登入：代表 secret 沒搬到（理論上第 3 步第 6 項會先擋下）。
  - 先停手，貼 `counts` 與 migrate 輸出到 #10。
  - 決定回退或讓大家重新登入，由 Eason 定。
- 上傳或同步回 `BRIDGE`：多半是 `BRIDGE_URL`／`BRIDGE_KEY` 問題，看 `server.err.log`（只記 op，不記金鑰）。
  - 簽名和看公告不受影響，可以不回退，修好橋接再重試。

---

## 7. `BRIDGE_KEY` 外洩檢查（條件式換鑰，#10【定案 r2】）

**負責人**：Mac mini 的 Claude

這個指令只比對前 8 碼，指令本身和輸出都不含金鑰：

```sh
P="$(sed -n 's/^BRIDGE_KEY=//p' server/.env | tr -d "\"'" | cut -c1-8)"; if [ ${#P} -ne 8 ]; then echo "讀不到 BRIDGE_KEY（不做判定）"; else grep -rlF -- "$P" ~/.claude/projects/ "$DATA_DIR/logs" 2>/dev/null | wc -l; fi; unset P
```

- 在 #10 原文上多了兩個保護：
  - `grep -F`：當純字串比對。
  - 長度檢查：沒讀到金鑰時，不會變成 `grep ""` 而把每個檔案都算進去。
- 輸出只有一個數字（檔案數）。**不要**把 `-l` 換成會印內容的參數，也不要 `echo "$P"`。
- 回 `0` → 不換鑰，截圖貼 #10。
- 回非 0 → **Eason 換一把**：
  1. `openssl rand -hex 32` 自產新金鑰，貼進 GAS 指令碼屬性 `BRIDGE_KEY` 和 Mac mini 的 `server/.env`。
  2. Mac mini 的 Claude 重啟伺服器：`launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`（伺服器只在啟動時讀 `.env`）。
  3. 主管上傳一個附件，要成功。
  4. 用舊金鑰打一次 `bridge`，要回 `AUTH`。
     - 由 Eason 自己在終端機打。舊金鑰不經 Claude，Claude 只能說明做法。
  5. 換完再跑一次本步的檢查。
  - Claude **不要**打開命中的檔案看（與 DEPLOY.md 第 10 步一致），只回報「N 個命中」。

---

## 8. 觀察 1 天＋效能量測

**負責人**：Mac mini 的 Claude（a）、MacBook 的 Claude＋Eason 的手機熱點（b）、MacBook 的 Claude（守門）

**健康**（隔天早上）
- `curl -s http://127.0.0.1:8793/health` 的 `level` 是 `green`。
- `logs/mirror-last.json` 的 `at` 在 3 小時內、`ok:true`。
- `logs/backup-last.json` 的 `at` 在 26 小時內、`ok:true`。
- 判定規則照 #8：打不通、`mirror.at` 超過 6 小時、`backup.at` 超過 26 小時 → 紅；其餘異常 → 黃。

**(a) 伺服器端 p95 < 200ms**：從伺服器 stdout 紀錄算。每請求一行：`時間 action 毫秒 ok/錯誤碼`，不含參數。

```sh
node server/latency.js --hours 24 "$DATA_DIR/logs/server.log"
# 例：✅ board：312 次，p50 18ms、p95 64ms、最慢 410ms（門檻 p95 < 200ms）
```

**(b) 端到端**：MacBook 接手機 4G 熱點（**關掉 Wi‑Fi**），對 `roster` 打 30 次，看中位數與 90 百分位（門檻：中位數 < 1 秒、p90 < 1.5 秒）。網址放環境變數，不貼出來：

```sh
read -rs DZYB_URL   # 貼上 Funnel 網址後按 Enter（不回顯）
for i in $(seq 30); do curl -s -o /dev/null -w '%{time_total}\n' -X POST -H 'Content-Type: text/plain' --data '{"action":"roster"}' "$DZYB_URL"; done | node server/latency.js --values
unset DZYB_URL
```

(a)、(b) 兩個結果貼到 #5 留言，只貼數字，網址不貼。

**守門與指揮台**：這部分由 MacBook 的 Claude 另外做，不在本 PR 裡。
- 排程守門 `~/mala-gas/schedule-watchdog/Code.js` 加「佈告欄伺服器」一格：`UrlFetchApp` 打 Funnel 的 `/health`，網址放守門的指令碼屬性。
- 指揮台艦隊加同名一格。
- 驗收：關掉 Mac mini 後，24 小時內守門發 LINE 告警、艦隊那格變紅；開回來後下一班轉綠。

**失敗怎麼辦**
- p95 超標：用 `--actions board,ack,roster` 看是哪個動作。
  - 若 `adminData` 或 `receipts` 慢，屬於預期（量大），不在門檻內。
  - `board`／`ack` 超標就把數字貼 #5，討論要不要調整。不需要為了這個回退。
- `/health` 紅：先照 #8 的判定逐項查（伺服器、鏡像、快照）。伺服器死了修不好就回退。

---

## 9. 回退演練（觀察日結束後，必做）

照 [`ROLLBACK.md`](ROLLBACK.md) 第 1～6 步回退，再照附錄 A 切回。驗收項目列在 ROLLBACK.md 最後。

## 10. 收尾

- [ ] **Mac mini 的 Claude**：刪除匯出檔 `rm <匯出檔>`，並確認 `ls "$(dirname "$DATA_DIR")"/dzy-bulletin-export-*.json` 沒有殘留。
  - 回退演練附錄 A 產生的第二份匯出檔也要刪。
- [ ] **Eason**：GAS 指令碼屬性確認 `EXPORT_ONCE` 不存在、`PRIMARY=mini`。
- [ ] #10 驗收勾選。

## 驗收對照（#10）

| #10 驗收 | 本手冊 |
|---|---|
| 步驟 4 六項全 ✅；缺 secret 時非 0 結束（假 export 測過） | 第 3 步；`test/migrate.test.js` |
| 步驟 5 凍結後 GAS 0 筆新增、筆數相等 | 第 4 步 |
| 步驟 7 四個動作成功、不重新登入 | 第 6 步（`test/migrate.test.js` 另外驗過「搬遷前的 token／atoken 直接能用」） |
| 步驟 8 grep 回 0 或換鑰成功 | 第 7 步 |
| 步驟 10 回退演練 | 第 9 步＋ROLLBACK.md |
| 守門告警、艦隊變紅 | 第 8 步（守門改動另案） |
| 效能 p95／中位數／p90 | 第 8 步＋`server/latency.js` |
| 前端打不通時不白屏（run.py） | 另案（本 PR 不含） |
