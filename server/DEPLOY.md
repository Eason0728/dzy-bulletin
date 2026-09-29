# 鼎兆元｜電子佈告欄 — Mac mini 部署手冊（M4，#9）

給 **Mac mini 上的 Claude** 從頭照做。做完＝伺服器在 Mac mini 常駐、停電重開不碰鍵盤自己恢復、**不在 tailnet 的**手機用 4G 經 Tailscale Funnel 打得到 `/health`。
本手冊**只部署、不搬資料**：前端 `js/config.js` 仍指向 Apps Script，同仁完全不受影響；資料搬遷與切換是下一張 M5（#10）。

定案（#9【定案 r2】）：**不開 FileVault＋自動登入＋LaunchAgent＋Tailscale 官方 App**。

---

## ⛔ 最前面：`.env` 禁令（違反任一條＝部署失敗，要請 Eason 換金鑰）

`server/.env` 裝著 `BRIDGE_KEY`——整套系統的萬能鑰匙（能匯出全部同仁密碼雜湊與登入金鑰）。Mac mini 的 Claude：

1. **不** `cat`／`less`／`head`／`tail`／`open`／`echo`／`Read` 這個檔，也不用任何工具「看一下內容」。
2. **不** 執行會把環境變數全印出來的指令：`env`、`printenv`、`set`、`export -p`、`launchctl getenv BRIDGE_KEY`、`ps eww`。
3. **不** 把 `.env` 的內容或片段貼進對話、issue、留言、commit、檔案。
4. **不** 自己產生、也不經手 `BRIDGE_KEY`：由 Eason 在**他自己開的「終端機」App 視窗**裡產生並貼入（不是在 Claude 的對話框裡用 `!` 執行）。
5. 要確認格式，只准用「回傳數字」的指令，例如 `grep -c '^BRIDGE_KEY=.\{32,\}$' "$HOME/dzy-bulletin/server/.env"`（回 `1` 即可）。
6. `.env` 不進 git（`.gitignore` 已列 `server/.env*`），權限 `600`。
7. 技術保險：第 3 步 A10 會請 Eason 在這台 Claude Code 的設定加上 `Read` 禁止規則。**不要**用「試讀一次看會不會被擋」來驗證規則——規則若沒生效，金鑰就進對話了。

同一原則適用 `DATA_DIR/ADMIN_INIT.txt`（管理通行碼明文）：**本手冊不建立、不讀取這個檔**。管理通行碼在 M5 搬遷時連同雜湊一起帶過來。

---

## 手冊約定

- 所有路徑都從 `$HOME` 推導，手冊裡沒有任何人的帳號名稱。
- `<...>` 是佔位：網址、金鑰、試算表 ID 一律不寫進本手冊、issue、commit。**Funnel 網址是部署時產生的，只在對話裡交給 Eason**（他轉給負責 M5 的人填 `js/config.js`），不寫進 #9 留言。
- **每一段指令前都先貼這一行**（Claude 的每次 Bash 呼叫是新的 shell，變數不會留著）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
```

- Eason 要親手做的事只有**兩批**，都集中成一張清單：**第 3 步（部署前）**、**第 8 步（現場驗證）**。Claude 做到那裡就**停下來**，把那一批整段貼給 Eason，等他說「做完了」再跑驗證。其他步驟都是 Claude 自己做，不需要 sudo。
- 背景程序一律寫成「單一指令加 `&`、下一行 `echo $! > pid 檔`」，**不要**寫成 `cd … && 指令 &`（bash 會把整串丟進子 shell，`$!` 變成子 shell 的 PID，kill 之後 node 還活著）。只關自己記下的那個 PID。
- 等伺服器起來一律用 `curl --retry … --retry-connrefused`，不用 `sleep`。

---

## 第 0 步：查現況並回報（只讀、不改任何東西）

（照 Eason 那段話，repo 應該已經 clone 在 `~/dzy-bulletin`；第一次跑 git 跳出的「安裝命令列開發者工具」對話框 Eason 應已按過安裝。）

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
echo "== 使用者"; whoami; echo "HOME=$HOME uid=$(id -u) shell=$SHELL"
echo "== FileVault"; fdesetup status
echo "== 自動登入"; defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "（未設定自動登入）"
echo "== 晶片"; uname -m
echo "== macOS"; sw_vers
echo "== 時區"; date; readlink /etc/localtime
echo "== 電源"; pmset -g | grep -E '^ *(autorestart|sleep|disksleep) '
echo "== 自動更新"; defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo "（未明確設定＝依系統預設，通常是開）"
echo "== Tailscale"; ls -d /Applications/Tailscale.app 2>/dev/null && "$TS" version | head -1 || echo "（沒有官方 App）"; command -v tailscale tailscaled 2>/dev/null; (command -v brew >/dev/null && brew list --formula 2>/dev/null | grep -x tailscale) || true
echo "== Node"; command -v node && node -v; ls -l "$HOME/.local/node" 2>/dev/null; "$NODE" -v 2>/dev/null || echo "（~/.local/node 尚未安裝）"
echo "== git"; git --version 2>&1 | head -1
echo "== repo"; git -C "$REPO" log --oneline -1 2>/dev/null && git -C "$REPO" branch --show-current || echo "（尚未 clone）"
echo "== 埠 $PORT"; lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "（沒有人在聽，正常）"
echo "== 既有 job"; ls ~/Library/LaunchAgents/com.dzy.bulletin* 2>/dev/null || echo "（無）"
echo "== 既有資料"; ls -d "$DATA" 2>/dev/null || echo "（無）"
echo "== Claude 設定"; ls -l ~/.claude/settings.json 2>/dev/null || echo "（沒有 ~/.claude/settings.json）"
echo "== 磁碟"; df -h "$HOME" | tail -1
```

判讀與回報（把下表填好貼給 Eason，**然後停下來等他確認**）：

