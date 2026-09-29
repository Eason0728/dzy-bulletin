# 鼎兆元｜電子佈告欄 — Mac mini 部署手冊（M4，#9）

給 **Mac mini 上的 Claude** 從頭照做。做完＝伺服器在 Mac mini 常駐、停電重開不碰鍵盤自己恢復、手機 4G 從 Tailscale Funnel 打得到 `/health`。
本手冊**只部署、不搬資料**：前端 `js/config.js` 仍指向 Apps Script，同仁完全不受影響；資料搬遷與切換是下一張 M5（#10）。

定案（#9【定案 r2】）：**不開 FileVault＋自動登入＋LaunchAgent＋Tailscale 官方 App**。

---

## ⛔ 最前面：`.env` 禁令（違反任一條＝部署失敗，要請 Eason 換金鑰）

`server/.env` 裝著 `BRIDGE_KEY`——整套系統的萬能鑰匙（能匯出全部同仁密碼雜湊與登入金鑰）。Mac mini 的 Claude：

1. **不** `cat`／`less`／`head`／`open`／`echo`／`Read` 這個檔，也不用任何工具「看一下內容」。
2. **不** 執行會把環境變數全印出來的指令：`env`、`printenv`、`set`、`export -p`、`launchctl getenv BRIDGE_KEY`、`ps eww`。
3. **不** 把 `.env` 的內容、片段、長度以外的任何特徵貼進對話、issue、留言、commit、檔案。
4. **不** 自己產生、也不經手 `BRIDGE_KEY`：由 Eason 在**他自己開的「終端機」App 視窗**裡產生並貼入（不是在 Claude 的對話框裡用 `!` 執行）。
5. 要確認格式，只准用「回傳數字」的指令：`grep -c '^BRIDGE_KEY=.\{32,\}$' server/.env`（回 `1` 即可）。
6. `.env` 不進 git（`.gitignore` 已列 `server/.env`），權限 `600`。

同一原則適用 `DATA_DIR/ADMIN_INIT.txt`（管理通行碼明文）：**本手冊不建立、不讀取這個檔**。管理通行碼在 M5 搬遷時連同雜湊一起帶過來。

---

## 手冊約定

- 所有路徑都從 `$HOME` 推導，手冊裡沒有任何人的帳號名稱。
- `<...>` 是佔位：網址、金鑰、試算表 ID 一律不寫進本手冊、issue、commit。**Funnel 網址是部署時產生的，只在對話裡交給 Eason**（他轉給負責 M5 的人填 `js/config.js`），不寫進 #9 留言。
- **每一段指令前都先貼這一行**（Claude 的每次 Bash 呼叫是新的 shell，變數不會留著）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
```

- 標 **【Eason】** 的步驟 Claude 不能代做（要 sudo 密碼、要點系統設定、要登入 Tailscale、要碰金鑰）。Claude 做到那裡就**停下來**，把清單整段列給 Eason，等他說「做完了」再用「驗證」指令檢查。
- 手冊裡不用 `sleep` 等待：等伺服器起來一律用 `curl --retry … --retry-connrefused`。

---

## 第 0 步：查現況並回報（只讀、不改任何東西）

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
echo "== 使用者"; whoami; echo "HOME=$HOME uid=$(id -u)"
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
echo "== 埠 $PORT"; lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "（沒有人在聽，正常）"
echo "== 既有 job"; ls ~/Library/LaunchAgents/com.dzy.bulletin* 2>/dev/null || echo "（無）"
echo "== repo"; git -C "$REPO" log --oneline -1 2>/dev/null || echo "（尚未 clone）"
echo "== 既有資料"; ls -d "$DATA" 2>/dev/null || echo "（無）"
echo "== 磁碟"; df -h "$HOME" | tail -1
```

判讀與回報（把下表填好貼給 Eason，**然後停下來等他確認**）：

