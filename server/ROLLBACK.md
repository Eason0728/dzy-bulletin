# 回退手冊：Mac mini → Apps Script（#10）

本手冊只有兩種情況要用：

- 切換後出問題、要退回 Google Apps Script（GAS）。
- 觀察日結束後的**回退演練**（#10 步驟 10，必做）。

演練時照著「回退」做完第 1～6 步，接著做〈附錄 A：再切回 Mac mini〉。

> **角色**
> - **Eason**：負責 GAS 指令碼屬性、LINE 公告、手機與主管瀏覽器實測。
> - **Mac mini 的 Claude**：只在 Mac mini 上跑指令。
> - **MacBook 的 Claude**：負責改前端與 push。
>
> **Claude 絕不經手 `BRIDGE_KEY`**（不印出、不貼、不寫檔）。GAS 指令碼屬性只有 Eason 能改。

## 先分清楚是哪一種

| 狀況 | 走哪條 | 丟失 |
|---|---|---|
| Mac mini **還活著**（伺服器、網路都在） | 第 1 → 2 → 3 → 4 → 5 → 6 步，順序固定、不可調換 | 0 筆（前提：第 1 步先做） |
| Mac mini **死了**（開不了機、連不到） | 直接跳到第 4 步 → 5 → 6，並發 LINE 請人補簽 | 上一次鏡像成功之後的資料 |

**鐵則**

- 任何情況都**先**做 `PRIMARY=gas`（第 4 步），**再**改前端網址（第 5 步）。
  - `PRIMARY=gas` 同時封死 Mac mini 的鏡像。GAS 在 `PRIMARY≠mini` 時一律對 `mirror` 回 `AUTH`（#7）。所以就算 launchd 忘了關，Mac mini 也蓋不掉 GAS 的新資料。
- Mac mini 活著時，**第 1 步 `READONLY` 一定最先做**。
  - 否則在第 4 步到第 5 步生效之間（GitHub Pages 快取約 10 分鐘），Mac mini 仍會收簽名，這段資料會丟。

下面的指令都在 **Mac mini、repo 根目錄**執行。先設好兩個變數，後面會重複使用：

```sh
cd ~/dzy-bulletin
export DATA_DIR="$(sed -n 's/^DATA_DIR=//p' server/.env | tr -d "\"'")"; DATA_DIR="${DATA_DIR:-$HOME/dzy-bulletin-data}"; DATA_DIR="${DATA_DIR/#\~/$HOME}"
counts() { node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});console.log(['posts','staff','reads','log'].map(t=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join('  '))" "$DATA_DIR"; }
```

---

## 1. 建立 READONLY（凍結 Mac mini）

**負責人**：Mac mini 的 Claude

```sh
touch "$DATA_DIR/READONLY"
counts > /tmp/dzyb-rollback-counts.txt; cat /tmp/dzyb-rollback-counts.txt
```

**驗證**
- `curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"ack"}'` 要回 `"code":"MOVED"`。
  - 凍結檢查排在驗 token 之前，所以不帶 token 也會回 MOVED。
- 讀取照常：`curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"roster"}'` 要回 `"ok":true`。
- 等 1 分鐘後再跑一次 `counts`，`log` 的數字要與剛剛記下的相同。這代表 a0 之後 Mac mini 操作紀錄 0 筆新增，也是驗收項目之一。

**做到一半失敗怎麼辦**
- `touch` 失敗（權限／磁碟滿）：**不要往下做**。
  - 先 `df -h "$DATA_DIR"` 看磁碟，排除問題後重做。
  - 真的做不到，就改走「Mac mini 死了」那條路（直接第 4 步），並接受丟失。
- ack 沒回 MOVED：檢查 `READONLY` 是不是建在伺服器實際使用的 DATA_DIR 底下。
  - 看 `$DATA_DIR/logs/server.log` 第一行「資料 …」的路徑。
  - 路徑不同就在正確的路徑再 `touch` 一次。

## 2. 手動鏡像＋簽名回填，重複到 pending=0

**負責人**：Mac mini 的 Claude

```sh
node server/mirror.js --all; echo "exit=$?"
node -e "const j=require(process.argv[1]+'/logs/mirror-last.json');console.log({ok:j.ok,pending:j.pending,missing:j.missing,uploaded:j.uploaded,error:j.error||''})" "$DATA_DIR"
```