| 項目 | 期望 | 不符時 |
|---|---|---|
| FileVault | `FileVault is Off.` | 若為 On：**停**。問 Eason 要關（系統設定 → 隱私權與安全性 → FileVault → 關閉，需數小時解密）還是改走附錄 A |
| 自動登入 | 顯示部署帳號名稱 | 列入第 3 步 A4 |
| 晶片 | `arm64`（Apple Silicon）或 `x86_64`（Intel） | 第 1 步依此選 Node 檔 |
| macOS | 記下版本 | 系統設定的選單名稱依版本略有不同，照意思找 |
| 時區 | `date` 顯示 `CST`，`/etc/localtime` 指到 `Asia/Taipei` | 列入 A2 |
| 電源 | `autorestart 1`、`sleep 0`、`disksleep 0` | 列入 A1 |
| 自動更新 | `0` | 列入 A3 |
| Tailscale | 只有官方 App（`/Applications/Tailscale.app`） | 沒裝→A7；**若同時有 Homebrew `tailscale`／`tailscaled`：停**，請 Eason 決定移除（兩個版本會搶同一台機器的身分） |
| Node | `~/.local/node` 為 v24.x | 第 1 步安裝；系統裡另有 Homebrew `node` 沒關係，但本服務**不用它** |
| git／repo | 印出版本號；repo 在 `mini/m4`（或已合併後的 `main`），且 `server/DEPLOY.md` 存在 | 尚未 clone 由第 2 步處理 |
| 埠 8793 | 沒人在聽 | 查是誰（`lsof` 會列出程序），請 Eason 決定 |
| 既有 job／`$DATA` | 無 | 有的話**停**，不要覆蓋，回報給 Eason |

**前提（請 Eason 口頭確認）**：Apps Script 已部署 M2（#7）的橋接版本，指令碼屬性 `PRIMARY` 目前是 `gas`（或未設）。

---

## 第 1 步：Node（固定主版本 24，Claude 做，不用 sudo）

不要用 Homebrew 的 `node`（它會自己升大版；`node:sqlite` 還在演進，升大版要先在 MacBook 跑過契約測試）。用官方 tar.gz 解到 `~/.local`，再用 `~/.local/node` 這個捷徑指過去——之後 24.x 小版升級只換捷徑，launchd 設定不用改。
下載放在 `~/.local/src`（**不要**用「下載」資料夾：它受 macOS 權限保護，背景存取會跳對話框或 `Operation not permitted`）。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo "未知晶片"; exit 1;; esac
NODE_DIST="<Node 官方發行站的 latest-v24.x 目錄（Node.js 官網 → 下載 → 預先編譯的二進位檔；不含結尾斜線）>"
mkdir -p "$HOME/.local/src" && cd "$HOME/.local/src" \
 && curl -fsSLO "$NODE_DIST/SHASUMS256.txt" \
 && F=$(grep -o "node-v24\.[0-9.]*-darwin-$ARCH\.tar\.gz" SHASUMS256.txt | head -1) && echo "檔名：$F" \
 && curl -fsSLO "$NODE_DIST/$F" \
 && grep " $F\$" SHASUMS256.txt | shasum -a 256 -c - \
 && tar -xzf "$F" -C "$HOME/.local" \
 && ln -sfn "$HOME/.local/${F%.tar.gz}" "$HOME/.local/node" \
 && "$NODE" -v && "$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')"
```

- 期望最後印出 `…: OK`（SHA256 相符）、`v24.x.y`、`node:sqlite OK`。任一環失敗，後面都不會執行；刪掉 `~/.local/src` 裡的檔重來。
- `NODE_DIST` 由 Mac mini 的 Claude 自己填上官方網址（本手冊不寫網址）；**只能是 Node.js 官方網站**，不要用鏡像站。
- 本服務的程式不會用名字去呼叫 `node`，launchd 設定裡是絕對路徑，所以不必改 shell 的 `PATH`（手動執行時一律寫 `"$HOME/.local/node/bin/node"`）。

---

## 第 2 步：程式、資料夾與 `.env` 骨架（Claude 做）

**位置固定在 `$HOME/dzy-bulletin`**，不要放在「桌面」「文件」「下載」底下——macOS 會擋背景程式讀那幾個資料夾（log 會出現 `Operation not permitted`）。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
BRANCH="mini/m4"                                            # M1～M4 已合併到 main 時改成 main（以 Eason 那段話為準）
if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch -q origin && git -C "$REPO" checkout -q "$BRANCH" && git -C "$REPO" pull -q --ff-only; else git clone -q -b "$BRANCH" "<repo 網址>" "$REPO"; fi
git -C "$REPO" log --oneline -1
mkdir -p "$DATA/logs" && chmod 700 "$DATA"                  # logs 一定要先建：launchd 開不了 log 檔就不會啟動
git -C "$REPO" check-ignore -q server/.env && echo "server/.env 已被 git 忽略" || echo "✗ .gitignore 沒有 server/.env，停下來回報"
```

建 `.env` 骨架（不含金鑰；`BRIDGE_URL` 從 `js/config.js` 取目前的 Apps Script 網址，直接寫進檔案、不印出來）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
test -e "$REPO/server/.env" && { echo "✗ .env 已存在，不要覆蓋，回報 Eason"; exit 1; }
( umask 077
  printf 'PORT=8793\nDATA_DIR=%s\n' "$DATA" > "$REPO/server/.env"
  printf 'BRIDGE_URL=%s\n' "$(sed -n "s/^ *GAS_URL: '\([^']*\)'.*/\1/p" "$REPO/js/config.js")" >> "$REPO/server/.env" )