| 項目 | 期望 | 不符時 |
|---|---|---|
| FileVault | `FileVault is Off.` | 若為 On：**停**。問 Eason 要關（系統設定 → 隱私權與安全性 → FileVault → 關閉，需數小時解密）還是改走附錄 A |
| 自動登入 | 顯示部署帳號名稱 | 列入第 1 步【Eason】A4 |
| 晶片 | `arm64`（Apple Silicon）或 `x86_64`（Intel） | 第 2 步依此選 Node 檔 |
| macOS | 記下版本 | 系統設定的選單名稱依版本略有不同，照意思找 |
| 時區 | `date` 顯示 `CST`，`/etc/localtime` 指到 `Asia/Taipei` | 列入 A2 |
| 電源 | `autorestart 1`、`sleep 0`、`disksleep 0` | 列入 A1 |
| 自動更新 | `0` | 列入 A3 |
| Tailscale | 只有官方 App（`/Applications/Tailscale.app`） | 沒裝→A7；**若同時有 Homebrew `tailscale`／`tailscaled`：停**，請 Eason 決定移除（兩個版本會搶同一台機器的身分） |
| Node | `~/.local/node` 為 v24.x | 第 2 步安裝；系統裡另有 Homebrew `node` 沒關係，但本服務**不用它** |
| git | 印出版本號 | 若跳出「安裝命令列開發者工具」對話框：列入【Eason】，按「安裝」，裝完再繼續 |
| 埠 8793 | 沒人在聽 | 查是誰（`lsof` 會列出程序），請 Eason 決定 |
| repo | 已 clone（照 Eason 那段話先 clone 來讀手冊）或尚未 clone | 都可以，第 3 步會處理 |
| 既有 job／`$DATA` | 無 | 有的話**停**，不要覆蓋，回報給 Eason |

**前提（請 Eason 口頭確認）**：Apps Script 已部署 M2（#7）的橋接版本，指令碼屬性 `PRIMARY` 目前是 `gas`（或未設）。

---

## 第 1 步：【Eason】需要 sudo 或親手做的事（一次做完）

Claude 把下面 A1～A10 整段貼給 Eason。Eason 在 Mac mini 前面、**用他自己開的「終端機」App**（不是 Claude 對話框）做完，說「做完了」後 Claude 跑本節最後的「驗證」。

**A1　電源（sudo）**：停電恢復後自動開機、永不睡眠。
```sh
sudo pmset -a autorestart 1 sleep 0 disksleep 0
```

**A2　時區（sudo）**：每日快照排在台北 03:30，時區錯了就錯班。
```sh
sudo systemsetup -settimezone Asia/Taipei
```

**A3　關閉 macOS 自動安裝更新**：系統設定 → 一般 → 軟體更新 → 「自動更新」旁的 ⓘ → 關掉「安裝 macOS 更新」（「下載新的更新」可留著）。否則半夜自己重開、卡在更新畫面。之後由 Eason 挑時間手動更新，更新後照第 8 步再驗一次。

**A4　自動登入**：系統設定 → 使用者與群組 → 「自動以此身分登入」→ 選部署帳號（會要求輸入該帳號密碼）。
⚠ 這個選項是灰的＝FileVault 開著，回第 0 步處理。

**A5　永遠不開 FileVault**：確認系統設定 → 隱私權與安全性 → FileVault 為「關閉」。以後也不要打開；真的要開，照附錄 A 改走 LaunchDaemon。

**A6　螢幕保護後立即要求密碼**（自動登入的補償措施）：系統設定 → 鎖定畫面 → 「螢幕保護程式啟動或顯示器關閉後要求密碼」→「立即」；並設定一個螢幕保護程式啟動時間（例如 5 分鐘）。Mac mini 放在有門禁的位置。

**A7　Tailscale 官方 App**：從 Tailscale 官網下載 macOS 版（Standalone 版優先，App Store 版也可以）→ 安裝 → 打開 → 允許系統延伸功能與 VPN 設定（跳出的對話框按「允許」，必要時到隱私權與安全性按「允許」）→ 用 Eason 的 Tailscale 帳號登入 → 在 App 的設定勾「登入時啟動」（Launch at login）。

**A8　Tailscale 管理後台**（`<Tailscale 管理後台>`，用 Eason 帳號）：
- Machines → 這台 Mac mini → ⋯ → **Disable key expiry**（個人版預設 180 天過期，到期＝整站斷線）。截圖（遮掉網址與 tailnet 名稱）留著貼 #9。
- DNS → 確認 **MagicDNS** 與 **HTTPS Certificates** 都已啟用（Funnel 需要）。
- Funnel 同意：第 7 步 Claude 第一次開 Funnel 時，若指令印出一個「要啟用 Funnel」的連結，Claude 會把連結交給 Eason，Eason 打開並按同意（會在存取控制加上 `funnel` 節點屬性）。