- `--all` 不設每輪上限，會把所有還沒上 Drive 的簽名批次上傳（每批最多 20 張、一次橋接呼叫），接著整份鏡像回試算表。
- 如果 `pending` 不是 0，或 `ok:false`，**再跑一次** `node server/mirror.js --all`，直到 `ok:true` 且 `pending:0`。

**驗證**
- `mirror-last.json` 同時滿足三項：`ok:true`、`pending:0`、`counts` 與第 1 步 `counts` 的四個數字相同。

**做到一半失敗怎麼辦**

先看 `error`：

- `鏡像：BRIDGE …`（連不到 Google／逾時）：
  - 等 1～2 分鐘再跑，Apps Script 偶爾會排隊。
  - 連續 3 次失敗：先確認 `curl -sI https://script.google.com` 通不通。
  - 網路正常但一直失敗，就停在這裡、回報，**不要跳到第 4 步**，因為跳過去會丟掉 Mac mini 期間的資料。
- `pending` 一直卡在同一個數字，而且 `missing>0`：代表有簽名的 `sigId`，但本機圖檔不見了，這幾張永遠傳不上去。
  - 用 `node -e` 查出是哪幾筆，回報 Eason。
  - Eason 決定接受後，在 LINE 請那幾位重簽，然後繼續第 3 步。
  - 這是唯一允許 `pending≠0` 還往下走的情況，而且要 Eason 明說。
- `另一輪鏡像還在跑，這次跳過`：launchd 的每小時鏡像剛好在跑。等它結束（`logs/mirror.lock` 消失）再跑。
- `mirror` 回 AUTH：代表有人已經把 GAS 的 `PRIMARY` 改成 `gas` 了，鏡像被封死。
  - 請 Eason 暫時改回 `PRIMARY=mini`。前端網址還沒動，而且 Mac mini 有 READONLY，所以這樣改是安全的。
  - 改回後回到本步重跑，完成後再做第 4 步。

## 3. 確認鏡像成功，然後關掉每小時鏡像

**負責人**：Mac mini 的 Claude，Eason 抽查

```sh
launchctl bootout gui/$(id -u)/com.dzy.bulletin.mirror 2>/dev/null; launchctl list | grep com.dzy.bulletin
```

- 關掉鏡像後，`launchctl list` 只剩 `com.dzy.bulletin` 與 `com.dzy.bulletin.daily`。
- 關掉的原因：之後若要「再切回」，`PRIMARY=mini` 設下去的那一刻，舊的 Mac mini 庫若被每小時鏡像推上去，會把 GAS 回退期間的新資料整份蓋掉。附錄 A 會再裝回來。

**驗證**
- Eason 打開主試算表，四個分頁「公告／同仁／已讀／操作紀錄」的列數（扣掉表頭）要等於第 1 步 `counts` 的四個數字。
- 「已讀」分頁最後幾列（Mac mini 期間簽的）的「簽名檔 id」欄要有值，而且是 Drive id（長串英數），**不是** `P-…_S-….png` 這種本機檔名。
- Eason 在 GAS 編輯器執行一次 `readSig` 測試，或直接進入第 6 步驗證也可以。

**做到一半失敗怎麼辦**
- 列數對不上：回第 2 步再跑一次 `--all`。
  - 鏡像是「先寫暫存分頁、筆數核對過才換名」，失敗時正式分頁保持上一輪的完整資料，所以重跑是安全的。
- 看到 `__鏡像中` 或 `__上一輪` 分頁殘留：代表上一輪中途失敗，下一輪會自動清掉。**不要手動刪正式分頁**。

## 4. 設定 PRIMARY=gas

**負責人**：**Eason 親手操作**

1. 打開 Apps Script 編輯器，進入「專案設定」→「指令碼屬性」。
2. 把 `PRIMARY` 改成 `gas`（或直接刪除這個屬性，未設定就等於 `gas`）。
3. 確認 `EXPORT_ONCE` 不存在（有的話刪掉）。

**驗證**（Mac mini 的 Claude）
- `node server/mirror.js; echo "exit=$?"` 應該回 `exit=1`，而且 `mirror-last.json` 的 `error` 含 `AUTH`，代表鏡像已被封死，這正是我們要的結果。
  - 跑完立刻確認 `launchctl list | grep mirror` 沒有東西。