chmod 600 "$REPO/server/.env"
grep -c '^BRIDGE_URL=https://.*/exec$' "$REPO/server/.env"   # 期望 1
```

- `ALLOW_ORIGIN` 不寫：程式預設就是正式前端網域（見 `server/index.js` 的 `config()`）；只有改網域時才加。
- **不得**有 `E2E`（那是測試模式，會打開無金鑰清空資料的入口）。`BACKUP_PASS` 已取消（#8）。
- `BRIDGE_KEY` 在第 3 步由 Eason 貼入。

---

## 第 3 步：【Eason 第一批｜部署前】一次做完

**前置條件**：第 0 步的回報 Eason 已確認；第 1 步（Node）與第 2 步（`.env` 骨架）Claude 已做完且都通過。
Claude 把下面 A1～A10 整段貼給 Eason。Eason 在 Mac mini 前面、**用他自己開的「終端機」App**（不是 Claude 對話框）做完，說「做完了」後 Claude 跑本節最後的「驗證」。
（輸入 sudo 密碼時畫面**不會出現任何字**，照打再按 Enter 就好。）

**A1　電源（sudo）**：停電恢復後自動開機、永不睡眠。
```sh
sudo pmset -a autorestart 1 sleep 0 disksleep 0
```

**A2　時區**：每日快照排在台北 03:30，時區錯了就錯班。
```sh
sudo systemsetup -settimezone Asia/Taipei
```
若這行回 `Error:-99` 或要求「完整磁碟取用權限」，**就改走圖形介面**：系統設定 → 一般 → 日期與時間 → 關掉「自動設定時區」→ 最接近的城市選「台北」；同時確認「自動設定日期與時間」是**開著**的。

**A3　關閉 macOS 自動安裝更新**：系統設定 → 一般 → 軟體更新 → 「自動更新」旁的 ⓘ → 關掉「安裝 macOS 更新」（「下載新的更新」可留著）。否則半夜自己重開、卡在更新畫面。之後由 Eason 挑時間手動更新，更新後照第 8 步 V5 再驗一次。

**A4　自動登入**：系統設定 → 使用者與群組 → 「自動以此身分登入」→ 選部署帳號（會要求輸入該帳號密碼）。
⚠ 這個選項是灰的＝FileVault 開著，回第 0 步處理。

**A5　永遠不開 FileVault**：確認系統設定 → 隱私權與安全性 → FileVault 為「關閉」。以後也不要打開；真的要開，照附錄 A 改走 LaunchDaemon。

**A6　螢幕保護後立即要求密碼**（自動登入的補償措施）：系統設定 → 鎖定畫面 → 「螢幕保護程式啟動或顯示器關閉後要求密碼」→「立即」；並設定一個螢幕保護程式啟動時間（例如 5 分鐘）。Mac mini 放在有門禁的位置。

**A7　Tailscale 官方 App**：從 Tailscale 官網下載 macOS 版（Standalone 版優先，App Store 版也可以）→ 安裝 → 打開 → 允許系統延伸功能與 VPN 設定（跳出的對話框按「允許」，必要時到隱私權與安全性按「允許」）→ 用 Eason 的 Tailscale 帳號登入 → 在 App 的設定勾「登入時啟動」（Launch at login）。

**A8　Tailscale 管理後台**（`<Tailscale 管理後台>`，用 Eason 帳號）——這裡**先把 Funnel 相關的同意全部做完**，Claude 第 7 步開 Funnel 時就不會卡住等同意：
- Machines → 這台 Mac mini → ⋯ → **Disable key expiry**（個人版預設 180 天過期，到期＝整站斷線）。截圖（遮掉網址與 tailnet 名稱）留著貼 #9。
- DNS → 確認 **MagicDNS** 已啟用、**HTTPS Certificates** 已啟用（Funnel 需要）。
- Access controls（存取控制）→ 確認有允許這台機器使用 Funnel 的 `funnel` 節點屬性（後台的 Funnel 設定頁可一鍵加入；個人版預設政策通常已含）。

**A9　BRIDGE_KEY（一律產生新的一把；Eason 自產、親手貼兩處；Claude 不經手）**
現在 Apps Script 還是 `PRIMARY=gas`、橋接沒有人在用，換新金鑰沒有代價；M2 時設過的那把不確定經過哪些機器，**不要沿用**。
1. 在終端機 App 產生，直接進剪貼簿（不會顯示在畫面上）：
   ```sh
   openssl rand -hex 32 | tr -d '\n' | pbcopy
   ```
2. 在 Mac mini 的瀏覽器打開 Apps Script → 專案設定 → 指令碼屬性 → `BRIDGE_KEY`：有就把值**整個換掉**、沒有就新增，貼上 → 儲存。
3. 回終端機 App，執行這一行（先刪掉舊的 `BRIDGE_KEY` 行，再把剪貼簿內容去掉空白後接到最後一行，最後清空剪貼簿）：
   ```sh
   sed -i '' '/^BRIDGE_KEY=/d' "$HOME/dzy-bulletin/server/.env"; printf 'BRIDGE_KEY=%s\n' "$(pbpaste | tr -d '[:space:]')" >> "$HOME/dzy-bulletin/server/.env"; pbcopy < /dev/null
   ```
4. 若有開 Spotlight 的剪貼簿紀錄或第三方剪貼簿工具，把紀錄裡那一筆刪掉。
5. 不要把金鑰貼進 Claude 的對話框、LINE、issue、任何檔案。

**A10　Claude Code 的 `.env` 禁止讀取規則**（技術保險，文字禁令之外再加一道）。在終端機 App 執行（會把規則合併進 `~/.claude/settings.json`，已有的設定不動）：
```sh
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json'); os.makedirs(os.path.dirname(p), exist_ok=True)
d = json.load(open(p)) if os.path.exists(p) else {}
deny = d.setdefault('permissions', {}).setdefault('deny', [])
for r in ["Read(~/dzy-bulletin/server/.env)", "Read(~/dzy-bulletin/server/.env*)",
          "Edit(~/dzy-bulletin/server/.env)", "Read(~/dzy-bulletin-data/ADMIN_INIT.txt)"]:
    if r not in deny: deny.append(r)
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2); print('OK')
EOF
```
加進去的 JSON 長這樣（供對照）：
```json
{ "permissions": { "deny": [
  "Read(~/dzy-bulletin/server/.env)",
  "Read(~/dzy-bulletin/server/.env*)",
  "Edit(~/dzy-bulletin/server/.env)",
  "Read(~/dzy-bulletin-data/ADMIN_INIT.txt)"
] } }
```
做完後把 Claude 關掉再重新打開（確保新規則生效），跟它說「第 3 步做完了」。這條規則擋的是 Claude 的讀檔工具；`cat` 之類的指令仍靠上面的文字禁令。

**驗證（Claude 在 Eason 說做完之後跑；全部只印設定值或數字）：**
```sh
REPO="$HOME/dzy-bulletin"
pmset -g | grep -E '^ *(autorestart|sleep|disksleep) '     # 期望 autorestart 1、sleep 0、disksleep 0
date; readlink /etc/localtime                               # 期望 CST、…/Asia/Taipei
defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates   # 期望 0
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser                          # 期望＝部署帳號（whoami）
fdesetup status                                             # 期望 FileVault is Off.
/Applications/Tailscale.app/Contents/MacOS/Tailscale status | head -3   # 期望第一行是這台機器、不是 Logged out
ls -l "$REPO/server/.env"                                   # 期望 -rw-------
grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$REPO/server/.env"    # 期望 1（0＝沒貼到或帶了怪字元；請 Eason 重做 A9 第 1～3 點）
grep -c '^E2E' "$REPO/server/.env"                          # 期望 0
git -C "$REPO" status --porcelain | grep -c '\.env'         # 期望 0（git 看不到它）
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/settings.json'))); print(sum('dzy-bulletin/server/.env' in r for r in d['permissions']['deny']))"   # 期望 ≥ 2
```
A6 螢幕鎖定、A8 key expiry／Funnel 同意無法用指令驗證：請 Eason 目視確認並回覆「A6、A8 已確認」。

---

## 第 4 步：前景試跑（還不交給 launchd）

用正式設定起一次，確認 Node、`.env`、資料夾都對。**只關自己起的那個 PID**。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; PORT=8793
DATA_DIR="$DATA" "$NODE" "$REPO/server/index.js" > "$DATA/logs/manual-run.log" 2>&1 &
echo $! > "$DATA/logs/manual-run.pid"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/health"; echo
```

