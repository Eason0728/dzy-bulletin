# 回退手冊：Mac mini → Apps Script（#10）

本手冊用在兩種情況：

- 切換後出問題，要退回 Google Apps Script（GAS）。
- 觀察日結束後的**回退演練**（#10 步驟 10，必做）。演練時照著「回退」做完第 1～6 步，再做〈附錄 A：再切回 Mac mini〉。

> **角色**
> - **Eason**：GAS 指令碼屬性、LINE 公告、手機與主管瀏覽器實測。
> - **Mac mini 的 Claude**：只在 Mac mini 上跑指令。
> - **MacBook 的 Claude**：改前端、push、clasp。
>
> **Claude 絕不經手 `BRIDGE_KEY`**：不印出、不貼、不寫檔。GAS 指令碼屬性只有 Eason 能改。

## 先分清楚是哪一種

| 狀況 | 走哪條 | 丟失 |
|---|---|---|
| Mac mini **還活著**（伺服器、網路都在） | 第 1 → 2 → 3 → 4 → 5 → 6 步，順序固定、不可調換 | 0 筆（前提是第 1 步先做；missing／bad 那幾張簽名圖例外，見第 2 步） |
| Mac mini **死了**（開不了機、連不到） | 〈Mac mini 死了的回退〉 | 上一次鏡像成功之後的資料 |

**鐵則**

1. **先** `PRIMARY=gas`（第 4 步），**再**改前端網址（第 5 步）。
   - `PRIMARY=gas` 同時封死 Mac mini 的鏡像：GAS 在 `PRIMARY≠mini` 時一律對 `mirror` 回 `AUTH`（#7）。
2. Mac mini 活著時，**第 1 步 `READONLY` 一定最先做**。
   - 不做的話，從第 4 步到第 5 步生效之間（Pages 快取約 10 分鐘），Mac mini 仍會收簽名，這段會丟。
3. **第 5 步生效之後，絕對不可以再跑 `mirror.js`，也不可以再設 `PRIMARY=mini`。**
   - 這時同仁已經在往 GAS 寫資料，而 `mirror` 是整份覆寫四個分頁，會把這些新資料全部蓋掉。
   - 第 5 步之後發現任何鏡像相關的問題，一律照第 6 步〈失敗怎麼辦〉處理。
4. 關 launchd 的 job 一律用 **`disable` 再 `bootout`**，恢復用 **`enable` 再 `bootstrap`**。
   - 只做 `bootout` 撐不過重開機：`~/Library/LaunchAgents/` 的 plist 重開機後會自動載入。
   - `disable` 會記在 launchd 的覆寫表裡，重開機也不會自動跑起來。

下面的指令都在 **Mac mini、repo 根目錄**執行。先設好共用的變數與小工具：

```sh
cd ~/dzy-bulletin
NODE="$HOME/.local/node/bin/node"; node() { "$NODE" "$@"; }   # Mac mini 沒把 Node 放進 PATH（DEPLOY.md〈交接給 M5〉），用函式包起來，下面的 node 指令才打得動
export DATA_DIR="$(sed -n 's/^DATA_DIR=//p' server/.env | tr -d "\"'")"; DATA_DIR="${DATA_DIR:-$HOME/dzy-bulletin-data}"; DATA_DIR="${DATA_DIR/#\~/$HOME}"
U="gui/$(id -u)"
counts() { node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});console.log(['posts','staff','reads','log'].map(t=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join('  '))" "$DATA_DIR"; }
job_off() { launchctl disable "$U/$1"; launchctl bootout "$U/$1" 2>/dev/null; launchctl print "$U/$1" >/dev/null 2>&1 && echo "✗ $1 還在跑" || echo "✓ $1 已停、已 disable"; }
job_on()  { launchctl enable "$U/$1"; launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$1.plist" && echo "✓ $1 已 enable＋載入"; }
```

---

## 1. 建立 READONLY（凍結 Mac mini）

**負責人**：Mac mini 的 Claude

