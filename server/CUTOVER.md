# 切換手冊：Apps Script → Mac mini（#10）

本手冊把 #10〈切換步驟〉寫成可以照做的清單。順序固定，不可調換。

每一步都標了三件事：負責人、驗證方式、失敗時怎麼辦。

角色：

- **Eason**：GAS 指令碼屬性、LINE 公告、手機與主管瀏覽器實測、核准 push。
- **Mac mini 的 Claude**：只在 Mac mini 上跑 `server/` 的指令。
- **MacBook 的 Claude**：前端 `js/config.js`、push、守門／指揮台。

硬規則：

- **`BRIDGE_KEY` 只有 Eason 經手**。Claude 不經手、不印出、不寫進任何檔案或留言。
- **Funnel 網址只出現在一個地方：切換那個 commit 的 `js/config.js`**（前端本來就得知道它，repo 是公開的，這無法避免）。除此之外不貼進 issue、PR、留言、手冊或其他檔案；量測時放在本機環境變數。
- 匯出檔（`dzy-bulletin-export-*.json`）內含全部密碼雜湊與登入金鑰。切換驗證完成後刪掉，而且**不 commit、不外傳**。

回退一律照 [`ROLLBACK.md`](ROLLBACK.md)。

以下 Mac mini 指令都在 repo 根目錄執行。**每一段指令前都要先貼下面這段**：Claude 每次 Bash 呼叫都是新的 shell，上一次設的變數和函式都不在了（與 DEPLOY.md 同一條規則）。

```sh
cd ~/dzy-bulletin
export PATH="$HOME/.local/node/bin:$PATH"; command -v node   # Mac mini 沒把 Node 放進 PATH（DEPLOY.md〈交接給 M5〉）；export PATH 讓子程序（build.sh、restore.js）也吃得到。這行要印出 …/.local/node/bin/node，印別的（例如 Homebrew 的 /opt/homebrew/bin/node）就停下來查
export DATA_DIR="$(sed -n 's/^DATA_DIR=//p' server/.env | tr -d "\"'")"; DATA_DIR="${DATA_DIR:-$HOME/dzy-bulletin-data}"; DATA_DIR="${DATA_DIR/#\~/$HOME}"
U="gui/$(id -u)"
job_off() { launchctl disable "$U/$1"; launchctl bootout "$U/$1" 2>/dev/null; launchctl print "$U/$1" >/dev/null 2>&1 && echo "✗ $1 還在跑" || echo "✓ $1 已停、已 disable"; }   # disable 撐得過重開機
job_on()  { launchctl enable "$U/$1"; launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$1.plist" && echo "✓ $1 已 enable＋載入"; }
counts() { node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});console.log(['posts','staff','reads','log'].map(t=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join('  '))" "$DATA_DIR"; }
```

---

## 0. 前置檢查（切換日前一天完成）