**A9　BRIDGE_KEY（Eason 自產、親手貼兩處；Claude 不經手）**——等 Claude 做完第 3 步（`.env` 骨架建好）再做：
1. 如果 Apps Script 指令碼屬性裡**已經有** `BRIDGE_KEY`（M2 時設過），就沿用那一把：在 Apps Script 專案設定 → 指令碼屬性，複製它的值。沒有才產生新的：
   ```sh
   openssl rand -hex 32 | tr -d '\n' | pbcopy
   ```
   （金鑰直接進剪貼簿，不會顯示在畫面上。）新產生的要貼進 Apps Script → 專案設定 → 指令碼屬性 → 新增 `BRIDGE_KEY`。
2. 在**終端機 App** 執行（把剪貼簿內容接到 `.env` 最後一行）：
   ```sh
   printf 'BRIDGE_KEY=%s\n' "$(pbpaste)" >> "$HOME/dzy-bulletin/server/.env"; pbcopy < /dev/null
   ```
   最後那段 `pbcopy < /dev/null` 會清空剪貼簿。
3. 不要把金鑰貼進 Claude 的對話框、LINE、issue、任何檔案。

**A10　（僅在第 0 步 git 跳出對話框時）** 安裝命令列開發者工具：按對話框的「安裝」。

**驗證（Claude 在 Eason 說做完之後跑）：**
```sh
pmset -g | grep -E '^ *(autorestart|sleep|disksleep) '     # 期望 autorestart 1、sleep 0、disksleep 0
date; readlink /etc/localtime                               # 期望 CST、…/Asia/Taipei
defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates   # 期望 0
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser                          # 期望＝部署帳號（whoami）
fdesetup status                                             # 期望 FileVault is Off.
/Applications/Tailscale.app/Contents/MacOS/Tailscale status | head -3   # 期望第一行是這台機器、不是 Logged out
```
A6 螢幕鎖定、A8 key expiry 無法用指令驗證：請 Eason 目視確認並回覆「A6、A8 已確認」。

---

## 第 2 步：Node（固定主版本 24，不用 sudo）

不要用 Homebrew 的 `node`（它會自己升大版；`node:sqlite` 還在演進，升大版要先在 MacBook 跑過契約測試）。用官方 tar.gz 解到 `~/.local`，再用 `~/.local/node` 這個捷徑指過去——之後 24.x 小版升級只換捷徑，launchd 設定不用改。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo "未知晶片"; exit 1;; esac
NODE_DIST="<Node 官方發行站的 latest-v24.x 目錄（Node.js 官網 → 下載 → 預先編譯的二進位檔；不含結尾斜線）>"
mkdir -p "$HOME/.local" && cd "$HOME/Downloads" || exit 1
curl -fsSLO "$NODE_DIST/SHASUMS256.txt"
F=$(grep -o "node-v24\.[0-9.]*-darwin-$ARCH\.tar\.gz" SHASUMS256.txt | head -1); echo "檔名：$F"
curl -fsSLO "$NODE_DIST/$F"
grep " $F\$" SHASUMS256.txt | shasum -a 256 -c -          # 必須印出「OK」，否則刪掉重下
tar -xzf "$F" -C "$HOME/.local"
ln -sfn "$HOME/.local/${F%.tar.gz}" "$HOME/.local/node"
"$NODE" -v                                                  # 期望 v24.x.y
"$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')"
```

`NODE_DIST` 由 Mac mini 的 Claude 自己填上官方網址（本手冊不寫網址）；**只能是 Node.js 官方網站**，不要用鏡像站。
（本服務的程式不會用名字去呼叫 `node`，launchd 設定裡是絕對路徑，所以不必改 shell 的 `PATH`。）

---

## 第 3 步：取得程式、建資料夾與 `.env`

**位置固定在 `$HOME/dzy-bulletin`**，不要放在「桌面」「文件」「下載」底下——macOS 會擋背景程式讀那幾個資料夾（log 會出現 `Operation not permitted`）。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; U="gui/$(id -u)"; PORT=8793
BRANCH="<部署分支>"                                         # 見 Eason 給你的那段話（mini/m4，或已合併就用 main）
if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch -q origin && git -C "$REPO" checkout -q "$BRANCH" && git -C "$REPO" pull -q --ff-only; else git clone -q <repo 網址> "$REPO" && git -C "$REPO" checkout -q "$BRANCH"; fi
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

**到這裡停下來，請 Eason 做第 1 步 A9（貼 BRIDGE_KEY）。** 做完後 Claude 驗證（只看數字）：

```sh
REPO="$HOME/dzy-bulletin"
ls -l "$REPO/server/.env"                                   # 期望 -rw-------
grep -c '^BRIDGE_KEY=.\{32,\}$' "$REPO/server/.env"          # 期望 1（0＝沒貼到或太短；2＝貼了兩次，請 Eason 自己用文字編輯器刪掉一行）
grep -c '^E2E' "$REPO/server/.env"                          # 期望 0
git -C "$REPO" status --porcelain | grep -c '\.env'         # 期望 0（git 看不到它）
```

---

## 第 4 步：前景試跑（還不交給 launchd）

用正式設定在前景起一次，確認 Node、`.env`、資料夾都對。這一步用 Bash 的背景執行，**只關自己起的那個 PID**。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; PORT=8793
cd "$REPO" && DATA_DIR="$DATA" "$NODE" server/index.js > "$DATA/logs/manual-run.log" 2>&1 &
echo $! > "$DATA/logs/manual-run.pid"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/health"; echo
```