```sh
touch "$DATA_DIR/READONLY"
counts | tee /tmp/dzyb-rollback-counts.txt
```

**驗證**
- `curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"ack"}'` 要回 `"code":"MOVED"`。凍結檢查在驗 token 之前，所以不帶 token 也會回 MOVED。
- `curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"roster"}'` 要回 `"ok":true`，代表讀取照常。
- 1 分鐘後再跑一次 `counts`，`log` 數字要與剛剛相同。這代表 a0 之後 Mac mini 操作紀錄 0 筆新增，也是驗收項目之一。

**失敗怎麼辦**
- `touch` 失敗（權限、磁碟滿）：**不要往下做**。
  - 先 `df -h "$DATA_DIR"`，排除問題後重做。
  - 真的做不到，就改走「Mac mini 死了」那條，並接受丟失。
- ack 沒回 MOVED：`READONLY` 可能建錯資料夾。
  - 看 `$DATA_DIR/logs/server.log` 最近一行「啟動…資料 …」寫的路徑。
  - 在那個路徑底下再 `touch` 一次。

## 2. 手動鏡像＋簽名回填，直到印出 pending=0

**負責人**：Mac mini 的 Claude

```sh
node server/mirror.js --all; echo "exit=$?"
node -e "const j=require(process.argv[1]+'/logs/mirror-last.json');console.log({ok:j.ok,pending:j.pending,missing:j.missing,bad:j.bad,missingIds:j.missingIds||[],badIds:j.badIds||[],error:j.error||''})" "$DATA_DIR"
```

`--all` 不設每輪上限，會重複掃描：把本機有圖、但還沒上 Drive 的簽名批次上傳（每批 ≤20 張），然後整份鏡像回試算表。

**判準**（M3 語意，#14 S2）：**`--all` 結束時印出 `pending=0`，而且 `ok:true`，就算完成。**

- `pending`＝本機有圖、還沒回填，是 mirror.js 還能處理的部分。**必須是 0**，不是 0 就再跑一次 `--all`。
- `missing`＝已讀有 `sigId`，但本機找不到圖檔。
- `bad`＝連續上傳失敗 3 次的壞圖。
- missing 和 bad **不要求為 0**。程式會列出是哪幾筆（`missingIds`／`badIds`），由人判斷：
  - 這幾張在 Drive 上沒有備份，回退後在 GAS **看不到簽名圖**；已讀紀錄本身（誰、哪則、時間）照樣會鏡像過去。
  - 把清單交給 Eason。Eason 決定接受的話，回退完成後在 LINE 告知那幾位同仁「簽名圖遺失，已讀紀錄仍在」，然後繼續第 3 步。
  - 想再試壞圖：從 `$DATA_DIR/logs/sig-state.json` 的 `fails` 刪掉那一筆，再跑一次 `--all`。
  - missing 通常是 `sigs/` 裡的檔被刪或搬走。先 `ls "$DATA_DIR/sigs" | wc -l` 看看；能找回原檔放回去，就再跑一次。

**失敗怎麼辦**（看 `error`）
- `鏡像：BRIDGE …`（連不到 Google、逾時）：等 1～2 分鐘再跑，Apps Script 偶爾會排隊。
  - 連續 3 次失敗：先確認 `curl -sI https://script.google.com` 通不通。
  - 網路正常卻一直失敗：停在這裡回報，**不要跳到第 4 步**，否則 Mac mini 期間的資料會丟。
- `另一輪鏡像還在跑`：每小時鏡像剛好在跑。等它結束（`logs/mirror.lock` 消失）再跑。
- `mirror` 回 AUTH：代表有人已經把 GAS 的 `PRIMARY` 改成 `gas`。
  - **只有在第 5 步還沒做**（前端仍指向 Mac mini）時，才可以請 Eason 暫時改回 `PRIMARY=mini` 再重跑。這時 GAS 不會收到新寫入：舊頁面寫入會回 MOVED，新頁面打的是 READONLY 的 Mac mini，所以是安全的。
  - 第 5 步已經做了就**禁止**這樣做（鐵則 3），改照第 6 步〈失敗怎麼辦〉處理。