| # | 項目 | 負責人 | 怎麼確認 |
|---|---|---|---|
| 0-1 | M2 **定稿版**的 GAS（橋接、`PRIMARY`、`EXPORT_ONCE`、`sigs` get、鏡像的計數與防呆）**已經是正式部署** | **MacBook 的 Claude**，在 MacBook 的 `~/dzy-bulletin` 執行（Eason 核准） | 照下方〈0-1 確認部署版本〉：先確認，**符合就不 push、不 deploy**；只有不符合時才部署。任何一道不過就**不進第 2 步** |
| 0-2 | 含 `MOVED` 處理的前端**已上線滿 1 天**（#7【Opus】） | MacBook 的 Claude | Pages 上的 `js/config.js` 版本號＝含 MOVED 處理的版本 |
| 0-3 | Mac mini 部署完成（M4 `DEPLOY.md`）：伺服器常駐、Funnel 通、`server/.env` 有 `DATA_DIR`／`BRIDGE_URL`／`BRIDGE_KEY` | Mac mini 的 Claude（`.env` 的金鑰由 Eason 親手貼） | `curl -s http://127.0.0.1:8793/health` 回 JSON；`grep -c '^[[:space:]]*BRIDGE_KEY[[:space:]]*=' server/.env` 回 `1`（只數行數，不印內容；認行規則與伺服器 loadEnv 相同） |
| 0-4 | **停掉每小時鏡像 job**（M4 已經裝好並載入，見 DEPLOY.md〈交接給 M5〉第 1 條；這裡多做 `disable`，重開機也不會回來），並確認目標庫是空的、沒有 `ADMIN_INIT.txt` | Mac mini 的 Claude | `job_off com.dzy.bulletin.mirror` 印「已停、已 disable」；`counts` 四個數字都是 0（M4 前景試跑建的空庫只有 kv 裡的一把 secret，migrate.js 不算它、搬遷時會被換掉）；`ls "$DATA_DIR/ADMIN_INIT.txt"` 要回「No such file」（這個檔在的話，主管第一次登入會把搬過來的管理雜湊換掉） |
| 0-5 | Mac mini 上 `bash tools/build.sh` 全綠，而且用的是服務實際用的 Node 24 | Mac mini 的 Claude | 先貼共用區塊；`node -v` 要是 `v24.`開頭；最後一行 `build OK` |
| 0-6 | 記下切換前的 `js/config.js` 三行（`VERSION`／`ROSTER_CSV`／`GAS_URL`），回退時要用 | MacBook 的 Claude | 貼在 #10 留言（`GAS_URL` 本來就在 repo 裡，可以貼；Funnel 網址不貼） |
| 0-7 | 先估簽名圖下載時間，決定公告的時段 | Eason 數列數、Mac mini 的 Claude 算 | Eason 看試算表「已讀」分頁「簽名檔 id」有值的列數 N；下載約 ⌈N÷20⌉ 次橋接，每次 5～30 秒。例：N＝2000 → 100 次 → 約 8～50 分鐘。公告時段＝這個上限＋15 分鐘（搬遷與 Pages 快取）。第 3 步 dry-run 印出的預估若超出公告時段：還沒開始下載，可以中止（Eason 設回 `PRIMARY=gas`，改天用更長的時段），或在 LINE 補一則延長公告 |
| 0-8 | 預查公告／同仁有沒有**重複 id**，切換前清掉（凍結窗口裡才發現會拉長停機，見第 3 步） | Eason（試算表）；Claude 可以補查同仁 | 照下方〈0-8 重複 id 預查〉 |

### 0-4 補充：為什麼要先停每小時鏡像、燈號會怎麼變

第 2 步設下 `PRIMARY=mini` 之後，GAS 就會接受 `mirror`。若這時每小時鏡像先跑到，會把 Mac mini 的空庫整份蓋掉試算表，之後的 export 也就是空的。

- 已有兩道保險：GAS 端（M2）拒收四份全空的鏡像；`server/mirror.js`（本 PR）在 Mac mini 端也拒絕鏡像空庫（沒有同仁也沒有公告）。
- 保險之外，程序上仍要求：**第 2 步之前先 disable＋bootout，搬遷驗證完成（第 4 步）之後才 enable＋bootstrap 回來**。
- `/health` 燈號的預期變化（**都不是故障，不要處理**）：
  - M4 部署後到 0-4 之前：每小時鏡像都被 `PRIMARY=gas` 擋下，約 2 小時後 `/health` 轉 **yellow**「鏡像連續失敗」。
  - 0-4 停掉鏡像後：鏡像不再跑，`mirror.at` 停住，超過 6 小時轉 **red**（#8：`mirror.at` > 6h → 紅）。切換日早上看到紅燈是預期的。
  - 第 4 步鏡像成功後自動轉綠。

### 0-1 確認部署版本（MacBook 的 Claude）

M2 定稿（b998db9）已經部署成正式版 **@27**。0-1 的預設是**只確認、不重新部署**：多部署一次只會產生內容相同的新版本，還可能把 MacBook 上後來改過的 `Config.local.js` 在切換前一天推上去，或卡在 clasp 的互動確認。

一律在 MacBook 的 `~/dzy-bulletin` 執行（`gas/.clasp.json` 只在這裡）：

```sh
cd ~/dzy-bulletin && git checkout main && git pull --ff-only && git status --short   # 最後一段要空白
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch --unshallow          # shallow clone 先補完整歷史，否則下兩行會回 fatal
git merge-base --is-ancestor b998db9 origin/main && echo "OK：主線含 M2 定稿 b998db9"
git diff --quiet b998db9 origin/main -- gas/ && echo "OK：b998db9 之後 gas/ 沒有任何變動"
cd gas && clasp deployments                                                              # 找正式部署 ID 那一行，版本要是 @27 或更新
```