（`index.js` 用自己的位置找檔案與 `.env`，不需要先 `cd`。）
期望：`"ok":true`、`"e2e":false`、`"bridge":"configured"`；`level` 此時是 `red`（還沒有鏡像與快照紀錄，第 6 步後會好）。再驗：

```sh
DATA="$HOME/dzy-bulletin-data"; PORT=8793
lsof -nP -iTCP:$PORT -sTCP:LISTEN                                                         # 期望只有一行 127.0.0.1:8793
[ "$(lsof -t -iTCP:$PORT -sTCP:LISTEN)" = "$(cat "$DATA/logs/manual-run.pid")" ] && echo "聽 8793 的就是剛起的 node" || echo "✗ PID 不符，停下來回報"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/__seed" -d '{}'  # 期望 404（正式模式沒有測試入口）
curl -s -X POST "http://127.0.0.1:$PORT/" -H 'Content-Type: text/plain' -d '{"action":"roster"}' | head -c 120; echo   # 期望 {"ok":true,"data":[]}（還沒搬資料，名單是空的）
```

關掉前景那一個（只關自己的 PID），並確認 8793 已釋放：

```sh
DATA="$HOME/dzy-bulletin-data"; kill "$(cat "$DATA/logs/manual-run.pid")" && rm "$DATA/logs/manual-run.pid"
lsof -nP -iTCP:8793 -sTCP:LISTEN || echo "8793 已釋放"          # 期望「8793 已釋放」；還看得到就隔幾秒再跑這一行，仍在就停下來回報
```

第一次啟動會在 `$DATA` 建 `bulletin.db`（空庫＋一把新的登入金鑰）。M5 搬遷會用 Apps Script 匯出的資料整份換掉，所以沒關係。

---

## 第 5 步：安裝三個 LaunchAgent

三個 job（全部在 `~/Library/LaunchAgents/`，不需 sudo）：

| Label | 做什麼 | 排程 |
|---|---|---|
| `com.dzy.bulletin` | 伺服器本體 | 登入即啟動、`KeepAlive`、當掉 10 秒內重起（`ThrottleInterval 10`） |
| `com.dzy.bulletin.mirror` | 鏡像回試算表＋簽名圖回填 Drive | 載入（含重開機）時馬上跑一輪（`RunAtLoad`），之後每小時（`StartInterval 3600`） |
| `com.dzy.bulletin.daily` | DB 快照上傳雲端 | 每天 03:30（台北） |