期望：`"ok":true`、`"e2e":false`、`"bridge":"configured"`；`level` 此時是 `red`（還沒有鏡像與快照紀錄，第 6 步後會好）。再驗：

```sh
PORT=8793
lsof -nP -iTCP:$PORT -sTCP:LISTEN                                                         # 期望只有一行 127.0.0.1:8793
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/__seed" -d '{}'  # 期望 404（正式模式沒有測試入口）
curl -s -X POST "http://127.0.0.1:$PORT/" -H 'Content-Type: text/plain' -d '{"action":"roster"}' | head -c 120; echo   # 期望 {"ok":true,"data":[]…（還沒搬資料，名單是空的）
```

關掉前景那一個（只關自己的 PID）：

```sh
DATA="$HOME/dzy-bulletin-data"; kill "$(cat "$DATA/logs/manual-run.pid")" && rm "$DATA/logs/manual-run.pid"
```

第一次啟動會在 `$DATA` 建 `bulletin.db`（空庫＋一把新的登入金鑰）。M5 搬遷會用 Apps Script 匯出的資料整份換掉，所以沒關係。

---

## 第 5 步：安裝三個 LaunchAgent

三個 job（全部在 `~/Library/LaunchAgents/`，不需 sudo）：

| Label | 做什麼 | 排程 |
|---|---|---|
| `com.dzy.bulletin` | 伺服器本體 | 登入即啟動、`KeepAlive`、當掉 10 秒內重起（`ThrottleInterval 10`） |
| `com.dzy.bulletin.mirror` | 鏡像回試算表＋簽名圖回填 Drive | 每小時（`StartInterval 3600`） |
| `com.dzy.bulletin.daily` | DB 快照上傳雲端 | 每天 03:30（台北） |