- **三項都成立**（主線含 b998db9、`gas/` 沒有變動、正式部署 ≥ @27）→ 0-1 完成，**不 push、不 deploy**。
- `b998db9`＝M2 第 3 輪定稿。**M2 之後若又改版，這個 hash 與 @27 都要跟著更新。**
- #13 是用一般 merge commit 合進來的，所以 b998db9 是主線的祖先。**如果日後改用 squash merge**，b998db9 就不會是祖先；那時改用 `grep -c distinct_ gas/Store.js`、`grep -c isTrashed gas/Files.js` 兩個都大於 0 判斷是否含 M2 定稿。
- 注意：第 5 步切換時會改 `gas/Code.js` 的 `VERSION_`，那是切換當天之後的事，不影響 0-1（手冊寫明版本號不需要重新部署）。

**只有 `gas/` 有變動、或正式部署舊於 @27 時**，才照下面部署：

```sh
cd ~/dzy-bulletin
ls gas/.clasp.json gas/Config.local.js || echo "✗ 缺檔，停下來，不准 push"          # 兩個都要存在
cd gas && clasp push -f && clasp deploy -i <正式部署 ID> -d "$(git rev-parse --short HEAD)" && clasp deployments
```

- `clasp push -f`：遠端 manifest 有變動時 clasp 會跳出互動確認，Claude 的 Bash 回答不了會卡住；`-f` 直接以本機為準。
- `Config.local.js` **本來就該推上去**：GAS 需要它（打卡來源 `CLOCK_SOURCES_` 在裡面）。它只是被 **git** 忽略（不進 repo），不是被 **clasp** 忽略，所以只能在有這個檔的 `~/dzy-bulletin` 推。`clasp push` 會用本機檔案整份取代 GAS 專案，在沒有這個檔的目錄（Mac mini、新 clone、worktree）推，GAS 上的它會消失、打卡同步默默停掉——這才是風險，不是推它本身。
- `-i` 帶正式部署 ID，Web App 網址才不會換。確認 `clasp deployments` 裡那個部署 ID 的說明＝`git rev-parse --short HEAD`、版本號比原本新。

### 0-8 重複 id 預查

**① Eason（試算表）**

1. 在主試算表**新增一個暫時分頁**，例如叫「重複檢查」。
   - **不要**把公式貼在「公告」「同仁」分頁裡：貼在 id 欄會被當成一筆資料，貼在資料最後一列下面會讓之後新增的列接在它後面。
2. 在暫時分頁的 A1 貼公告版：
   `=IFNA(TEXTJOIN("、",TRUE,UNIQUE(FILTER(公告!A2:A,公告!A2:A<>"",COUNTIF(公告!A2:A,公告!A2:A)>1))),"沒有重複")`
3. 在 A2 貼同仁版（完整一條，不要自己改字）：
   `=IFNA(TEXTJOIN("、",TRUE,UNIQUE(FILTER(同仁!A2:A,同仁!A2:A<>"",COUNTIF(同仁!A2:A,同仁!A2:A)>1))),"沒有重複")`
   - 顯示「沒有重複」就沒問題。
   - 顯示 id：由 Eason 判斷要留哪一列（GAS 的編輯與簽名只認第一列），到原分頁刪掉另一列。
   - 顯示其他錯誤（例如 `#ERROR!`、`#NAME?`）：代表公式沒有貼對，不代表沒有重複，要修到顯示結果為止。用 `IFNA` 而不用 `IFERROR`，就是為了只接住「找不到重複」的情況，其他錯誤照樣顯示出來。
4. 查完**把整個暫時分頁刪掉**。

**② Claude 補查在職同仁**

不動 EXPORT_ONCE；只看得到在職同仁，公告沒有免登入的讀法，以 ① 為準。

```sh
curl -sSL --data '{"action":"roster"}' "<js/config.js 的 GAS_URL>" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const ids=JSON.parse(s).data.map(x=>x.id);const d=ids.filter((x,i)=>ids.indexOf(x)!==i);console.log(d.length?'重複：'+[...new Set(d)].join('、'):'在職同仁沒有重複')})"
```

---