- Eason 用還開著舊頁面的手機（前端網址還沒改、仍指向 Mac mini）簽一筆，應該顯示「系統搬家中」（Mac mini 的 READONLY 在作用）。

**做到一半失敗怎麼辦**
- 改完屬性，舊頁面寫入仍回 MOVED：這是正常的，前端網址還指向 Mac mini（READONLY）。繼續做第 5 步。
- 屬性存不進去：重新整理 Apps Script 頁面再改。
  - 改不成功前**不要**動前端網址。因為 GAS 若仍是 `PRIMARY=mini`，前端改回去之後所有寫入都會回 MOVED，而且會觸發前端 5 分鐘內最多重載一次的保護，畫面停在「搬家中」。

## 5. 前端改回 GAS 網址、ROSTER_CSV 視情況恢復、進位版本

**負責人**：MacBook 的 Claude（Eason 核准 push）

要改的行：

| 檔案 | 行 | 改成 |
|---|---|---|
| `js/config.js` | `VERSION: '…'` | 進位（例如 `0.6.0` → `0.6.1`） |
| `js/config.js` | `GAS_URL: '…'` | 改回原本的 Apps Script 網址（`https://script.google.com/macros/s/AKfycbzQXAnM…/exec`，完整網址見 git 歷史：`git log -p -S "GAS_URL" -- js/config.js`） |
| `js/config.js` | `ROSTER_CSV: '…'` | 切換前若有值，就恢復原值；切換前本來就是空白（2026-09-30 是空白），就保持空白 |
| `gas/Code.js` | `var VERSION_ = '…'` | 與 `js/config.js` 同一個號碼（`tools/build.sh` 會檢查兩邊一致） |

```sh
bash tools/build.sh                 # 同步 index.html 的 ?v= 快取版本號，並跑全部測試
git add js/config.js gas/Code.js index.html && git commit -m "回退：前端改回 Apps Script（#10）" && git push
```

**驗證**
- 等 GitHub Pages 生效：`curl -s "https://dzy-bulletin.github.io/js/config.js?v=<新版本>" | grep -E "VERSION|GAS_URL"`，要看到新版本號與 `script.google.com`。
  - Pages 通常 1～10 分鐘內生效。

**做到一半失敗怎麼辦**
- build.sh 不綠：只改了三行不該壞。先 `git diff` 確認沒有誤改別處，版本號不一致會直接報「前後端版本號不一致」。
- push 後 Pages 一直沒更新：到 GitHub → Actions 看 pages build，重跑一次。
  - 這段期間 Mac mini 維持 READONLY，同仁只是暫時不能簽，資料不會丟。
- 發現網址貼錯：重做本步，版本號再進位一次。

## 6. 驗證

**負責人**：Eason 實測，Mac mini 的 Claude 查資料

- [ ] 手機重新整理佈告欄 → 簽一筆 → 成功（寫進 GAS：試算表「已讀」多一列、「操作紀錄」多一列）。
- [ ] 打開一則**舊公告**（Mac mini 期間有人簽的那種）的回條，簽名圖看得到，而且 Mac mini 期間簽的也看得到。
- [ ] 主管不重新登入就能開設定頁。
  - secret 兩邊相同，舊的 atoken 仍有效。
  - 例外：若 Mac mini 期間在 `ADMIN_INIT.txt` 換過通行碼，GAS 不知道新通行碼，主管要用舊通行碼登入。
- [ ] Mac mini：`counts` 與第 1 步相同，代表 Mac mini 沒再收到任何寫入。
- [ ] Eason 在 LINE 群發回退完成公告（文案見 `CUTOVER.md`〈LINE 公告文案〉）。

**做到一半失敗怎麼辦**
- 簽名圖看不到（只有 Mac mini 期間的）：代表第 2 步的 `pending` 其實沒有歸零，或第 3 步的「簽名檔 id」不是 Drive id。
  - Mac mini 還開著、READONLY 還在，可以請 Eason 暫時設 `PRIMARY=mini`，回到第 2 步補鏡像，再做第 4 步。
  - 這段期間前端已指向 GAS，同仁寫入會回 MOVED，所以要動作快，或先在 LINE 說明。