替換範本裡的 `__NODE__`／`__REPO__`／`__DATA_DIR__`，檢查後載入：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"
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
```

期望：三個都印得出來（＝已載入）；`com.dzy.bulletin` 是 `state = running` 且有 `pid`；另外兩個是 `not running`（等排程）。
如果 macOS 右上角跳出「已加入背景項目」通知，是正常的；**不要**在系統設定 → 一般 → 登入項目 裡把 `node` 關掉。

**殺掉會自己重起**（驗收項目）：

```sh
U="gui/$(id -u)"
P1=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); echo "原 PID $P1"; kill "$P1"
time curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8793/health && echo "已恢復"
P2=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); echo "新 PID $P2"   # 要和原 PID 不同；time 的 real 應 ≤ 約 12 秒
```

---

## 第 6 步：鏡像與快照各手動跑一次

用 `kickstart` 走 launchd 跑（順便驗證 plist 本身能跑），再看結果檔：

```sh
DATA="$HOME/dzy-bulletin-data"; U="gui/$(id -u)"
launchctl kickstart "$U/com.dzy.bulletin.daily"
launchctl kickstart "$U/com.dzy.bulletin.mirror"
```

等一兩分鐘（Apps Script 可能要排隊）後查：

```sh
DATA="$HOME/dzy-bulletin-data"
cat "$DATA/logs/backup-last.json"; echo; tail -3 "$DATA/logs/daily.log"
cat "$DATA/logs/mirror-last.json"; echo; tail -3 "$DATA/logs/mirror.log"
curl -s http://127.0.0.1:8793/health; echo
```

（這兩個結果檔與 log 不含金鑰，可以印。）判讀——**M4 階段 Apps Script 還是 `PRIMARY=gas`，所以兩個結果不一樣是對的**：

| 工作 | M4 的「成功」 | 意思 |
|---|---|---|
| daily | `backup-last.json` 的 `"ok":true`、`"sharedWith":0`，`daily.log` 有「備份完成」 | 橋接網址與金鑰都對，快照已上傳到雲端「鼎兆元｜電子佈告欄備份」資料夾（請 Eason 打開雲端硬碟看一眼有新檔）。這個資料夾**不要分享給任何人**（備份含密碼雜湊與登入金鑰）；有共用者時 `sharedWith` 大於 0、`/health` 亮黃燈 |
| mirror | `"ok":false`，錯誤是 **`AUTH 目前不接受這個橋接動作`** | 金鑰正確、橋接打得通，而且 Apps Script 的保險正確擋下了鏡像（還沒切換前，Mac mini 的空庫**絕不能**蓋掉正式試算表）。真正的 `ok:true` 在 M5 設 `PRIMARY=mini` 之後 |
| mirror（錯的情況） | 錯誤是 `AUTH 橋接金鑰錯誤` | 金鑰兩邊不一致 → 故障排除 D |

跑完這兩次後 `/health` 應為 `"level":"green"`（鏡像失敗次數 1，未達黃燈門檻 2）。
**已知且預期**：之後每小時的鏡像都會被擋，約 2 小時後 `/health` 會轉 `yellow`（`why` 為「鏡像連續失敗」），直到 M5 切換。M5 之前守門還沒接上，不會告警。

---

## 第 7 步：Tailscale Funnel（443 → 127.0.0.1:8793）

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" status | head -3
"$TS" funnel status                                          # 期望：目前沒有任何設定（No serve config）
"$TS" funnel --bg 8793
```

- 如果印出「Funnel is not enabled…」和一個連結：**停**，把連結交給 Eason（第 1 步 A8 的 Funnel 同意），他同意後再跑一次最後那行。
- 成功後：

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" funnel status
```

期望**只有一條**：`https://<這台機器>.<tailnet>.ts.net (Funnel on)` → `|-- / proxy http://127.0.0.1:8793`。有別的條目（其他埠、其他路徑）就 `"$TS" funnel reset` 後重做。

記下 Funnel 網址（`funnel status` 第一行的 https 網址），**只在對話裡交給 Eason**，不寫進任何檔案、commit、#9 留言。

首張 HTTPS 憑證要等幾十秒。本機先試（這只驗證憑證與代理，外部驗證要用手機）：

```sh
curl -s --retry 10 --retry-delay 5 --retry-all-errors "<Funnel 網址>/health"; echo
```

**外部驗證【Eason】**：手機**關掉 Wi-Fi、用 4G**，瀏覽器打 `<Funnel 網址>/health`，看到 `{"ok":true,…}` 即通過。請 Eason 回覆「4G 通過」。

---

## 第 8 步：【Eason】重開機與拔電驗證（不碰鍵盤滑鼠）

Claude 的對話會隨重開機中斷，所以先把進度告訴 Eason：「重開後請重新打開 Claude，說『DEPLOY.md 從第 8 步驗證繼續』」。