## 1. LINE 公告（選離峰，例如 15:00）

**負責人**：Eason

搬家前約 30 分鐘發：

> 【電子佈告欄搬家通知】
> 今天 15:00～15:20 佈告欄要搬到新主機，這段時間**暫時不能簽名、不能上架**。畫面若出現「系統已搬家」或「系統搬家中」是正常的，不是壞掉。
> 15:20 之後請把佈告欄關掉再重新打開（或下拉重新整理），**不用重新登入**，之前簽過的紀錄都在。
> 有任何問題直接在群組說，謝謝！

搬家完成（第 6 步四個動作都通過）後發：

> 【佈告欄搬家完成】
> 佈告欄已經搬好了，請關掉再重新打開一次就能正常使用，不用重新登入。如果畫面還是顯示「搬家中」，請等 10 分鐘再重新打開。

需要回退時發（ROLLBACK.md 第 6 步）：

> 【佈告欄暫時換回舊主機】
> 佈告欄暫時換回原本的系統，請關掉再重新打開一次，不用重新登入，資料都在。〈Mac mini 死了才加這句：〉○月○日 ○○:○○ 之後簽過名的同仁，麻煩再簽一次。

**預期行為（不是故障）**：從凍結（第 2 步）到新 `config.js` 生效（第 5 步），中間包含搬遷時間，加上 Pages 快取約 10 分鐘。這段時間寫入一律回 MOVED，讀取照常。

---

## 2. GAS 凍結：`PRIMARY=mini`、`EXPORT_ONCE=1`

**負責人**：**Eason 親手**

Apps Script →「專案設定」→「指令碼屬性」：新增或修改 `PRIMARY` = `mini`，並新增 `EXPORT_ONCE` = `1`。

**驗證**
- Eason 用手機打開佈告欄簽一筆，應該顯示「系統已搬家」並自動重新整理一次；之後 5 分鐘內不會再重載。看公告照常。
- Eason 記下試算表「操作紀錄」分頁**最後一列的時間與總列數**，第 4 步要用。

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
- 已讀若有重複（同一人同一則兩列，只有手動改過試算表才會發生），會印「已讀有 N 列重複…照 GAS 語意去重」。migrate 會自動照 GAS 的看法去重：簽名時間取最後一列、簽名圖取最後一張有簽名的，和 GAS 畫面上看到的一致。比對也以去重後為準，**不需要處理**，但把那幾筆 id 記在 #10。
- 預估時間超出公告時段：見 0-7。
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
| 「目標已有資料」 | 2 | 0-4 沒做好。先弄清楚那是什麼資料。確定可以覆蓋：加 `--force`，會先備份、在原檔上寫入，伺服器不用停。想整個資料夾換掉：**先停伺服器**（`job_off com.dzy.bulletin`），否則伺服器手上還開著舊庫，會繼續讀寫被搬走的那一份；然後 `mv "$DATA_DIR" "$DATA_DIR.old-$(date +%s)"` → 重跑 `--from` → `job_on com.dzy.bulletin` → `curl -s http://127.0.0.1:8793/health` 確認起來了。 |
| 「公告 id 重複」或「同仁 id 重複」 | 3（dry-run 也是 3） | 0-8 應該已經清掉；凍結窗口裡才發現，**停機時間會拉長**（同仁一直不能簽）。GAS 自己的看法不一致（看板／名單兩筆都顯示，編輯、簽名只認第一列），所以 migrate 不自動去重。處理：把印出的 id 交給 Eason，**由 Eason 確認**要留哪一列後，在試算表手動刪掉另一列 → 重設 `EXPORT_ONCE=1` → 從 `--dry-run` 重來（舊的匯出檔刪掉）。**判斷點：從 dry-run 印出重複 id 的那一刻起算，預計 15 分鐘內處理不完（Eason 無法馬上判斷、重複很多），就先中止**：Eason 設回 `PRIMARY=gas`、刪掉 `EXPORT_ONCE`，LINE 公告改天再搬；Mac mini 的 Claude 把這次的匯出檔刪掉（`rm <匯出檔>`，裡面有全部密碼雜湊，改天會產生新的一份）；照 0-8 清乾淨後重來。處理得完但會超出公告時段，照 0-7 在 LINE 補一則延長公告。 |
| 簽名圖某批下載失敗 3 次 | 5 | 資料庫沒有動，直接 `--from <同一個檔>` 重跑。已下載的圖存在 `$DATA_DIR/.migrate-dl/`，重跑只補沒下載的。 |
| 有 ❌ | 1 | **不要切前端**。把整段輸出貼到 #10（只含筆數與 id，不含雜湊），先回報。這時資料**已經寫進庫**：查明原因後重跑要加 `--force`（`--from <同一個檔> --force`，會先備份），否則會被「目標已有資料」擋下。只有「簽名圖」❌、而且原因是 Drive 上讀不到的圖（sigs.get 回 null：不在簽名資料夾、不是 png/jpeg、檔案不見）時，由 Eason 決定是否接受。那幾筆的 Drive id 仍保留，但 Mac mini 上沒有圖。**接受之後**把下載暫存刪掉：`rm -rf "$DATA_DIR/.migrate-dl"`（只有六項全 ✅ 時 migrate 才會自己刪，裡面是全部簽名圖）。 |