## 3. 硬關卡：確認簽名檔 id 都是 Drive id，然後停掉每小時鏡像

**負責人**：Mac mini 的 Claude 查資料庫，Eason 看試算表。

**兩項都通過才可以進第 4 步，不准跳過。** 第 4 步之後就不能再鏡像（鐵則 3），這裡沒過就往下走，Mac mini 期間的簽名在 GAS 會永遠看不到。

**3-1　資料庫（Mac mini 的 Claude）**：還沒拿到 Drive id 的簽名，筆數必須剛好等於第 2 步列出的 missing＋bad。

```sh
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});const r=d.prepare(\"SELECT postId,staffId FROM reads WHERE sigId<>'' AND driveSigId=''\").all();console.log('沒有 Drive id 的簽名：'+r.length+' 筆');r.slice(0,50).forEach(x=>console.log('  '+x.postId+'/'+x.staffId))" "$DATA_DIR"
```

- 筆數＝missing＋bad，而且清單與 `missingIds`／`badIds` 相同：通過。
- 筆數比較多：回第 2 步。

**3-2　試算表（Eason）**：打開主試算表，確認三件事。
- 四個分頁「公告」「同仁」「已讀」「操作紀錄」的列數（扣掉表頭）＝第 1 步 `counts` 的四個數字。
- 「已讀」分頁最後 10 列（Mac mini 期間簽的）的「簽名檔 id」欄，全部是 **Drive id**（一串英數、沒有副檔名）。
  - 不可以是 `P-…_S-….png` 這種本機檔名。
  - 只有 3-1 清單裡的那幾筆可以是空白。
- 沒有 `…__鏡像中` 或 `…__上一輪` 分頁。

**3-3　停掉每小時鏡像（Mac mini 的 Claude）**：兩項都通過後才做。

```sh
job_off com.dzy.bulletin.mirror
```

- 為什麼要停：之後若要「再切回」，`PRIMARY=mini` 設下去的那一刻，每小時鏡像若搶先把舊的 Mac mini 庫推上去，會蓋掉 GAS 回退期間的新資料。
- 用 `disable`，重開機也不會回來。附錄 A 會再打開。

**失敗怎麼辦**
- 列數對不上，或「簽名檔 id」有本機檔名：回第 2 步再跑一次 `--all`。
  - 鏡像是「先寫暫存分頁、筆數核對過才換名」，重跑是安全的。
  - 還是不對：停下來找 MacBook 的 Claude，**不要進第 4 步**。
- 看到 `__鏡像中`／`__上一輪` 分頁殘留：再跑一次 `--all`，GAS 的 `mirror` 開頭會自動執行 `mirrorHeal_`。**不要手動刪、也不要手動改名正式分頁**。

## 4. 設定 PRIMARY=gas

**負責人**：**Eason 親手操作**

Apps Script 編輯器 →「專案設定」→「指令碼屬性」：
- 把 `PRIMARY` 改成 `gas`（或直接刪掉這個屬性，未設定就等於 `gas`）。
- 確認 `EXPORT_ONCE` 不存在，有的話刪掉。

**驗證**（Mac mini 的 Claude）
- `launchctl print gui/$(id -u)/com.dzy.bulletin.mirror` 應該回「找不到」，代表每小時鏡像確實已停。
- **不要**為了驗證 `AUTH` 而再跑 `mirror.js`。第 3 步之後 Mac mini 就不再鏡像，這一步只看屬性。

**失敗怎麼辦**
- 屬性存不進去：重新整理 Apps Script 頁面再改。
- **改成功之前不要動前端網址**。如果 GAS 仍是 `PRIMARY=mini`，前端改回去後寫入全部回 MOVED，畫面會停在「搬家中」。

## 5. 前端改回 GAS 網址、ROSTER_CSV 視情況恢復、進位版本

**負責人**：MacBook 的 Claude（Eason 核准 push）