**8-1 重開機**：蘋果選單 → 重新啟動（取消勾選「再次登入時重新打開視窗」）→ **放手，不碰鍵盤滑鼠** → 等 3 分鐘 → 手機 4G 打 `<Funnel 網址>/health` → 200 且 `"ok":true` 即通過。
（想用終端機也可以：`sudo shutdown -r now`。）

**8-2 拔電源**：直接拔掉 Mac mini 電源線，等 10 秒再插回（模擬停電；`autorestart` 會讓它自己開機）→ 不碰鍵盤滑鼠 → 3 分鐘後同樣用手機 4G 驗證。

Eason 驗完、重新打開 Claude 後，Claude 跑：

```sh
U="gui/$(id -u)"; DATA="$HOME/dzy-bulletin-data"
uptime                                                      # 開機時間應是剛剛
fdesetup status                                             # FileVault is Off.
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl print "$U/$j" >/dev/null 2>&1 && echo "$j 已載入" || echo "✗ $j 沒載入"; done
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status
curl -s http://127.0.0.1:8793/health; echo
tail -3 "$DATA/logs/server.log"                             # 應看到重開後的一行「佈告欄伺服器 … 啟動」
```

---

## 第 9 步：停掉 Tailscale 時，前端顯示錯誤、不白屏

**9-1 Funnel 斷線時外面打不到（伺服器不受影響）**：

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" down
curl -s http://127.0.0.1:8793/health | head -c 60; echo      # 本機仍正常
```

請 Eason 用手機 4G 打 `<Funnel 網址>/health` → 應該打不開（逾時或無法連線）。然後恢復並確認：

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$TS" up && "$TS" funnel status                             # Funnel 設定仍在、只有一條
```

請 Eason 再用手機 4G 打一次 → 恢復 200。

**9-2 前端連不上後端時顯示錯誤文字**：正式前端要到 M5 才指向 Funnel，而且 `?api=` 只在 localhost 生效，所以在 Mac mini 本機模擬「後端打不通」：

```sh
REPO="$HOME/dzy-bulletin"
cd "$REPO" && python3 -m http.server 8792 --bind 127.0.0.1 > /dev/null 2>&1 &
echo $! > /tmp/dzyb-static.pid
open "http://localhost:8792/?mode=cloud&api=http://127.0.0.1:9"
```

（`127.0.0.1:9` 故意是沒有人在聽的埠。）請 Eason 看瀏覽器：應該看到頁首「鼎兆元｜電子佈告欄」，中間是「請選擇你是誰」視窗，裡面有紅字「連不上伺服器，請確認網路」和「重試」按鈕——**不是一片白**。看完關掉本機網頁伺服器（只關自己的 PID）：

```sh
kill "$(cat /tmp/dzyb-static.pid)" && rm /tmp/dzyb-static.pid
```

M5 切換後，會在正式網址上以同樣方式再驗一次（#10 驗收最後一條）。

---

## 第 10 步：收尾檢查

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
git -C "$REPO" grep -l "guo""eason" -- server/ | wc -l     # 期望 0（手冊與程式不寫死任何人的帳號；用 git grep 只搜進版控的檔、不會碰到 .env；字串拆兩半免得這行自己被搜到）
ls -l "$REPO/server/.env"                                   # 期望 -rw-------
git -C "$REPO" status --porcelain                           # 期望空白（.env 不在裡面、也沒有改到 repo）
cd "$REPO" && grep -rl "$(sed -n 's/^BRIDGE_KEY=//p' server/.env | tr -d "\"'" | cut -c1-8)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l   # #10 金鑰檢查：期望 0
```

最後一行是 #10 的金鑰外洩檢查：只拿金鑰前 8 碼去比對 Claude 的對話紀錄與伺服器 log，**指令本身不印金鑰**，只回命中檔案數。
- 回 `0` → 沒有外洩，回報「0 命中」。
- 回非 0 → **不要**打開命中的檔案看，直接告訴 Eason「金鑰檢查有 N 個命中」，由他照 A9 換一把（Apps Script 屬性＋`.env` 兩處）後，Claude 執行 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin` 重起，再跑一次這個檢查。

---

## 驗收清單與回報格式