---

## 4. 比對與開鏡像

**負責人**：Eason（看試算表）＋Mac mini 的 Claude

- [ ] GAS 試算表四個分頁的列數（扣掉表頭）＝ `counts` 的四個數字。
  - 例外一：分頁中間有空白列時，export 會略過它們（`gas/Store.js` 的 `dump()` 只收有 id 的列），目測列數會比 `counts` 多。差的列數＝空白列數就算對。
  - 例外二：已讀有重複時，`counts` 是去重後的數字，會少掉第 3 步印出的重複列數。
- [ ] 試算表「操作紀錄」的總列數與最後一列時間，**與第 2 步記下的相同**，代表凍結後 GAS 0 筆新增。
- [ ] Mac mini 的 Claude 裝回每小時鏡像（與 DEPLOY.md〈交接給 M5〉第 1 條相同，另外多一個 enable）：
  `job_on com.dzy.bulletin.mirror`（plist 設了 RunAtLoad，載入就會跑一輪）
  - 等它跑完（`logs/mirror.lock` 消失），`logs/mirror-last.json` 要是 `ok:true`、`pending:0`，而且沒有 `running`／`busy`。剛搬來的已讀都已經有 Drive id，所以 pending 是 0。
  - **附件首次拉檔（M7，#18 D7）**：鏡像 ok 之後跑一次 `node server/mirror.js --files-scan; echo "exit=$?"`（列出附件資料夾〔含垃圾桶〕、把 Drive 上既有附件全拉到 `$DATA_DIR/files/`），印出 `count`／`pending`；首次量最大，`pending≠0` 就接著跑 `node server/mirror.js --files` 到 `pending=0`、exit 0。只在 Mac mini 上跑、只讀 Drive，**不佔切換窗口**：可以先往第 5 步走，在觀察日結束前補完即可。跑很久是正常的：它分批做、每批放掉鏡像鎖，每小時那輪照樣插得進來，期間 `/health` 短暫出現「鏡像超過 3 小時沒跑」黃燈屬預期。`files/` 是搬到 Mac mini 之後才有的東西，切換日不用從別處搬。
  - 第 3 步有 Drive 讀不到的圖時：migrate 把那幾筆的本機 `sigId` 設成空白、`driveSigId` 保留原值，所以 mirror.js **不會**把它們算進 pending／missing／bad／skipped（四種都只看 `sigId` 有值的列），也**不需要**寫進 `logs/sig-skip.json`，`missing` 仍是 0。這幾筆在 Mac mini 與 GAS 上都看不到圖，清單以第 3 步 migrate 印出的「簽名圖」❌ 為準，記在 #10。

**失敗怎麼辦**
- 操作紀錄有新增：代表凍結沒生效期間有人寫入，而且在 export 之後。
  - 把新增的那幾列記下來（誰、做了什麼）。
  - 切換完成後，請當事人在新系統重做一次（通常是簽名）。
  - 數量多就中止：Eason 設回 `PRIMARY=gas`，查明原因再從頭來。