要改的行，與 [`CUTOVER.md`](CUTOVER.md)〈5. 前端切到 Mac mini〉相反：

| 檔案 | 行 | 改成 |
|---|---|---|
| `js/config.js` | `VERSION: '…'` | 進位（例如 `0.6.0` → `0.6.1`） |
| `js/config.js` | `GAS_URL: '…'` | 原本的 Apps Script 網址。完整網址見 CUTOVER 0-6 的記錄，或 `git log -p -S "script.google.com" -- js/config.js` |
| `js/config.js` | `ROSTER_CSV: '…'` | 切換前有值就恢復原值；切換前本來就是空白（2026-09-30 是空白）就保持空白 |
| `gas/Code.js` | `var VERSION_ = '…'` | 與 `js/config.js` 同一個號碼（`tools/build.sh` 會檢查兩邊一致） |

```sh
bash tools/build.sh                 # 同步 index.html 的 ?v= 快取版本號，並跑全部測試
git add js/config.js gas/Code.js index.html && git commit -m "回退：前端改回 Apps Script（#10）" && git push
```

**驗證**：檢查頁面實際載入的是哪一份 `config.js`，不要自己加 `?v=` 繞過快取。

```sh
V=$(curl -s https://dzy-bulletin.github.io/ | grep -o 'js/config.js?v=[0-9.]*' | head -1); echo "index.html 引用：$V"
curl -s "https://dzy-bulletin.github.io/$V" | grep -E "VERSION|GAS_URL"
```

- `index.html` 引用的 `?v=` 要是新版本號。
- 那份 `config.js` 要是新版本號＋`script.google.com`。
- Pages 通常 1～10 分鐘內生效。還沒生效就每分鐘重看一次。

**失敗怎麼辦**
- build.sh 不綠：先 `git diff`，確認只改了上表那幾行。版本號兩邊不一致會直接報「前後端版本號不一致」。
- Pages 一直沒更新：GitHub → Actions 重跑 pages build。這段期間 Mac mini 仍是 READONLY，同仁只是暫時不能簽，資料不會丟。
- 網址貼錯：重做本步，版本號再進位一次。

## 6. 驗證

**負責人**：Eason 實測，Mac mini 的 Claude 查資料

- [ ] 手機重新整理佈告欄，簽一筆，成功。這筆寫進 GAS：「已讀」多一列、「操作紀錄」多一列。
- [ ] 打開一則**舊公告**的回條（最好是 Mac mini 期間有人簽的），簽名圖看得到，含 Mac mini 期間簽的。第 2 步 missing／bad 清單裡的那幾筆除外。
- [ ] 主管不重新登入就能開設定頁（secret 兩邊相同，舊的 atoken 仍有效）。
  - 例外：Mac mini 期間若用 `ADMIN_INIT.txt` 換過通行碼，GAS 不知道新通行碼，主管要用舊通行碼登入。
- [ ] Mac mini：`counts` 與第 1 步相同，代表 Mac mini 沒再收到任何寫入。
- [ ] Eason 在 LINE 群發回退公告，文案見 [`CUTOVER.md`](CUTOVER.md)〈1. LINE 公告〉的第三則。

**失敗怎麼辦**（鐵則 3：這時**禁止**再跑 `mirror.js`、禁止再設 `PRIMARY=mini`）

**狀況一：Mac mini 期間簽的某幾筆簽名圖看不到**（而且不在 missing／bad 清單裡）