在 #9 留言（`gh issue comment 9 -R <repo 名稱> --body-file <暫存檔>`；這台的 `gh` 沒登入就把整段交給 Eason 貼），把下面整段複製、逐項打勾、填入結果。**不貼任何網址、金鑰、tailnet 名稱**；`/health` 回應可以整段貼（它不含網址與秘密）。

```markdown
## M4 部署回報（Mac mini）

環境：macOS <版本>／<arm64 或 x86_64>／Node <v24.x.y>／Tailscale <版本>（官方 App）／repo <commit 前 7 碼>

- [ ] 照 DEPLOY.md 完成，過程沒有回 MacBook 問（卡住的地方：<無／列出>）
- [ ] 第 10 步的帳號名稱 grep 為 0；`.env` 權限 `-rw-------`、`git status` 看不到
- [ ] `lsof -nP -iTCP:8793 -sTCP:LISTEN` 只有 `127.0.0.1:8793`
- [ ] 正式模式 `POST /__seed` 回 404
- [ ] `tailscale funnel status` 只有一條 443 → `http://127.0.0.1:8793`
- [ ] Tailscale 後台 key expiry 已停用（截圖已遮網址，附在下面）
- [ ] 重開機不碰鍵盤，3 分鐘內手機 4G 打 `/health` 200
- [ ] 拔電 10 秒再插，不碰鍵盤，3 分鐘內手機 4G 打 `/health` 200
- [ ] `fdesetup status` 為 Off；自動登入＝部署帳號；螢幕保護後立即要求密碼（Eason 目視）
- [ ] `date` 顯示 CST（台北）；`pmset` autorestart 1／sleep 0／disksleep 0；自動安裝 macOS 更新＝0
- [ ] `/health`：`e2e` false、`bridge` configured、`level` green（M5 前會轉 yellow「鏡像連續失敗」，預期）
- [ ] `launchctl print` 三個 job 都已載入；殺掉 node 後 <N> 秒內自動重起（PID 已換）
- [ ] daily 手動跑一次 `ok:true`、`sharedWith` 為 0（雲端備份資料夾有新檔、沒有分享給任何人）；mirror 手動跑一次為預期的「AUTH 目前不接受這個橋接動作」（PRIMARY=gas 時的保險）
- [ ] 停掉 Tailscale 時手機打不到、恢復後打得到；本機模擬後端打不通時前端顯示錯誤文字、不白屏
- [ ] #10 金鑰 grep 檢查：0 命中

<details><summary>/health 回應</summary>

（貼 `curl -s http://127.0.0.1:8793/health` 的輸出）
</details>
```

Funnel 網址：**在對話裡**交給 Eason，不寫在上面。

---

## 交接給 M5（重要，負責切換的人必讀）

1. **設 `PRIMARY=mini` 之前，先停掉鏡像 job**：`launchctl bootout gui/$(id -u)/com.dzy.bulletin.mirror`。
   原因：一旦 `PRIMARY=mini`，Apps Script 就接受鏡像；如果每小時的鏡像剛好在「設了 `PRIMARY=mini`」到「`migrate.js` 完成」之間跑，會把 Mac mini 的**空庫**整份蓋進正式試算表，接著 `export` 就匯出空資料。
   `migrate.js` 六項全 ✅ 之後，才 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dzy.bulletin.mirror.plist`，再 `kickstart` 一次確認 `mirror-last.json` 為 `ok:true`。
2. Funnel 網址由 Eason 交給負責改 `js/config.js` 的人。
3. 管理通行碼：搬遷後沿用 Apps Script 的雜湊，不需要 `ADMIN_INIT.txt`。

---

## 故障排除