- 鏡像失敗：先看 `logs/mirror-last.json` 的 `error`，分兩種：
  - **暫時性**（`BRIDGE`、逾時、Google 回 500）：不影響切換，可以繼續第 5 步，下一輪自動重做；第 9 步觀察日要盯 `/health`。
  - **被拒絕**（`BAD_REQ`，例如「比現有少」「少一半以上」「全空」；或 `AUTH`）：每一輪都會一樣失敗，GAS 上的備份會停在切換這一刻、沒有人會發現。**停下來，不准進第 5 步**。前端還沒動，可以安全中止：
    1. Mac mini 的 Claude 先把剛打開的每小時鏡像關掉：`job_off com.dzy.bulletin.mirror`（不關的話它每小時會打出 AUTH，`/health` 黃燈再轉紅，容易誤判）。
    2. Eason 設回 `PRIMARY=gas`、確認沒有 `EXPORT_ONCE`。
    3. 把 `error` 原文貼到 #10，找 MacBook 的 Claude 查（常見原因：0-1 部署的不是 M2 定稿）。
    4. 改天重來時，0-4 的「`counts` 四個都是 0」不會成立（這次已經搬進來了），這是預期：第 3 步正式匯入改用 `--from <新的匯出檔> --force`（會先備份）。

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

**驗證**：檢查頁面**實際載入**的那一份。自己加 `?v=<新版>` 會繞過快取，一定看得到新版，驗不出同仁那邊的狀況。

```sh
V=$(curl -s https://dzy-bulletin.github.io/ | grep -o 'js/config.js?v=[0-9.]*' | head -1); echo "index.html 引用：$V"
curl -s "https://dzy-bulletin.github.io/$V" | grep -c "script.google.com"   # 要回 0（已不再指向 Apps Script）
curl -s "https://dzy-bulletin.github.io/$V" | grep VERSION                  # 新版本號（只看版本號這行，GAS_URL 那行不印，網址不留在輸出裡）
```