替換範本裡的 `__NODE__`／`__REPO__`／`__DATA_DIR__`，檢查後載入：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"
lsof -nP -iTCP:8793 -sTCP:LISTEN && { echo "✗ 8793 還有人在聽（第 4 步沒關乾淨？），先處理再載入"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
for f in "$REPO"/server/launchd/*.plist; do
  sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__DATA_DIR__#$DATA#g" "$f" > "$HOME/Library/LaunchAgents/$(basename "$f")"
done
cd "$HOME/Library/LaunchAgents"
plutil -lint com.dzy.bulletin.plist com.dzy.bulletin.mirror.plist com.dzy.bulletin.daily.plist   # 三個都要 OK
grep -c '__[A-Z_]*__' com.dzy.bulletin.plist com.dzy.bulletin.mirror.plist com.dzy.bulletin.daily.plist   # 三個都要 0
grep -l '<key>BRIDGE_' com.dzy.bulletin*.plist || echo "plist 不含金鑰（正確）"   # 只比對設定鍵；範本註解裡提到 BRIDGE_KEY 字樣不算
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$j.plist" && echo "載入 $j"; done
curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8793/health; echo
```

驗證：

```sh
U="gui/$(id -u)"
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do echo "== $j"; launchctl print "$U/$j" | grep -E '^\s*(state|pid|last exit code|run interval) ='; done
LP=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); SP=$(lsof -t -iTCP:8793 -sTCP:LISTEN)
[ -n "$LP" ] && [ "$LP" = "$SP" ] && echo "聽 8793 的就是 launchd 的 node（PID $LP）" || echo "✗ launchd PID=$LP、聽 8793 的 PID=$SP，不一致：停下來看故障排除 A"
```

期望：三個都印得出來（＝已載入）；`com.dzy.bulletin` 是 `state = running` 且有 `pid`，而且那個 PID 就是聽 8793 的程序；daily 是 `not running`（等 03:30）；mirror 在載入當下已自己跑了一輪（`RunAtLoad`），此時多半已跑完、顯示 `not running` 與 `last exit code = 1`（M4 階段被擋是預期，見第 6 步）。
如果 macOS 右上角跳出「已加入背景項目」通知，是正常的；**不要**在系統設定 → 一般 → 登入項目 裡把 `node` 關掉。

**殺掉會自己重起**（驗收項目：10 秒內）：

```sh
U="gui/$(id -u)"
P1=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); echo "原 PID $P1"
T0=$(date +%s); kill "$P1"
curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8793/health && echo "已恢復，約 $(( $(date +%s) - T0 )) 秒"
P2=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); echo "新 PID $P2"   # 要和原 PID 不同；秒數 ≤ 10
```

---

## 第 6 步：鏡像與快照各手動跑一次

- **mirror 不用再手動跑**：第 5 步 `bootstrap` 時它已經因 `RunAtLoad` 由 launchd 跑過一輪，這一輪就是驗收的「手動跑一次」。**不要**再 `kickstart` mirror——M4 階段每跑一次都被擋、失敗次數 +1，到 2 次 `/health` 就轉黃。
- daily 用 `kickstart` 走 launchd 跑（順便驗證 plist 本身能跑）：

```sh
U="gui/$(id -u)"
launchctl kickstart "$U/com.dzy.bulletin.daily"
```

等一兩分鐘（Apps Script 可能要排隊）後查（這兩個結果檔與 log 不含金鑰，可以印）：

```sh
DATA="$HOME/dzy-bulletin-data"
cat "$DATA/logs/backup-last.json"; echo; tail -3 "$DATA/logs/daily.log"
cat "$DATA/logs/mirror-last.json"; echo; tail -3 "$DATA/logs/mirror.log"
curl -s http://127.0.0.1:8793/health; echo
```

判讀——**M4 階段 Apps Script 還是 `PRIMARY=gas`，所以兩個結果不一樣是對的**。下表的字串是 `*-last.json` 的 `error` 欄位實際會出現的原文：

| 看到什麼 | 意思 | 怎麼做 |
|---|---|---|
| `backup-last.json`：`"ok":true`、`"sharedWith":0`；`daily.log` 有「備份完成」 | 橋接網址與金鑰都對，快照已上傳到雲端「鼎兆元｜電子佈告欄備份」資料夾 | 正常（第 8 步 V1 請 Eason 看一眼雲端硬碟）。這個資料夾**不要分享給任何人**（備份含密碼雜湊與登入金鑰）；有共用者時 `sharedWith` 大於 0、`/health` 亮黃燈 |
| `mirror-last.json`：`"ok":false`，`"error":"鏡像：BRIDGE mirror: AUTH 目前不接受這個橋接動作"` | **M4 的正確結果**：金鑰正確、橋接打得通，Apps Script 在 `PRIMARY=gas` 時擋下鏡像（還沒切換前，Mac mini 的空庫絕不能蓋掉正式試算表） | 正常。真正的 `ok:true` 在 M5 設 `PRIMARY=mini`、搬完資料之後 |
| `"error":"鏡像：BAD_REQ 鏡像資料全空，拒絕覆寫"` | **危險訊號**：Apps Script 現在是 `PRIMARY=mini`——正式站的寫入正在回 MOVED，**同仁此刻簽不了名**（Apps Script 的防呆擋下了空庫，試算表沒被清空） | **立刻停下所有步驟**，告訴 Eason：「請馬上到 Apps Script 指令碼屬性把 `PRIMARY` 改回 `gas`」。改完後 `launchctl kickstart gui/$(id -u)/com.dzy.bulletin.mirror` 跑一次確認，應變回上一列 |
| `"error":"鏡像：BRIDGE mirror: AUTH 橋接金鑰錯誤"`（daily 則是 `BRIDGE backup: AUTH 橋接金鑰錯誤`） | 兩邊金鑰不一致 | 故障排除 D |
| 其他（`BRIDGE_TIMEOUT`、`回應不是 JSON`、`未設定 Google 橋接`…） | 見故障排除 D | — |
| `mirror-last.json` 的 `missing`／`bad` 大於 0 | 本機缺簽名圖／壞簽名圖（M4 空庫不會出現；M5 之後才可能） | `/health` 會黃；清單在 `missingIds`／`badIds` 與 `mirror.log`，回報 Eason，不要自己刪資料。壞圖（bad）要重試時，由負責的人把 `$DATA/logs/sig-state.json` 裡那筆刪掉，下一輪就會再傳 |

此時 `/health` 應為 `"level":"green"`（鏡像失敗次數 1，未達黃燈門檻 2）——**把這一刻的 `/health` 回應存下來貼進回報**。
**已知且預期**：之後每小時（以及每次重開機載入時）的鏡像都會被擋，下一輪之後 `/health` 就轉 `yellow`（`why` 為「鏡像連續失敗」），直到 M5 切換。M5 之前守門還沒接上，不會告警。

---

## 第 7 步：Tailscale Funnel（443 → 127.0.0.1:8793）

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" status | head -3
"$TS" funnel status                                          # 期望：目前沒有任何設定（No serve config）
perl -e 'alarm shift; exec @ARGV' 60 "$TS" funnel --bg 8793; echo "結束碼 $?"
```

- 最後一行用 `perl alarm` 包了 60 秒逾時：如果 Funnel 或 HTTPS 還沒在後台同意，CLI 會印出一個連結然後**停在那裡等**。
- 看到連結、或結束碼是 `142`（逾時被中止）：**停**，把連結交給 Eason，請他到後台同意（第 3 步 A8 應該已做，這是漏網的情況），他說好了再跑一次最後那行。
- 成功後：

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" funnel status
```

期望**只有一條**對外設定：找以 `https://` 開頭、後面有 `(Funnel on)` 的那一行（上面可能有一行 `# Funnel on:` 之類的註解），底下是 `|-- / proxy http://127.0.0.1:8793`。有別的條目（其他埠、其他路徑）就 `"$TS" funnel reset` 後重做。

記下 Funnel 網址（上面那行的 `https://…ts.net`），**只在對話裡交給 Eason**，不寫進任何檔案、commit、#9 留言。

**從 tailnet 外面驗證**（Claude 自己做得到）：這台機器本身在 tailnet 裡，直接打 Funnel 網址可能走 tailnet 內部、不經 Funnel。改成向公開 DNS（`1.1.1.1`）查這個名稱、再強迫 curl 連那個公開 IP——這條路一定經過 Tailscale 的公開 Funnel 入口：

```sh
H="<Funnel 主機名，也就是網址 https:// 後面、結尾 .ts.net 為止>"
IP=$(dig +short "$H" @1.1.1.1 | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1); echo "公開 IP：$IP"   # 不能是空的、不能是 100. 開頭（100.x 是 tailnet 內部位址）
curl -s --max-time 20 --resolve "$H:443:$IP" "https://$H/health"; echo                                        # 期望 {"ok":true,…}
```

- 第一次開 Funnel 時，公開 DNS 最多可能要**約 10 分鐘**才查得到、首張 HTTPS 憑證也要幾十秒。`IP` 是空的或 TLS 錯誤就隔幾分鐘再跑，**10 分鐘內都不算失敗**。
- 這一段需在實機確認 `dig` 的結果形式；若公開 DNS 回的不是 A 紀錄（例如只有 CNAME），用 `dig +short "$H" @1.1.1.1` 看完整輸出，取最後的 IPv4。

手機驗證併入第 8 步那一批。

---

## 第 8 步：【Eason 第二批｜現場驗證】一次做完

**前置條件**：第 4～7 步都通過（第 7 步「從 tailnet 外面驗證」已回 `{"ok":true…}`）。

交給 Eason 之前，Claude 先把 V2 要看的本機網頁打開（模擬「後端打不通」；正式前端要到 M5 才指向 Funnel，而且 `?api=` 只在 localhost 生效）：

```sh
REPO="$HOME/dzy-bulletin"
python3 -m http.server 8792 --bind 127.0.0.1 -d "$REPO" > /dev/null 2>&1 &
echo $! > /tmp/dzyb-static.pid
curl -s --retry 10 --retry-delay 1 --retry-connrefused -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8792/   # 期望 200
open "http://localhost:8792/?mode=cloud&api=http://127.0.0.1:9"
```

（`127.0.0.1:9` 故意是沒有人在聽的埠。）然後 Claude 告訴 Eason：「V5、V6 會重開機，對話會中斷；做完後請重新打開 Claude，說『DEPLOY.md 第 8 步做完了』」，再把下表整段貼給他。

**手機的準備（所有手機驗證都要）**：手機**關掉 Wi-Fi、用 4G**，而且**打開 Tailscale App 按中斷連線（或整個登出）**——手機若連在 tailnet 裡，`*.ts.net` 會走 tailnet 內部，Funnel 沒開也打得通，驗收就不準。也可以改用一支從沒裝過 Tailscale 的手機。

| # | Eason 做什麼 | 通過的樣子 |
|---|---|---|
| V1 | 打開 Google 雲端硬碟的「鼎兆元｜電子佈告欄備份」資料夾 | 有一個今天的 `bulletin-….db.gz`；資料夾「共用」裡**只有你自己** |
| V2 | 看 Mac mini 螢幕上剛打開的瀏覽器分頁 | 頁首「鼎兆元｜電子佈告欄」，中間「請選擇你是誰」視窗裡有紅字「連不上伺服器，請確認網路」和「重試」按鈕——**不是一片白** |
| V3 | 手機（已中斷 Tailscale、4G）打 `<Funnel 網址>/health` | 看到 `{"ok":true,…}` |
| V4 | Mac mini 選單列的 Tailscale 圖示 → **Disconnect**；手機再打一次 → 再按 **Connect**；手機再打一次 | 中斷時手機**打不開**（逾時或無法連線）；連回後又看到 `{"ok":true,…}`（可能要等幾十秒） |
| V5 | 蘋果選單 → 重新啟動（取消勾選「再次登入時重新打開視窗」）→ **放手，不碰鍵盤滑鼠** → 等 3 分鐘 → 手機打 `/health` | 3 分鐘內看到 `{"ok":true,…}` |
| V6 | 直接拔掉 Mac mini 電源線，等 10 秒再插回（模擬停電）→ 不碰鍵盤滑鼠 → 3 分鐘後手機打 `/health` | 同上 |
| V7 | 目視：系統設定 → 鎖定畫面，「要求密碼」為「立即」 | 是 |

**V3～V6 任一步 3 分鐘後打不到，照這個順序查**（Eason 可以直接看螢幕；能進桌面的話請重新打開 Claude 跑右欄指令）：

| 順序 | 看什麼 | 判讀 |
|---|---|---|
| 1 | 拔電後 Mac mini 有沒有自己開機（電源燈、螢幕）；Claude：`pmset -g \| grep autorestart` | 沒開機或不是 `1` → A1 沒生效，重做 A1 |
| 2 | 螢幕停在哪裡 | **登入畫面** → A4 自動登入沒生效，或 FileVault 被打開了（`fdesetup status`）；**更新畫面／設定助理** → A3，等它跑完再重測 |
| 3 | 已進桌面：Claude 跑 `launchctl print gui/$(id -u)/com.dzy.bulletin \| grep -E 'state\|pid\|last exit'` 與 `curl -s http://127.0.0.1:8793/health` | 沒載入或本機 `/health` 不通 → 故障排除 A |
| 4 | 本機通：選單列 Tailscale 圖示是不是已連線；Claude：`"$TS" status \| head -3` | 未連線／Logged out → A7 的「登入時啟動」沒勾，或要重新登入；故障排除 B |
| 5 | Tailscale 已連線：Claude：`"$TS" funnel status` | 設定不見了 → 重做第 7 步（`--bg` 的設定照理重開後還在，這一步正好在實機證明）；還在 → 用第 7 步「從 tailnet 外面驗證」判斷是 Funnel 還是手機那端的問題 |

Eason 做完、重新打開 Claude 後，Claude 跑：

```sh
U="gui/$(id -u)"; DATA="$HOME/dzy-bulletin-data"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
uptime                                                      # 開機時間應是剛剛
fdesetup status                                             # FileVault is Off.
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl print "$U/$j" >/dev/null 2>&1 && echo "$j 已載入" || echo "✗ $j 沒載入"; done
"$TS" funnel status
curl -s http://127.0.0.1:8793/health; echo
tail -3 "$DATA/logs/server.log"                             # 應看到重開後的一行「佈告欄伺服器 … 啟動」
lsof -nP -iTCP:8792 -sTCP:LISTEN || echo "V2 的本機網頁伺服器已隨重開機結束"
```

V2 的本機網頁伺服器會隨重開機結束；若 Eason 沒做 V5／V6 就回來，Claude 自己關掉它（只關自己的 PID）：`kill "$(cat /tmp/dzyb-static.pid)" && rm /tmp/dzyb-static.pid`。

---

## 第 9 步：收尾檢查

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
git -C "$REPO" grep -l "guo""eason" -- server/ | wc -l     # 期望 0（手冊與程式不寫死任何人的帳號；用 git grep 只搜進版控的檔、不會碰到 .env；字串拆兩半免得這行自己被搜到）
ls -l "$REPO/server/.env"                                   # 期望 -rw-------
git -C "$REPO" status --porcelain                           # 期望空白（.env 不在裡面、也沒有改到 repo）
grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$REPO/server/.env"    # 必須是 1 才做下一行（否則搜尋字串是空的，每個檔都會算命中）
cd "$REPO" && grep -rl "$(sed -n 's/^BRIDGE_KEY=//p' server/.env | tr -d "\"'" | cut -c1-8)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l   # #10 金鑰檢查（前 8 碼）：期望 0
```

最後一行是 #10 的金鑰外洩檢查：只拿金鑰前 8 碼去比對 Claude 的對話紀錄與伺服器 log，**指令本身不印金鑰**，只回命中檔案數。
- 回 `0` → 沒有外洩，回報「0 命中」。
- 回非 0 → 8 碼在很大的對話紀錄裡有機會碰巧撞到，先用 12 碼複查一次（同樣只回數字）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
cd "$REPO" && grep -rl "$(sed -n 's/^BRIDGE_KEY=//p' server/.env | tr -d "\"'" | cut -c1-12)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l
```

  仍非 0 → **不要**打開命中的檔案看，直接告訴 Eason「金鑰檢查有 N 個命中」，由他重做 A9（Apps Script 屬性＋`.env` 兩處），Claude 執行 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin` 重起，再跑一次檢查。12 碼為 0 → 視為碰巧，回報「8 碼 N 命中、12 碼 0 命中」。

---

## 驗收清單與回報格式

在 #9 留言：把下面整段存成暫存檔、逐項打勾填好，用 `gh issue comment 9 -R dzy-bulletin/dzy-bulletin.github.io --body-file <暫存檔>` 送出（這台的 `gh` 沒登入就把整段交給 Eason 貼）。**不貼任何網址、金鑰、tailnet 名稱**；`/health` 回應可以整段貼（它不含網址與秘密）。

```markdown
## M4 部署回報（Mac mini）

環境：macOS <版本>／<arm64 或 x86_64>／Node <v24.x.y>／Tailscale <版本>（官方 App）／repo <分支> <commit 前 7 碼>

- [ ] 照 DEPLOY.md 完成，過程沒有回 MacBook 問（卡住的地方：<無／列出>）
- [ ] 第 9 步的帳號名稱 grep 為 0；`.env` 權限 `-rw-------`、`git status` 看不到；Claude 設定有 `.env` 的 Read 禁止規則
- [ ] `lsof -nP -iTCP:8793 -sTCP:LISTEN` 只有 `127.0.0.1:8793`，且 PID＝launchd 的 pid
- [ ] 正式模式 `POST /__seed` 回 404
- [ ] `tailscale funnel status` 只有一條 443 → `http://127.0.0.1:8793`；從公開 DNS 解析的 IP（非 100.x）打 `/health` 200
- [ ] Tailscale 後台 key expiry 已停用（截圖已遮網址，附在下面）
- [ ] 重開機不碰鍵盤，3 分鐘內手機（已中斷 Tailscale、4G）打 `/health` 200
- [ ] 拔電 10 秒再插，不碰鍵盤，3 分鐘內手機（同上）打 `/health` 200
- [ ] `fdesetup status` 為 Off；自動登入＝部署帳號；螢幕保護後立即要求密碼（Eason 目視）
- [ ] `date` 顯示 CST（台北）；`pmset` autorestart 1／sleep 0／disksleep 0；自動安裝 macOS 更新＝0
- [ ] 第 6 步當下的 `/health`：`e2e` false、`bridge` configured、`level` green（之後每小時／每次重開機的鏡像都被擋，會轉 yellow「鏡像連續失敗」，M5 前屬預期）
- [ ] `launchctl print` 三個 job 都已載入；殺掉 node 後 <N> 秒內（≤ 10）自動重起（PID 已換）
- [ ] daily 手動跑一次 `ok:true`、`sharedWith` 為 0（雲端備份資料夾有新檔、沒有分享給任何人）；mirror 載入時自動跑的那一輪為預期的 `鏡像：BRIDGE mirror: AUTH 目前不接受這個橋接動作`
- [ ] Tailscale 中斷時手機打不到、連回後打得到；本機模擬後端打不通時前端顯示錯誤文字、不白屏
- [ ] #10 金鑰 grep 檢查：0 命中

<details><summary>/health 回應</summary>

（貼 `curl -s http://127.0.0.1:8793/health` 的輸出）
</details>
```

Funnel 網址：**在對話裡**交給 Eason，不寫在上面。

---

## 交接給 M5（重要，負責切換的人必讀）

Mac mini 上的位置（M5 的指令照這裡寫，**不要**直接打 `node`——這台沒把 Node 放進 `PATH`，會 `command not found`）：

| 東西 | 位置 |
|---|---|
| Node | `$HOME/.local/node/bin/node`（捷徑，指向 `~/.local/node-v24.x.y-darwin-<晶片>`） |
| repo | `$HOME/dzy-bulletin` |
| 資料夾（DATA_DIR） | `$HOME/dzy-bulletin-data`（`bulletin.db`、`sigs/`、`backups/`、`logs/`；回退用的 `READONLY` 檔也放這裡） |
| 設定 | `$HOME/dzy-bulletin/server/.env`（程式自己讀，不用 `source`、不用 export） |
| launchd | `~/Library/LaunchAgents/com.dzy.bulletin{,.mirror,.daily}.plist`，domain `gui/$(id -u)` |

1. **設 `PRIMARY=mini` 之前，先停掉鏡像 job**。原因：一旦 `PRIMARY=mini`，Apps Script 就接受鏡像；每小時的鏡像若剛好在「設了 `PRIMARY=mini`」到「`migrate.js` 完成」之間跑，會嘗試把 Mac mini 的空庫寫進正式試算表（全空的會被 Apps Script 擋下，但只有一兩筆測試資料時擋不住）。完整順序（`migrate.js` 在 M5 的 PR 才進 repo）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"
launchctl bootout "$U/com.dzy.bulletin.mirror"              # ① 先停鏡像，再請 Eason 設 PRIMARY=mini、EXPORT_ONCE=1
"$NODE" "$REPO/server/migrate.js" --dry-run                  # ② 看筆數與簽名圖預估時間
"$NODE" "$REPO/server/migrate.js"                            # ③ 正式搬遷，六項全 ✅ 才往下
launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/com.dzy.bulletin.mirror.plist"   # ④ 載回鏡像（RunAtLoad：載入即跑一輪）
cat "$DATA/logs/mirror-last.json"; echo                     # ⑤ 等一兩分鐘後看，應為 "ok":true、pending／missing／bad 為 0
```

   回退時的手動鏡像：`touch "$DATA/READONLY"` 後 `"$NODE" "$REPO/server/mirror.js" --all`，重複到 `mirror-last.json` 的 `pending` 為 0。
2. Funnel 網址由 Eason 交給負責改 `js/config.js` 的人。
3. 管理通行碼：搬遷後沿用 Apps Script 的雜湊，不需要 `ADMIN_INIT.txt`。

---

## 故障排除

以下指令的變數沿用「手冊約定」那一行。

**A. launchd 起不來（`launchctl print` 沒有 pid、`/health` 打不通）**
- 看 log（不含金鑰）：`tail -30 "$HOME/dzy-bulletin-data/logs/server.err.log"`、`launchctl print gui/$(id -u)/com.dzy.bulletin | grep -E 'last exit code|state'`。
- `bootstrap` 回 `Bootstrap failed: 5: Input/output error`：通常是已經載入過了。先 `launchctl bootout gui/$(id -u)/<label>` 再 bootstrap。
- `last exit code = 78` 或完全沒有 log 檔：`$DATA/logs` 不存在或路徑錯 → `mkdir -p "$HOME/dzy-bulletin-data/logs"`，再檢查 plist 裡的路徑（`plutil -p ~/Library/LaunchAgents/com.dzy.bulletin.plist`）。
- log 出現 `Operation not permitted`：repo 或資料夾放在桌面／文件／下載底下 → 搬到 `$HOME` 底下，重做第 5 步的替換。
- log 反覆出現 `EADDRINUSE`、或第 5 步「PID 不一致」：8793 被別的程序占住（常見是第 4 步前景試跑沒關乾淨），`/health` 其實是那個程序在回。`lsof -nP -iTCP:8793 -sTCP:LISTEN` 看是誰；**是自己第 4 步起的**（`manual-run.pid` 或它的子程序）才 kill，不是就停下來回報 Eason。
- 系統設定 → 一般 → 登入項目（背景項目）裡 `node` 被關掉 → 打開，再 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`。
- 改了 plist：`launchctl bootout` 再 `bootstrap`（`kickstart` 不會重讀 plist）。改了 `.env`：`launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`（伺服器只在啟動時讀 `.env`）。

**B. Funnel 打不通**
- `"$TS" status` 顯示 Logged out 或 Stopped → 打開 Tailscale App 重新連線（需要時請 Eason 登入）。
- `"$TS" up` 失敗（例如要求補齊一堆旗標）→ 不要硬湊旗標，改從選單列 Tailscale 圖示按「Connect」。
- `"$TS" funnel status` 沒有設定 → 重做第 7 步；有多條 → `"$TS" funnel reset` 後重做。
- 本機 `curl http://127.0.0.1:8793/health` 就不通 → 是伺服器問題，看 A。
- 剛開 Funnel 時 TLS 錯誤或公開 DNS 查不到 → 憑證與 DNS 還在生效，等 10 分鐘內再試。
- 第 7 步「從 tailnet 外面驗證」通、手機不通 → 手機那端的問題（手機 Tailscale 沒中斷、4G 訊號、瀏覽器快取）。
- 「從 tailnet 外面驗證」也不通、本機通 → 後台 Funnel 同意沒做（A8），或 MagicDNS／HTTPS Certificates 沒開。
- 幾個月後突然全斷 → 多半是 key expiry 沒停用（A8），請 Eason 在後台重新驗證並停用過期。

**C. Node 版本不符**
- `server.err.log` 出現「需要 Node 24 以上」：plist 的 `__NODE__` 指錯 → `"$HOME/.local/node/bin/node" -v`、`plutil -p ~/Library/LaunchAgents/com.dzy.bulletin.plist | grep node`。
- `server.err.log` 出現 `ExperimentalWarning: SQLite is an experimental feature…`：Node 24 的正常提示，**無害**，不用處理。
- 小版升級（仍是 24.x）：重做第 1 步下載新的 24.x，`ln -sfn` 換捷徑，然後 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`。
- **不要自行升到 25 以上**：要先在 MacBook 跑過 `./tools/build.sh` 全過，由 Eason 決定。

**D. BRIDGE 錯誤**（看 `$HOME/dzy-bulletin-data/logs/mirror-last.json`／`backup-last.json` 的 `error`、`server.err.log`；這些都不含金鑰。`.env` 完整路徑是 `$HOME/dzy-bulletin/server/.env`）
- `/health` 的 `bridge` 是 `missing` → `.env` 缺 `BRIDGE_URL` 或 `BRIDGE_KEY` 行：`grep -c '^BRIDGE_URL=' "$HOME/dzy-bulletin/server/.env"`、`grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$HOME/dzy-bulletin/server/.env"`，補好後 `kickstart -k`。
- `…未設定 Google 橋接（BRIDGE_URL／BRIDGE_KEY）` → 同上（背景工作也讀同一個 `.env`）。
- `…AUTH 橋接金鑰錯誤` → 兩邊金鑰不一致或 Apps Script 的那把短於 32 字元。請 Eason 重做 A9（那一行會先刪掉 `.env` 裡舊的金鑰行，Claude 不經手），做完 `kickstart -k` 伺服器、再 `kickstart` daily 驗證。
- `…AUTH 目前不接受這個橋接動作` → 金鑰是對的；是 `mirror`／`export` 在 `PRIMARY=gas` 時被擋。M4 階段 mirror 出現這個是**正常**的。
- `鏡像：BAD_REQ 鏡像資料全空，拒絕覆寫` → Apps Script 被設成了 `PRIMARY=mini`，同仁此刻簽不了名。**立刻停下**，請 Eason 把 `PRIMARY` 改回 `gas`（見第 6 步判讀表）。
- `…回應不是 JSON` → `BRIDGE_URL` 不是 Apps Script 網頁應用程式的 `/exec` 網址，或該部署的存取權不是「任何人」。
- `BRIDGE_TIMEOUT …`／`連線 Google 逾時`、`Google 雲端暫時連不上` → Apps Script 排隊或 Google 暫時故障；下一輪會自己重跑，連續多次再回報。
- `/health` 黃燈、`why` 有「備份資料夾有共用者」→ 雲端硬碟「鼎兆元｜電子佈告欄備份」資料夾被分享了。請 Eason 在雲端硬碟對該資料夾 → 共用 → 移除所有共用者（也不要開「知道連結的人」），隔天快照後 `sharedWith` 回到 0 就轉綠；急的話 `launchctl kickstart gui/$(id -u)/com.dzy.bulletin.daily` 立刻重跑一次。
- `/health` 黃燈、`why` 有「本機缺簽名圖」或「有壞簽名圖」→ 見第 6 步判讀表最後一列（M4 空庫不會出現）。
- `/health` 黃燈、`why` 有「備份資料夾權限讀不到」（`sharedWith` 為 -1）→ Apps Script 這次讀不到資料夾權限，沒驗證到「僅 owner」。通常下一次快照就恢復；連續兩天都是 -1 再回報。

---

## 附錄 A：如果 FileVault 已經開了（或 Eason 不接受自動登入）→ 改走 (B) LaunchDaemon

FileVault 開著就不能自動登入，LaunchAgent 在停電重開後不會啟動。改成 LaunchDaemon（開機即跑、不需登入）。**全部需要 sudo，由 Eason 執行**；注意 FileVault 開機時仍要有人到場輸密碼解鎖磁碟，等於停電後還是要人。

1. 移除 LaunchAgent：`for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl bootout gui/$(id -u)/$j; rm ~/Library/LaunchAgents/$j.plist; done`
2. 用同樣的 `sed` 替換，但輸出到暫存檔，並在每個 plist 的 `<dict>` 第一層加上 `<key>UserName</key><string>部署帳號</string>`（以該使用者身分執行，資料夾權限不變）。
3. `sudo cp` 到 `/Library/LaunchDaemons/`，`sudo chown root:wheel` 且 `sudo chmod 644`，再 `sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist`。
4. 驗證改用 `sudo launchctl print system/<label>`；`restore.js --launchd` 只支援 LaunchAgent，改走 (B) 後還原要手動 `sudo launchctl bootout／bootstrap system/…`。
5. Tailscale 官方 App 要登入才會跑 → (B) 必須改用 Homebrew 的 `tailscaled`（系統服務，`sudo brew services start tailscale`），先移除官方 App，再重新登入並重做 A8 與第 7 步。

---

## 附錄 B：之後更新程式

```sh
REPO="$HOME/dzy-bulletin"; U="gui/$(id -u)"
git -C "$REPO" pull --ff-only
launchctl kickstart -k "$U/com.dzy.bulletin"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8793/health; echo
```

`server/launchd/*.plist` 有改動時，要重做第 5 步的替換，並對改到的 job `bootout` 再 `bootstrap`。