- 手機寫入回 MOVED：GAS 屬性沒改成功（回第 4 步），或手機還在用舊的 config.js。舊 config.js 的情況，等 10 分鐘再重新整理。

---

## Mac mini 死了的回退

1. Eason：GAS `PRIMARY=gas`（第 4 步）。
2. MacBook 的 Claude：前端改回（第 5 步）。
3. 驗證（第 6 步前兩項）。
4. Eason 在 LINE 公告：「〈上一次鏡像時間〉之後簽過名的同仁，請再簽一次。」
   - 上一次鏡像時間：看試算表「操作紀錄」最後一列的時間，或指揮台／守門最後一次讀到的 `mirror.at`。
5. Mac mini 修好之後，**先不要開伺服器**。先建 `READONLY`，再決定要不要再切回（附錄 A）。

---

## 附錄 A：再切回 Mac mini（演練的後半段，#10 步驟 10d）

前提：回退已完成，GAS 是正本；Mac mini 還有 `READONLY`，每小時鏡像已關（第 3 步）。

1. **Mac mini 的 Claude**：先確認每小時鏡像沒在跑，也就是 `launchctl list | grep com.dzy.bulletin.mirror` 沒有東西。
   - 這一步一定要先做。否則 Eason 設下 `PRIMARY=mini` 的那一刻，舊庫可能被推上去蓋掉 GAS 回退期間的新資料。
2. **Eason**：LINE 公告搬家時段 → GAS 指令碼屬性設 `PRIMARY=mini`、`EXPORT_ONCE=1`。
3. **Mac mini 的 Claude**：
   ```sh
   node server/migrate.js --dry-run            # 呼叫 export（用掉 EXPORT_ONCE）並存檔，印筆數與預估時間；會提醒目標已有資料
   node server/migrate.js --from <上一步印出的檔> --force
   ```
   - `--force`：先用 `VACUUM INTO` 把現有庫備份成 `bulletin.db.before-migrate-<時間>`，再整份換成 GAS 的資料。
   - 伺服器不用停，READONLY 期間伺服器不會寫入。
   - 要六項全 ✅。`sigs/` 裡原有的圖檔不會被刪除。
4. **Mac mini 的 Claude**：確認回退期間在 GAS 簽的那一筆（第 6 步第一項）已在 Mac mini 上，例如 `counts` 的 reads 比第 1 步多 1。
   - 接著 `rm "$DATA_DIR/READONLY"`，再裝回每小時鏡像：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dzy.bulletin.mirror.plist && launchctl kickstart gui/$(id -u)/com.dzy.bulletin.mirror`。
   - 等它跑完，`logs/mirror-last.json` 要是 `ok:true`。
5. **MacBook 的 Claude**：前端改回 Mac mini 網址、進位版本（與 `CUTOVER.md` 步驟 6 相同）。
6. **Eason**：手機簽一筆、打開回退期間那筆的回條，簽名圖看得到。
7. **Mac mini 的 Claude**：刪匯出檔（`rm <匯出檔>`，內含密碼雜湊與登入金鑰），並確認 `ls "$(dirname "$DATA_DIR")"/dzy-bulletin-export-*.json` 沒有殘留。

**失敗處理**
- migrate 有 ❌：不要 `rm READONLY`、不要改前端。
  - 請 Eason 設回 `PRIMARY=gas`。GAS 資料完全沒動，因為 export 是唯讀的。
  - 前端仍指向 GAS，等於什麼都沒發生。
  - 需要時可以用備份檔還原 Mac mini：`node server/restore.js <備份檔>`，詳見 restore.js 說明。
- export 回 AUTH：通常是 `EXPORT_ONCE` 被上一次的 dry-run 用掉了。
  - 若手上有那次存下的檔，就用 `--from` 繼續。
  - 若沒有，請 Eason 重設 `EXPORT_ONCE=1`。

## 驗收對照（#10 步驟 10）

- [ ] 第 1 步之後 Mac mini 操作紀錄 0 筆新增（第 1、6 步的 `counts`）。
- [ ] 第 2 步結束時 `pending=0`（`mirror-last.json`）。
- [ ] 回退後在 GAS 簽的那一筆，再切回後在 Mac mini 上，兩邊的簽名圖都看得到（含 Mac mini 期間簽的）。
- [ ] 本檔進 repo。