- `index.html` 引用的 `?v=` 要是新版本號，那份 `config.js` 也要是新版本號。
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
- 回非 0 → **換一把**，順序固定：
  1. **Eason**：`openssl rand -hex 32` 自產新金鑰，**先只貼進 GAS 指令碼屬性** `BRIDGE_KEY`，`.env` 暫時不動。
  2. **Mac mini 的 Claude**：確認舊金鑰已失效。這時 `.env` 裡的還是舊金鑰。
     ```sh
     sh server/oldkey-check.sh
     ```
     - 腳本從 `.env` 讀金鑰和網址，用 shell 內建的 `printf` 經 stdin 送出（不會出現在任何程序的指令列，也不印出來），`curl -sSL --data @-` **不加 `-X POST`**：Apps Script 的 `/exec` 會 302 轉到只收 GET 的網址，加了 `-X POST` 轉址後仍用 POST，永遠拿不到結果。這個行為已用本機假伺服器模擬 302 實測（`test/migrate.test.js`）。
     - **不可以用 `sh -x` 執行或除錯**：trace 會把金鑰印出來（腳本開頭已經 `set +x`，但 `-x` 仍會印出前面幾行）。
     - 結果：
       - 印「✅ 回 AUTH：舊金鑰已失效」（exit 0）→ 通過，做下一步。
       - 印「❌ 回正常結果：舊金鑰仍然有效」（exit 1）→ GAS 屬性沒存到。請 Eason 回 Apps Script 確認 `BRIDGE_KEY` 已經是新的那把、有按儲存，再跑一次。
       - 印「✗ 其他回應」（exit 3）→ **停下來**，把腳本印出的原文貼給 MacBook 的 Claude（例如網路不通時 curl 的錯誤訊息、Google 暫時錯誤、`SERVER` 忙碌中）。不要反覆請 Eason 重設屬性。
       - 印「.env 有 N 行 BRIDGE_KEY」（exit 3）→ 伺服器只讀第一行，腳本無法判斷該驗哪一把。請 Eason 把 `server/.env` 整理成只剩一行 `BRIDGE_KEY=`（舊的那把），再跑一次。
       - 印「讀不到 BRIDGE_KEY／BRIDGE_URL」（exit 2）→ 確認是在 repo 根目錄執行、`server/.env` 存在，而且兩行都在、不是被 `#` 註解掉（`grep -c '^[[:space:]]*BRIDGE_KEY[[:space:]]*=' server/.env` 要是 1，只數行數、不印內容）。腳本認行的規則與伺服器 loadEnv 相同（開頭、等號兩邊可以有空白），所以伺服器讀得到的，腳本也讀得到。
     - 這段期間附件上傳、打卡同步會失敗，簽名與看公告不受影響，所以要接著做下一步。
  3. **Eason**：把同一把新金鑰貼進 Mac mini 的 `server/.env`。
  4. **Mac mini 的 Claude**：重啟伺服器 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`（伺服器只在啟動時讀 `.env`）。
  5. **Eason**：主管上傳一個附件，要成功。
  6. 換完再跑一次本步的檢查。
  - Claude **不要**打開命中的檔案看（與 DEPLOY.md 第 10 步一致），只回報「N 個命中」。

---

## 8. 守門、指揮台、run.py（切換後當天）

**負責人**：MacBook 的 Claude　**時機**：第 6 步通過後當天做完（#10〈範圍〉與〈監看〉，不另開 issue）

**8-1　排程守門加「佈告欄伺服器」**
- 改哪裡：版控正本 `~/mala-fortune/tools/gas-watchdog/Code.js`，改完同步到雲端 Apps Script `~/mala-gas/schedule-watchdog/Code.js`（clasp push，走 dispatch-rules 第 5 節的 clasp 工作流），兩邊內容一致並 commit。
- 做法：
  - 新增一項檢查，用 `UrlFetchApp` GET `<Funnel 網址>/health`（`muteHttpExceptions: true`，失敗重試 3 次）。
  - 網址放守門的指令碼屬性（例如 `BULLETIN_HEALTH_URL`），由 Eason 貼。**網址不進 repo**。
  - 沿用守門現有的 07:30／09:30／10:30 三班，不改頻率（#10【Opus】已知限制）。
- 判定照 #8，**直接用 `/health` 回傳的 `level`**（伺服器端的 `health-rules.js` 已經照 #8 算好，守門不要自己重算）：
  - 打不通、非 200、回應不是 JSON → **紅**。
  - `level` 是 `red` → **紅**（包含 `mirror.at` 超過 6 小時、`backup.at` 超過 26 小時、結果檔讀不到等）。
  - `level` 是 `yellow` → **黃**；其餘 → **綠**。
  - 紅燈發 LINE 告警（沿用守門現有的告警管道），`why` 原文帶進訊息，不含網址。

**8-2　指揮台艦隊加「佈告欄伺服器」一格**
- 走 `mala-command-deck` skill 的艦隊格新增流程。
- 格名「佈告欄伺服器」，紅黃綠與 8-1 同一套判定，資料來源用守門寫下的最新結果，不要另打一次 `/health`。

**8-3　run.py 加「後端打不通時不白屏」**
- 在 `e2e/run.py` 加一條：頁面**一定要從 `http://localhost:<埠>/` 打開**（`js/config.js` 只有 `location.hostname === 'localhost'` 才接受 `?api=`；從 127.0.0.1 打開會忽略它、直接打到正式 GAS），網址帶 `?mode=cloud&api=http://127.0.0.1:<沒有程式在聽的埠>`。
- 預期：畫面出現「連不上伺服器，請確認網路」（`js/api.js` 的 `NET`），頁面有內容、沒有 pageerror。
- 跑 `python3 e2e/run.py` 與 `python3 e2e/judge.py` 全綠後 commit。M4 已在 Mac mini 本機手動驗過同一件事（DEPLOY.md 9-2），這條是把它變成可重跑的測試。

**驗收**
- 請 Eason 關掉 Mac mini（或 `job_off com.dzy.bulletin`），24 小時內守門發 LINE 告警、艦隊那格變紅。
- 開回來（`job_on com.dzy.bulletin`）後，下一班轉綠。
- run.py 新那條 PASS。

**失敗怎麼辦**
- 守門打不到 Funnel（Google 的出口 IP 被擋、憑證問題）：先用手機 4G 打 `/health` 確認 Funnel 本身正常，再查守門的 `UrlFetchApp` 錯誤原文。
- 這一步的任何問題都**不需要回退**佈告欄本身。

---

## 9. 觀察 1 天＋效能量測

**負責人**：Mac mini 的 Claude（a）、Eason 在 MacBook 的終端機＋手機熱點（b）

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