- 目前**沒有**「只補試算表簽名檔 id 那一欄」的工具（`mirror` 只能整份覆寫）。**停下來找 MacBook 的 Claude。**
- 在那之前：Mac mini **維持 READONLY、鏡像維持 disable**，什麼都不要刪。
- Mac mini 的 Claude 先保存證據，放進 `$DATA_DIR/evidence-<時間>/`：
  1. 受影響的清單：在 GAS 回條看不到圖的 `postId/staffId`（Eason 提供截圖）。
  2. 那幾筆在 Mac mini 資料庫的列：`SELECT postId,staffId,at,sigId,driveSigId FROM reads WHERE …`，輸出存成文字檔。
  3. 對應的圖檔 `$DATA_DIR/sigs/<sigId>`，各複製一份。
  4. `logs/mirror-last.json`、`logs/mirror.log`、`logs/sig-state.json`，各複製一份。
  5. 資料庫快照：用 `node -e` 開唯讀連線，執行 `VACUUM INTO '<evidence 資料夾>/bulletin.db'`。
  6. 試算表那幾列「簽名檔 id」欄的截圖（Eason 提供）。
- 可能的補法由 MacBook 的 Claude 評估後再做，**本手冊不授權**：
  - 用 `sigs` 橋接的 `put`（不受 PRIMARY 限制）只上傳那幾張圖、拿到 Drive id，再由 Eason 在試算表**只改那幾格**「簽名檔 id」。
- 請同仁重簽行不通：GAS 已經有那筆已讀，會回「你已經簽過」。

**狀況二：手機寫入回 MOVED**

- 可能是 GAS 屬性沒改成功：回第 4 步。
- 也可能是手機還在用舊的 config.js：等 10 分鐘再重新整理。

---

## Mac mini 死了的回退

1. **先處理鏡像換名做到一半的情況**（Eason 在編輯器執行，或 MacBook 的 Claude 用 `clasp run mirrorHeal`）。
   - 為什麼：Mac mini 若剛好死在鏡像換名那幾秒，正式分頁可能已經被改名或不見；Mac mini 死了，就不會有下一輪幫忙修。
   - 做法：打開主試算表，看有沒有 `…__上一輪` 或 `…__鏡像中` 分頁。有的話，在 Apps Script 編輯器選 `mirrorHeal` 函式 →「執行」（`gas/Store.js` 的 `mirrorHeal()`）。
   - 執行完檢查分頁名稱：四個正式分頁「公告」「同仁」「已讀」「操作紀錄」都在，沒有 `__上一輪`。只剩 `__鏡像中` 無妨。
2. **Eason**：GAS `PRIMARY=gas`（第 4 步）。
3. **MacBook 的 Claude**：前端改回（第 5 步）。
4. 驗證：做第 6 步的前兩項。
5. **Eason** 在 LINE 公告：「〈上一次鏡像時間〉之後簽過名的同仁，請再簽一次。」
   - 上一次鏡像時間：看試算表「操作紀錄」最後一列的時間，或守門、指揮台最後一次讀到的 `mirror.at`。
   - 這些人在 GAS 上沒有已讀紀錄，所以可以重簽。
6. **Mac mini 修好開機後**：伺服器（`RunAtLoad`＋`KeepAlive`）和每小時鏡像會自己跑起來。Mac mini 的 Claude 要**第一時間**執行：
   ```sh
   touch "$DATA_DIR/READONLY"
   job_off com.dzy.bulletin.mirror
   job_off com.dzy.bulletin
   ```
   - 就算每小時鏡像搶先跑了一次，也會被 `PRIMARY=gas` 擋成 `AUTH`，不會覆寫。但之後要再切回時就危險了，所以一樣要 disable。
   - 之後要不要再切回，照附錄 A 做。伺服器在附錄 A 第 1 步再打開。

---

## 附錄 A：再切回 Mac mini（演練的後半段，#10 步驟 10d）

前提：回退已完成，GAS 是正本；Mac mini 有 `READONLY`，每小時鏡像已 disable（第 3 步，或死機回退的第 6 步）。

1. **Mac mini 的 Claude**：確認每小時鏡像沒在跑。
   - `launchctl print gui/$(id -u)/com.dzy.bulletin.mirror` 要回「找不到」。
   - 查到還在（例如重開機前只做了 bootout），立刻執行 `job_off com.dzy.bulletin.mirror`，確認停了才往下。
   - 伺服器若在死機回退時被 disable 了，現在執行 `job_on com.dzy.bulletin`。READONLY 還在，不會收寫入。