**A. launchd 起不來（`launchctl print` 沒有 pid、`/health` 打不通）**
- 看 log（不含金鑰）：`tail -30 "$HOME/dzy-bulletin-data/logs/server.err.log"`、`launchctl print gui/$(id -u)/com.dzy.bulletin | grep -E 'last exit code|state'`。
- `bootstrap` 回 `Bootstrap failed: 5: Input/output error`：通常是已經載入過了。先 `launchctl bootout gui/$(id -u)/<label>` 再 bootstrap。
- `last exit code = 78` 或完全沒有 log 檔：`$DATA/logs` 不存在或路徑錯 → `mkdir -p "$HOME/dzy-bulletin-data/logs"`，再檢查 plist 裡的路徑（`plutil -p ~/Library/LaunchAgents/com.dzy.bulletin.plist`）。
- log 出現 `Operation not permitted`：repo 或資料夾放在桌面／文件／下載底下 → 搬到 `$HOME` 底下，重做第 5 步的替換。
- log 出現 `EADDRINUSE`：8793 被占用 → `lsof -nP -iTCP:8793 -sTCP:LISTEN` 看是誰（常見是第 4 步前景試跑沒關）；只關自己起的那個。
- 系統設定 → 一般 → 登入項目（背景項目）裡 `node` 被關掉 → 打開，再 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`。
- 改了 plist：`launchctl bootout` 再 `bootstrap`（`kickstart` 不會重讀 plist）。改了 `.env`：`launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`（伺服器只在啟動時讀 `.env`）。

**B. Funnel 打不通**
- `"$TS" status` 顯示 Logged out 或 Stopped → 打開 Tailscale App 重新連線（需要時請 Eason 登入）。
- `"$TS" funnel status` 沒有設定 → 重做第 7 步；有多條 → `"$TS" funnel reset` 後重做。
- 本機 `curl http://127.0.0.1:8793/health` 就不通 → 是伺服器問題，看 A。
- 剛開 Funnel 時 TLS 錯誤 → 憑證還在簽發，等 1～2 分鐘再試。
- 手機打不到但 Mac mini 本機打得到 Funnel 網址 → 後台 Funnel 同意沒做（A8），或 MagicDNS／HTTPS Certificates 沒開。
- 幾個月後突然全斷 → 多半是 key expiry 沒停用（A8），請 Eason 在後台重新驗證並停用過期。

**C. Node 版本不符**
- `server.err.log` 出現「需要 Node 24 以上」：plist 的 `__NODE__` 指錯 → `"$HOME/.local/node/bin/node" -v`、`plutil -p ~/Library/LaunchAgents/com.dzy.bulletin.plist | grep node`。
- 小版升級（仍是 24.x）：重做第 2 步下載新的 24.x，`ln -sfn` 換捷徑，然後 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`。
- **不要自行升到 25 以上**：要先在 MacBook 跑過 `./tools/build.sh` 全過，由 Eason 決定。

**D. BRIDGE 錯誤**（看 `mirror-last.json`／`backup-last.json` 的 `error`、`server.err.log`；這些都不含金鑰）
- `/health` 的 `bridge` 是 `missing` → `.env` 缺 `BRIDGE_URL` 或 `BRIDGE_KEY` 行：`grep -c '^BRIDGE_URL=' …/.env`、`grep -c '^BRIDGE_KEY=.\{32,\}$' …/.env`，補好後 `kickstart -k`。
- `未設定 Google 橋接` → 同上（背景工作也讀同一個 `.env`）。
- `AUTH 橋接金鑰錯誤` → 兩邊金鑰不一致或 Apps Script 的那把短於 32 字元。請 Eason 照 A9 重貼兩處（先用文字編輯器刪掉 `.env` 裡舊的 `BRIDGE_KEY=` 那一行），Claude 不經手。
- `AUTH 目前不接受這個橋接動作` → 金鑰是對的；是 `mirror`／`export` 在 `PRIMARY=gas` 時被擋。M4 階段 mirror 出現這個是**正常**的。
- `回應不是 JSON` → `BRIDGE_URL` 不是 Apps Script 網頁應用程式的 `/exec` 網址，或該部署的存取權不是「任何人」。
- `BRIDGE_TIMEOUT`／`Google 雲端暫時連不上` → Apps Script 排隊或 Google 暫時故障；下一輪會自己重跑，連續多次再回報。
- `/health` 黃燈、`why` 有「備份資料夾有共用者」→ 雲端硬碟「鼎兆元｜電子佈告欄備份」資料夾被分享了。請 Eason 在雲端硬碟對該資料夾 → 共用 → 移除所有共用者（也不要開「知道連結的人」），隔天快照後 `sharedWith` 回到 0 就轉綠；急的話 `launchctl kickstart gui/$(id -u)/com.dzy.bulletin.daily` 立刻重跑一次。

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