**(b) 端到端**：MacBook 接手機 4G 熱點（**關掉 Wi‑Fi**），對 `roster` 打 30 次，看中位數與 90 百分位（門檻：中位數 < 1 秒、p90 < 1.5 秒）。
- **這段由 Eason 在 MacBook 的「終端機」App 裡自己打**。`read -rs` 要從鍵盤讀網址，Claude 的 Bash 沒辦法接收鍵盤輸入；網址也因此不會經過 Claude。
- 網址放環境變數，不貼出來。

```sh
cd ~/dzy-bulletin
read -rs DZYB_URL   # 貼上 Funnel 網址後按 Enter（不回顯）
for i in $(seq 30); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -X POST -H 'Content-Type: text/plain' --data '{"action":"roster"}' "$DZYB_URL"; done | node server/latency.js --values
unset DZYB_URL
```

- `latency.js --values` 只收 `http_code` 為 200 的那幾筆。連不上時 curl 印 `000 0.000`，這種算失敗、另外列出。
- **只要有 1 次失敗，或成功不到 30 次，就不算達標**。有失敗就先查網路，再整組重量一次。

(a)、(b) 兩個結果貼到 #5 留言，只貼數字，網址不貼。

**守門與指揮台**：見第 8 步。觀察日確認守門三班都有讀到「佈告欄伺服器」、指揮台那格是綠的。

**失敗怎麼辦**
- p95 超標：用 `--actions board,ack,roster` 看是哪個動作。
  - 若 `adminData` 或 `receipts` 慢，屬於預期（量大），不在門檻內。
  - `board`／`ack` 超標就把數字貼 #5，討論要不要調整。不需要為了這個回退。
- `/health` 紅：先照 #8 的判定逐項查（伺服器、鏡像、快照）。伺服器死了修不好就回退。

---

## 10. 回退演練（觀察日結束後，必做）

照 [`ROLLBACK.md`](ROLLBACK.md) 第 1～6 步回退，再照附錄 A 切回。驗收項目列在 ROLLBACK.md 最後。

## 11. 收尾

- [ ] **Mac mini 的 Claude**：刪除匯出檔 `rm <匯出檔>`，並確認 `ls "$(dirname "$DATA_DIR")"/dzy-bulletin-export-*.json` 沒有殘留。
  - 回退演練附錄 A 產生的第二份匯出檔也要刪。
  - `--force` 產生的 `$DATA_DIR/bulletin.db.before-migrate-*` 也含全部密碼雜湊，觀察期過後一併刪。
  - 下載暫存 `$DATA_DIR/.migrate-dl/`（全部簽名圖）若還在（簽名圖 ❌ 被接受、或中斷後沒重跑成功），`rm -rf "$DATA_DIR/.migrate-dl"`。
  - Mac mini 若有開 Time Machine，刪掉的檔仍留在備份裡。告知 Eason，由他決定要不要在 Time Machine 刪除那幾個檔的備份。
- [ ] **Eason**：GAS 指令碼屬性確認 `EXPORT_ONCE` 不存在、`PRIMARY=mini`。
- [ ] **Mac mini 的 Claude**：`/health` 的 `files.pending=0`、`files.stale=0`（第 4 步的附件首次拉檔已補完）。`$DATA_DIR/files/` 永久保留、不要刪（主管移除滿 30 天後這是唯一一份）。
- [ ] #10 驗收勾選。

## 驗收對照（#10）

| #10 驗收 | 本手冊 |
|---|---|
| 步驟 4 六項全 ✅；缺 secret 時非 0 結束（假 export 測過） | 第 3 步；`test/migrate.test.js` |
| 步驟 5 凍結後 GAS 0 筆新增、筆數相等 | 第 4 步 |
| 步驟 7 四個動作成功、不重新登入 | 第 6 步（`test/migrate.test.js` 另外驗過「搬遷前的 token／atoken 直接能用」） |
| 步驟 8 grep 回 0 或換鑰成功 | 第 7 步 |
| 步驟 10 回退演練 | 第 10 步＋ROLLBACK.md |
| 守門告警、艦隊變紅 | 第 8 步 8-1、8-2（MacBook 的 Claude，切換後當天） |
| 效能 p95／中位數／p90 | 第 9 步＋`server/latency.js` |
| 前端打不通時不白屏（run.py） | 第 8 步 8-3 |