2. **Eason**：發 LINE 公告說明搬家時段（CUTOVER〈1. LINE 公告〉第一則），然後在 GAS 指令碼屬性設 `PRIMARY=mini`、`EXPORT_ONCE=1`。
3. **Mac mini 的 Claude**：
   ```sh
   node server/migrate.js --dry-run            # 呼叫 export（用掉 EXPORT_ONCE）並存檔，印筆數與預估時間；會提醒目標已有資料
   node server/migrate.js --from <上一步印出的檔> --force
   ```
   - `--force` 會先用 `VACUUM INTO` 把現有庫備份成 `bulletin.db.before-migrate-<時間>`，再整份換成 GAS 的資料。
   - 伺服器不用停：READONLY 期間伺服器不寫入，而且 migrate 是在原檔上做一筆交易。
   - 要六項全 ✅。`sigs/` 裡原有的圖不會被刪。
4. **Mac mini 的 Claude**：確認回退期間在 GAS 簽的那一筆（第 6 步第一項）已經在 Mac mini 上，例如 `counts` 的 reads 比第 1 步多 1。接著：
   ```sh
   rm "$DATA_DIR/READONLY"
   job_on com.dzy.bulletin.mirror    # RunAtLoad：載入即跑一輪
   ```
   跑完後 `logs/mirror-last.json` 要是 `ok:true`。
5. **MacBook 的 Claude**：前端改回 Mac mini 網址、進位版本，做法同 [`CUTOVER.md`](CUTOVER.md)〈5. 前端切到 Mac mini〉。
6. **Eason**：手機簽一筆；打開回退期間那筆的回條，簽名圖看得到。
7. **Mac mini 的 Claude**：刪掉匯出檔 `rm <匯出檔>`（內含密碼雜湊與登入金鑰）。
   - 確認 `ls "$(dirname "$DATA_DIR")"/dzy-bulletin-export-*.json` 沒有殘留。
   - `bulletin.db.before-migrate-*` 也含密碼雜湊，觀察幾天沒問題後也要刪。

**注意**：Mac mini 期間若換過管理通行碼（`ADMIN_INIT.txt`），再切回之後會變回 GAS 上的舊通行碼，因為搬過來的是 GAS 的雜湊。要改就再放一次 `ADMIN_INIT.txt`。

**失敗處理**
- migrate 有 ❌：
  - 不要 `rm READONLY`、不要改前端。
  - 請 Eason 設回 `PRIMARY=gas`。GAS 資料完全沒動（export 是唯讀的），前端仍指向 GAS，等於什麼都沒發生。
  - 查明原因後，用同一個匯出檔加 `--from … --force` 重跑。
  - 要把 Mac mini 退回 migrate 之前的狀態，用備份檔：`node server/restore.js <bulletin.db.before-migrate-…>`。
    - restore 會檢查 lsof、拿 mirror 和 daily 兩把鎖。
    - 加 `--launchd` 時會 bootout／bootstrap 三個 job，但**不會 enable**。所以 disable 中的 job 要先 `launchctl enable`（鏡像除外，等確定再切回才開）；或不加 `--launchd`，自己手動停、起。
- export 回 AUTH：通常是 `EXPORT_ONCE` 被上一次 dry-run 用掉了。
  - 手上有那次存下的檔，就用 `--from`。
  - 沒有，就請 Eason 重設 `EXPORT_ONCE=1`。

## 驗收對照（#10 步驟 10）

- [ ] 第 1 步之後 Mac mini 操作紀錄 0 筆新增（第 1、6 步的 `counts`）。
- [ ] 第 2 步 `--all` 結束時印出 `pending=0`；missing／bad 不是 0 時，清單已由 Eason 判斷。
- [ ] 第 3 步硬關卡兩項都通過。
- [ ] 回退後在 GAS 簽的那一筆，再切回後在 Mac mini 上；兩邊的簽名圖都看得到，含 Mac mini 期間簽的。
- [ ] 本檔進 repo。
