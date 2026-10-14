// 集中启动端代理后端（v1.18.0）：Windows 托盘启动端助手的支持层。
// 启动端 = 一个 PowerShell 常驻进程（NotifyIcon 托盘，无退出按钮），统一用一条
// GET /api/launcher/agent/poll 心跳对接工作台（index.js EXEMPT 精确匹配）：
//   - 注册/心跳/本机各服务状态上报（sv 参数，JSON）全在这条 GET 里，20 秒一次；
//   - 心跳回程复用「短消息桌面通知」的未读消息查询（uid + users.notify_key 双凭证，
//     key 不匹配只少给消息、不拦心跳——设备在场性靠 settings.launcher_key，消息可读性靠每用户 notify_key）；
//   - 已读回执走既有 EXEMPT 端点 POST /api/messages/agent/read（不新开面）。
// 托盘助手对「电脑监控/剪贴板采集」只报联网状态不可从托盘退出；对「电子宠物/悬浮歌词」
// 以子进程方式拉起/停止（显示/隐藏设置落 state.json，下次启动保持）；VibeASR/VibeVoice
// 只探测安装路径与 models 目录容量。设置页新增「启动端」tab 集中下载全部 Windows 客户端。
const fs = require('fs');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const messageService = require('./messageService');
const { buildZip } = require('./zipService');

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/; // agent 生成 PC+12hex；宽一点容忍手写
// agent 20s 一 poll，60s 没来才算离线（容忍一轮网络抖动 + 服务器忙）；e2e 可用 env 压短
const ONLINE_MS = Number(process.env.LAUNCHER_ONLINE_MS) > 0 ? Number(process.env.LAUNCHER_ONLINE_MS) : 60000;
const POLL_INTERVAL_S = 20; // 心跳周期（回程下发，agent 服从；改小前先想 Cloudflare/内网自签都扛得住）

// ---------- 启动端 key（settings.launcher_key，32hex；首次需要时生成） ----------
function getAgentKey() {
  let k = String(getSetting(db, 'launcher_key', '') || '');
  if (!/^[0-9a-f]{32}$/.test(k)) {
    k = crypto.randomBytes(16).toString('hex');
    setSetting(db, 'launcher_key', k);
  }
  return k;
}
// 轮换：老设备下一轮 poll 立刻 403，管理员再发一次安装包即可（包里嵌的是新 key）
function rotateAgentKey() {
  const k = crypto.randomBytes(16).toString('hex');
  setSetting(db, 'launcher_key', k);
  return k;
}
function checkAgentKey(key) {
  return typeof key === 'string' && /^[0-9a-f]{32}$/.test(key)
    && key === String(getSetting(db, 'launcher_key', '') || '');
}

// 每用户通知密钥（与 misc.js notifyKeyOf 同一张 users.notify_key 列：启动端要弹的是
// 「下载者本人」的消息，包里嵌 uid+key；这里不能 import misc（路由层），同逻辑就地实现）
function notifyKeyFor(userId) {
  const u = db.prepare('SELECT id, notify_key FROM users WHERE id=?').get(Number(userId));
  if (!u) return '';
  if (!u.notify_key) {
    const k = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET notify_key=? WHERE id=?').run(k, u.id);
    return k;
  }
  return u.notify_key;
}
function notifyUserFor(uid, nkey) {
  const u = Number(uid) || 0;
  const k = String(nkey || '');
  if (!u || !k) return null;
  const row = db.prepare('SELECT id, notify_key, notify_autoplay FROM users WHERE id=?').get(u);
  return row && row.notify_key && row.notify_key === k ? row : null;
}

// ---------- 设备登记（launcher_agents，主库）：poll 即 upsert ----------
function ensureAgent(id, q, ip) {
  const now = Date.now();
  const computer = String(q.computer || '').slice(0, 60);
  const v = String(q.v || '').slice(0, 20);
  const uid = Number(q.uid) || 0;
  const ipS = String(ip || '').slice(0, 64);
  if (db.prepare('SELECT 1 FROM launcher_agents WHERE id=?').get(id)) {
    db.prepare(`UPDATE launcher_agents SET last_seen=?, polls=polls+1,
      computer=COALESCE(NULLIF(?,''), computer), uid=?, agent_version=COALESCE(NULLIF(?,''), agent_version), ip=? WHERE id=?`)
      .run(now, computer, uid, v, ipS, id);
  } else {
    db.prepare(`INSERT INTO launcher_agents(id, name, computer, uid, agent_version, ip, first_seen, last_seen, polls)
      VALUES(?,?,?,?,?,?,?,?,1)`).run(id, '', computer, uid, v, ipS, now, now);
  }
  return db.prepare('SELECT * FROM launcher_agents WHERE id=?').get(id);
}
function parseJsonSafe(s) {
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function listAgents() {
  const now = Date.now();
  return db.prepare(`SELECT a.*, COALESCE(NULLIF(u.display_name,''), u.username) AS user_name
    FROM launcher_agents a LEFT JOIN users u ON u.id = a.uid
    ORDER BY a.last_seen DESC`).all()
    .map((r) => ({
      ...r,
      online: now - (r.last_seen || 0) < ONLINE_MS,
      services: parseJsonSafe(r.services_json),
      report: parseJsonSafe(r.report_json),
      services_json: undefined,
      report_json: undefined,
    }));
}
function updateAgent(id, patch) {
  const row = db.prepare('SELECT 1 FROM launcher_agents WHERE id=?').get(id);
  if (!row) return { ok: false, error: '设备不存在' };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
    db.prepare('UPDATE launcher_agents SET name=? WHERE id=?').run(String(patch.name || '').slice(0, 40), id);
  }
  return { ok: true };
}
function deleteAgent(id) {
  const r = db.prepare('DELETE FROM launcher_agents WHERE id=?').run(id);
  return { ok: !!r.changes };
}

// ---------- 心跳上报的 sv（本机各服务状态）白名单清洗后落 report_json ----------
// 正常上报 ~500B；异常肥的整份丢弃（{}），面板显示「该设备未上报明细」而不是撑爆库。
// 没带 sv 的心跳不覆盖上次明细（否则一轮裸心跳就把面板状态洗掉）。
const SV_KEYS = ['notify', 'monitor', 'clipboard', 'pet', 'lyrics', 'compute', 'target'];
function storeReport(id, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return;
  const o = parseJsonSafe(raw);
  const out = {};
  for (const k of SV_KEYS) if (o[k] !== undefined) out[k] = o[k];
  let s = JSON.stringify(out);
  if (s.length > 8192) s = '{}';
  db.prepare('UPDATE launcher_agents SET report_json=? WHERE id=?').run(s, id);
}

// ---------- 未读消息（与 /api/messages/agent/poll 同一查询：id > after 且未读，语音带 base64） ----------
function messagesFor(u, after) {
  const rows = db.prepare(
    `SELECT m.*, COALESCE(NULLIF(u2.display_name, ''), u2.username) AS from_name FROM messages m
     LEFT JOIN users u2 ON u2.id = m.from_user
     WHERE m.to_user = ? AND m.id > ? AND m.read_at IS NULL ORDER BY m.id LIMIT 15`
  ).all(u.id, after);
  const messages = rows.map((r) => {
    const o = {
      id: r.id,
      subject: String(r.subject || ''),
      content: r.is_voice ? '' : String(r.content || '').slice(0, 400),
      from_name: r.from_name || `用户${r.from_user}`,
      module_label: messageService.MODULE_LABELS[r.module] || r.module,
      created_at: r.created_at,
      is_voice: !!r.is_voice,
      voice_secs: Number(r.voice_secs) || 0,
      voice_text: String(r.voice_text || '').slice(0, 200),
    };
    if (r.is_voice) {
      try {
        const f = messageService.voiceFile(r.id);
        if (fs.existsSync(f)) {
          const size = fs.statSync(f).size;
          if (size > 0 && size <= 3 * 1024 * 1024) o.voice_b64 = fs.readFileSync(f).toString('base64');
        }
      } catch { /* 文件读不了就只弹文字 */ }
    }
    return o;
  });
  return messages;
}

// ---------- 心跳回程：在场登记 + 消息复用 + 心跳周期下发 ----------
function pollPayload(agentRow, q) {
  storeReport(agentRow.id, q.sv);
  const nu = notifyUserFor(q.uid, q.nk);
  const after = Number(q.after) || 0;
  const messages = nu ? messagesFor(nu, after) : [];
  return {
    ok: true,
    server_time: Date.now(),
    notify_ok: !!nu,            // uid+notify_key 不匹配时消息为空并如实告知（心跳本身仍成立）
    autoplay: nu ? nu.notify_autoplay !== 0 : false,
    messages,
    last_id: messages.length ? messages[messages.length - 1].id : after,
    interval: POLL_INTERVAL_S,  // agent 下一跳等多少秒（回程统一下发，便于服务端调频）
  };
}

// ---------- 启动端助手脚本（PowerShell 5.1 + WinForms 托盘，Windows） ----------
// 结构：单进程常驻——NotifyIcon 托盘（四方块图标，与网页 favicon 同形）+ 20 秒一次心跳
// GET /api/launcher/agent/poll（在场登记 + 各服务状态上报 + 取回未读消息弹窗）。
// 托盘菜单七项：短消息通知（弹窗/自动播语音两开关）、电脑监控与剪贴板采集（仅状态、
// 不可从托盘关停）、电子宠物与悬浮歌词（显示/隐藏＝拉起/停掉子代理，偏好落 state.json）、
// 录音转写算力（VibeASR 1.5B / VibeVoice 7B 就位状态）、连接目标（只读查看）。
// 按用户规格：整体不设退出/关闭按钮——卸载走设置页的卸载包。
// 写法约束：PS 里不用反引号、不用 ${} 变量花括号语法——本模板要嵌进 JS String.raw 字面量。
const PS_TEMPLATE = String.raw`# =====================================================================
#  全能工作台 · 集中启动端助手 v1（Windows PowerShell 5.1 + WinForms 托盘）
#  - 无参数或 run   ：常驻运行（开机自启拉起的就是这个）
#  - -Cmd install   ：安装到 %LOCALAPPDATA%\WorkbenchLauncher + 设开机自启 + 启动
#  - -Cmd uninstall ：停进程、删自启、删目录（只卸启动端本身；监控/剪贴板/宠物/歌词各有自己的卸载包）
#  只调两个只读接口：GET /api/launcher/agent/poll（20 秒心跳）与 POST /api/messages/agent/read
#  （弹窗点击已读）。不执行任何服务端下发的代码。
# =====================================================================
param([string]$Cmd = '')
$ErrorActionPreference = 'Stop'
$server = '__SERVER__'
$lKey   = '__KEY__'
$uid    = __UID__
$nKey   = '__NKEY__'
$AppName = 'WorkbenchLauncher'
$InstDir = Join-Path $env:LOCALAPPDATA $AppName
$LogFile = Join-Path $InstDir 'agent.log'
$StateFile = Join-Path $InstDir 'state.json'

# ---------- 安装 ----------
if ($Cmd -eq 'install') {
  New-Item -ItemType Directory -Force -Path $InstDir | Out-Null
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $InstDir 'launcher.ps1') -Force
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $AppName -Value ('powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstDir 'launcher.ps1') + '"')
  Write-Host ('已安装到 ' + $InstDir)
  Write-Host '已设开机自启，启动端正在后台启动（任务栏右下角出现四方块图标）。'
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstDir 'launcher.ps1') + '"')
  exit 0
}

# ---------- 卸载 ----------
if ($Cmd -eq 'uninstall') {
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $AppName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($AppName) -and $_.ProcessId -ne $PID } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Start-Sleep -Milliseconds 800
  if ($InstDir -and (Test-Path -LiteralPath $InstDir)) { Remove-Item -LiteralPath $InstDir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host '已卸载启动端：开机自启已移除、程序目录已删除。'
  Write-Host '（电子宠物 / 悬浮歌词 / 监控 / 剪贴板等子客户端不受影响，各自有卸载包。）'
  exit 0
}

# ---------- 常驻运行 ----------
# 任何未捕获异常都要留下尸检线索再退——开机自启场景下静默死亡无从排障（0 台设备事故的教训）
trap { try { Log ('致命错误，代理退出：' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage) } catch { }; exit 1 }
function Log([string]$s) {
  try {
    Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'MM-dd HH:mm:ss') + ' ' + $s) -Encoding UTF8
    if ((Get-Item -LiteralPath $LogFile -ErrorAction SilentlyContinue).Length -gt 131072) {
      $keep = Get-Content -LiteralPath $LogFile -Tail 200
      Set-Content -LiteralPath $LogFile -Value $keep -Encoding UTF8
    }
  } catch { }
}
try { New-Item -ItemType Directory -Force -Path $InstDir | Out-Null } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# 工作台可能是内网自签名 HTTPS（按下载来源内嵌）：编译型 C# 回调放行证书（脚本块形式会在 TLS 线程炸）
if (-not ('LauncherTlsTrust' -as [type])) {
  Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class LauncherTlsTrust : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'
}
[System.Net.ServicePointManager]::CertificatePolicy = New-Object LauncherTlsTrust
# 本机代理会掐断内网请求，强制直连
[System.Net.WebRequest]::DefaultWebProxy = $null
# 单实例互斥
$mtx = New-Object System.Threading.Mutex($false, ('Global\' + $AppName))
if (-not $mtx.WaitOne(0)) { exit 0 }

# 本机偏好 + 运行时状态（同步哈希表：菜单点击事件（-Action 子作用域）与主循环共享读写）
$st = [hashtable]::Synchronized(@{
  popup = $true; voice = $true; pet = $true; lyrics = $true   # 偏好：弹通知/播语音/宠物显示/歌词显示
  last = 0; save = $false; petDirty = $true; lyricsDirty = $true  # last=已弹过的最大消息 id；dirty=启动时强制对齐子进程
  cur = $null; player = $null                                  # 当前展示的消息 / 语音播放器引用
  compute = $null; computeAt = ''                              # 算力目录扫描缓存（10 分钟一次，别每 20s 扫 1.7GB）
})
# 事件 -Action 块跑在独立模块作用域里读不到脚本变量——把回执要用的凭据塞进同步哈希表随身带
$st.server = $server; $st.uid = $uid; $st.nKey = $nKey
try {
  if (Test-Path -LiteralPath $StateFile) {
    $j = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    foreach ($k in @('popup', 'voice', 'pet', 'lyrics')) { $v = $j.$k; if ($null -ne $v) { $st[$k] = [bool]$v } }
    if ($null -ne $j.last) { $st.last = [int]$j.last }
  }
} catch { }
function Save-State {
  try {
    $o = @{ popup = [bool]$st.popup; voice = [bool]$st.voice; pet = [bool]$st.pet; lyrics = [bool]$st.lyrics; last = [int]$st.last }
    ConvertTo-Json $o -Compress | Set-Content -LiteralPath $StateFile -Encoding UTF8
  } catch { }
}

# 设备号：PC + SHA256(MachineGuid|COMPUTERNAME) 前 12 hex（与监控/歌词代理同一算法，面板里可对上号）
$devId = ''
try {
  $mg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hex = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$mg + '|' + [string]$env:COMPUTERNAME)) | ForEach-Object { $_.ToString('x2') }) -join ''
  $devId = 'PC' + $hex.Substring(0, 12)
} catch { $devId = 'PC' + ([Guid]::NewGuid().ToString('N').Substring(0, 12)) }

# ---------- 本机各客户端探测 ----------
function Test-MutexHeld([string]$name) {
  try {
    $m = New-Object System.Threading.Mutex($false, $name)
    $held = $false
    try { $held = -not $m.WaitOne(0); if (-not $held) { $m.ReleaseMutex() } } catch { $held = $false; try { $m.ReleaseMutex() } catch { } }
    $m.Dispose()
    return $held
  } catch { return $false }
}
function Get-AgentInstalled([string]$app, [string]$file) {
  return (Test-Path -LiteralPath (Join-Path (Join-Path $env:LOCALAPPDATA $app) $file))
}
function Start-Agent([string]$app, [string]$file) {
  $p = Join-Path (Join-Path $env:LOCALAPPDATA $app) $file
  if (-not (Test-Path -LiteralPath $p)) { return }
  try {
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $p + '"')
    Log ('子客户端拉起：' + $app)
  } catch { Log ('子客户端拉起失败 ' + $app + '：' + $_.Exception.Message) }
}
function Stop-Agent([string]$app) {
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($app) -and $_.ProcessId -ne $PID } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Log ('子客户端停止：' + $app)
}
# VibeASR/VibeVoice 就位探测：目录在 + engine 或 models 在 = 已安装；容量 = models 目录
function Get-VibeInfo([string]$root) {
  $info = @{ installed = $false; path = ''; gb = 0.0 }
  if ($root -and (Test-Path -LiteralPath $root)) {
    $info.path = $root
    $hasEngine = (Test-Path -LiteralPath (Join-Path $root 'engine\asr_stream_server.exe'))
    $models = Join-Path $root 'models'
    $hasModels = (Test-Path -LiteralPath $models)
    if ($hasEngine -or $hasModels) { $info.installed = $true }
    if ($hasModels) {
      try {
        $sum = (Get-ChildItem -LiteralPath $models -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($sum) { $info.gb = [Math]::Round($sum / 1GB, 1) }
      } catch { }
    }
  }
  return $info
}
function Get-StatusData {
  if (-not $st.compute -or ((Get-Date) - [datetime]$st.computeAt).TotalSeconds -gt 600) {
    $asrRoot = 'D:\LLM\vibeasr'
    if (-not (Test-Path -LiteralPath $asrRoot)) { $asrRoot = 'C:\LLM\vibeasr' }
    $st.compute = @{ asr = (Get-VibeInfo $asrRoot); v7b = (Get-VibeInfo 'D:\LLM\vibe7b') }
    $st.computeAt = (Get-Date).ToString('s')
  }
  return @{
    monitor   = @{ installed = (Get-AgentInstalled 'WorkbenchMonitor' 'monitor.ps1'); running = (Test-MutexHeld 'Global\WorkbenchMonitor_v2') }
    clipboard = @{ installed = (Get-AgentInstalled 'WorkbenchClipboard' 'watcher.ps1'); running = (Test-MutexHeld 'Global\WorkbenchClipboard') }
    pet       = @{ installed = (Get-AgentInstalled 'WorkbenchDesktopPet' 'desktop-pet.ps1'); running = (Test-MutexHeld 'Global\WorkbenchDesktopPet'); show = [bool]$st.pet }
    lyrics    = @{ installed = (Get-AgentInstalled 'WorkbenchLyrics' 'setup.ps1'); running = (Test-MutexHeld 'Global\WorkbenchLyrics'); show = [bool]$st.lyrics }
    compute   = $st.compute
  }
}
function Status-Text([bool]$installed, [bool]$running) {
  if ($running) { return '已连接' }
  if ($installed) { return '已安装未运行' }
  return '未安装'
}

# ---------- 托盘图标（四方块 dashboard，与网页 favicon 同形同色 #2d5fd9） ----------
function New-TrayIcon {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(45, 95, 217))
  $g.FillRectangle($brush, 4, 4, 11, 13)
  $g.FillRectangle($brush, 17, 4, 11, 8)
  $g.FillRectangle($brush, 4, 20, 11, 8)
  $g.FillRectangle($brush, 17, 15, 11, 13)
  $g.Dispose()
  $brush.Dispose()
  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  return $ico
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-TrayIcon
$notify.Text = '全能工作台·启动端'
$notify.Visible = $true

# 菜单七项（没有退出项——卸载走设置页的卸载包）
$menu = New-Object System.Windows.Forms.ContextMenu
$miNotify = New-Object System.Windows.Forms.MenuItem('短消息通知')
$miPopup = New-Object System.Windows.Forms.MenuItem('弹出桌面通知')
$miVoice = New-Object System.Windows.Forms.MenuItem('自动播放语音')
[void]$miNotify.MenuItems.Add($miPopup)
[void]$miNotify.MenuItems.Add($miVoice)
[void]$menu.MenuItems.Add($miNotify)
$miMonitor = New-Object System.Windows.Forms.MenuItem('电脑监控 · 检测中')
$miMonitor.Enabled = $false
[void]$menu.MenuItems.Add($miMonitor)
$miClip = New-Object System.Windows.Forms.MenuItem('剪贴板采集 · 检测中')
$miClip.Enabled = $false
[void]$menu.MenuItems.Add($miClip)
[void]$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem('-')))
$miPet = New-Object System.Windows.Forms.MenuItem('电子宠物 · 检测中')
[void]$menu.MenuItems.Add($miPet)
$miLyrics = New-Object System.Windows.Forms.MenuItem('悬浮歌词 · 检测中')
[void]$menu.MenuItems.Add($miLyrics)
[void]$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem('-')))
$miCompute = New-Object System.Windows.Forms.MenuItem('录音转写算力')
$miAsr = New-Object System.Windows.Forms.MenuItem('VibeASR 1.5B · 检测中')
$miAsr.Enabled = $false
$miV7b = New-Object System.Windows.Forms.MenuItem('VibeVoice 7B · 检测中')
$miV7b.Enabled = $false
[void]$miCompute.MenuItems.Add($miAsr)
[void]$miCompute.MenuItems.Add($miV7b)
[void]$menu.MenuItems.Add($miCompute)
[void]$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem('-')))
$miTarget = New-Object System.Windows.Forms.MenuItem('连接目标 · ' + $server)
[void]$menu.MenuItems.Add($miTarget)
$notify.ContextMenu = $menu

# 菜单点击（-Action 只翻同步哈希表里的标志位，主循环统一应用——不在事件线程碰 UI）
Register-ObjectEvent -InputObject $miPopup -EventName Click -SourceIdentifier LchPopup -MessageData $st -Action { $s = $Event.MessageData; $s.popup = -not $s.popup; $s.save = $true } | Out-Null
Register-ObjectEvent -InputObject $miVoice -EventName Click -SourceIdentifier LchVoice -MessageData $st -Action { $s = $Event.MessageData; $s.voice = -not $s.voice; $s.save = $true } | Out-Null
Register-ObjectEvent -InputObject $miPet -EventName Click -SourceIdentifier LchPet -MessageData $st -Action { $s = $Event.MessageData; $s.pet = -not $s.pet; $s.petDirty = $true } | Out-Null
Register-ObjectEvent -InputObject $miLyrics -EventName Click -SourceIdentifier LchLyrics -MessageData $st -Action { $s = $Event.MessageData; $s.lyrics = -not $s.lyrics; $s.lyricsDirty = $true } | Out-Null
Register-ObjectEvent -InputObject $miTarget -EventName Click -SourceIdentifier LchTarget -MessageData $server -Action { try { Start-Process ($Event.MessageData) } catch { } } | Out-Null
# 点击弹窗任意位置 = 已读（走既有 /api/messages/agent/read）+ 打开消息页
Register-ObjectEvent -InputObject $notify -EventName BalloonTipClicked -SourceIdentifier LchBalloon -MessageData $st -Action {
  $s = $Event.MessageData
  $m = $s.cur
  if ($m) {
    $s.cur = $null
    try {
      $body = @{ key = $s.nKey; uid = [int]$s.uid; id = [int]$m.id } | ConvertTo-Json
      Invoke-RestMethod -Method Post -Uri ($s.server + '/api/messages/agent/read') -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
    } catch { }
    try { Start-Process ($s.server + '/#/messages') } catch { }
  }
} | Out-Null

# 主线程应用待办：勾选态、偏好落盘、宠物/歌词子进程对齐（启动时 petDirty/lyricsDirty 均为真＝
# 「设置一次下次启动保持」的执行点）
function Apply-Pending {
  try {
    $miPopup.Checked = [bool]$st.popup
    $miVoice.Checked = [bool]$st.voice
    if ($st.petDirty) {
      $st.petDirty = $false
      $miPet.Checked = [bool]$st.pet
      if (Get-AgentInstalled 'WorkbenchDesktopPet' 'desktop-pet.ps1') {
        if ($st.pet) { Start-Agent 'WorkbenchDesktopPet' 'desktop-pet.ps1' } else { Stop-Agent 'WorkbenchDesktopPet' }
      }
      $st.save = $true
    }
    if ($st.lyricsDirty) {
      $st.lyricsDirty = $false
      $miLyrics.Checked = [bool]$st.lyrics
      if (Get-AgentInstalled 'WorkbenchLyrics' 'setup.ps1') {
        if ($st.lyrics) { Start-Agent 'WorkbenchLyrics' 'setup.ps1' } else { Stop-Agent 'WorkbenchLyrics' }
      }
      $st.save = $true
    }
    if ($st.save) { $st.save = $false; Save-State }
  } catch { Log ('apply failed: ' + $_.Exception.Message) }
}

function Update-StatusText {
  try {
    $d = Get-StatusData
    $miMonitor.Text = '电脑监控 · ' + (Status-Text $d.monitor.installed $d.monitor.running)
    $miClip.Text = '剪贴板采集 · ' + (Status-Text $d.clipboard.installed $d.clipboard.running)
    if ($d.pet.installed) {
      if ($d.pet.running) { $miPet.Text = '电子宠物 · 显示中' }
      elseif ($st.pet) { $miPet.Text = '电子宠物 · 启动中' }
      else { $miPet.Text = '电子宠物 · 已隐藏' }
    } else { $miPet.Text = '电子宠物 · 未安装' }
    if ($d.lyrics.installed) {
      if ($d.lyrics.running) { $miLyrics.Text = '悬浮歌词 · 显示中' }
      elseif ($st.lyrics) { $miLyrics.Text = '悬浮歌词 · 启动中' }
      else { $miLyrics.Text = '悬浮歌词 · 已隐藏' }
    } else { $miLyrics.Text = '悬浮歌词 · 未安装' }
    $miAsr.Text = 'VibeASR 1.5B · ' + ($(if ($d.compute.asr.installed) { '已安装 ' + [string]$d.compute.asr.gb + ' GB' } else { '未安装' }))
    $miV7b.Text = 'VibeVoice 7B · ' + ($(if ($d.compute.v7b.installed) { '已安装 ' + [string]$d.compute.v7b.gb + ' GB' } else { '未安装' }))
    return $d
  } catch { return $null }
}

function Play-Voice($m) {
  try {
    if (-not $m.voice_b64) { return }
    $wav = Join-Path $env:TEMP ('wb-voice-' + $m.id + '.wav')
    [IO.File]::WriteAllBytes($wav, [Convert]::FromBase64String($m.voice_b64))
    $p = New-Object System.Media.SoundPlayer($wav)
    $st.player = $p
    $p.Play()
  } catch { Log ('voice play failed: ' + $_.Exception.Message) }
}

Log ('launcher started -> ' + $server + ' (uid ' + $uid + ', dev ' + $devId + ')')
$interval = 20
while ($true) {
  try {
    $d = Update-StatusText
    $sv = @{
      notify = @{ on = $true; popup = [bool]$st.popup; voice = [bool]$st.voice }
      monitor = $d.monitor; clipboard = $d.clipboard; pet = $d.pet; lyrics = $d.lyrics
      compute = $d.compute; target = $server
    }
    $url = $server + '/api/launcher/agent/poll?id=' + $devId + '&key=' + $lKey + '&uid=' + $uid + '&nk=' + $nKey + '&computer=' + [uri]::EscapeDataString([string]$env:COMPUTERNAME) + '&v=1&after=' + [int]$st.last + '&sv=' + [uri]::EscapeDataString((ConvertTo-Json $sv -Compress -Depth 5))
    $r = Invoke-RestMethod -Uri $url -TimeoutSec 15
    if ($r.ok) {
      if ($r.interval) { $interval = [int]$r.interval }
      foreach ($m in @($r.messages)) {
        if ($null -eq $m) { continue }
        if ([int]$m.id -gt [int]$st.last) { $st.last = [int]$m.id; $st.save = $true }
        if (-not $st.popup) { continue }
        $title = '[' + $m.module_label + '] ' + [string]$m.subject
        if (-not $m.subject) { $title = '[' + $m.module_label + '] 新消息' }
        if ($title.Length -gt 60) { $title = $title.Substring(0, 60) }
        $body = [string]$m.from_name + ' · ' + [string]$m.created_at
        if ($m.is_voice) {
          $vtxt = ''
          if ($m.voice_text) { $vtxt = ([string]$m.voice_text).Trim() }
          $body = $body + [Environment]::NewLine + '[语音 ' + [Math]::Ceiling([double]$m.voice_secs) + ' 秒] ' + $vtxt
        } else {
          $body = $body + [Environment]::NewLine + ([string]$m.content).Trim()
        }
        if ($body.Length -gt 230) { $body = $body.Substring(0, 230) + '...' }
        if ($r.autoplay -and $m.is_voice -and $st.voice) { Play-Voice $m }
        $st.cur = $m
        $notify.BalloonTipTitle = $title
        $notify.BalloonTipText = $body
        $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $notify.ShowBalloonTip(15000)
        Log ('popup #' + $m.id + ' from ' + $m.from_name)
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline -and $null -ne $st.cur) { Start-Sleep -Milliseconds 250; Apply-Pending }
        $st.cur = $null
      }
    }
  } catch { Log ('poll failed: ' + $_.Exception.Message) }
  $end = (Get-Date).AddSeconds($interval)
  while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 400; Apply-Pending }
}
`;

// ---------- 安装包 ----------
const CMD_INSTALL = [
  '@echo off',
  'chcp 65001 >nul',
  'title Workbench Launcher - Install',
  'echo.',
  'echo  全能工作台 · 集中启动端 安装',
  'echo  --------------------------------',
  'echo  安装到 %LOCALAPPDATA%\WorkbenchLauncher 并设开机自启（任务栏右下角出现四方块图标）。',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cmd install',
  'echo.',
  'pause',
].join('\r\n');
const CMD_UNINSTALL = [
  '@echo off',
  'chcp 65001 >nul',
  'title Workbench Launcher - Uninstall',
  'echo.',
  'echo  全能工作台 · 集中启动端 卸载',
  'echo  --------------------------------',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cmd uninstall',
  'echo.',
  'pause',
].join('\r\n');
const README_TXT = '\uFEFF' + [
  '全能工作台 · 集中启动端（Windows）',
  '',
  '【装法】双击 安装.cmd。装到 %LOCALAPPDATA%\\WorkbenchLauncher，并设了开机自启，',
  '任务栏右下角出现与网页同款的四方块图标。',
  '',
  '【托盘菜单（右键图标）】',
  '  短消息通知 —— 弹出桌面通知 / 自动播放语音 两个开关（关掉弹通知后消息只记数不弹窗）；',
  '  电脑监控 · 剪贴板采集 —— 只显示联网状态，不能从这里关停（保运行连续性）；',
  '  电子宠物 / 悬浮歌词 —— 显示与隐藏（= 拉起/停掉对应客户端），设置一次下次开机保持；',
  '  录音转写算力 —— 显示 VibeASR 1.5B / VibeVoice 7B 是否就位、安装路径与模型容量；',
  '  连接目标 —— 查看当前对接的工作台地址（点击可在浏览器打开，不能修改）。',
  '  按设计整体没有退出按钮；要撤掉它请用 卸载.cmd。',
  '',
  '【消息弹窗】有新短消息时右下角弹窗（与网页一致）；点击弹窗 = 标记已读并打开消息页；',
  '语音消息按「自动播放语音」开关自动播放。',
  '',
  '【说明】启动端只调两个只读接口：20 秒一次 GET /api/launcher/agent/poll（心跳 + 取消息），',
  '弹窗点击时 POST /api/messages/agent/read（已读回执）。它管理但并不代替其它客户端——',
  '监控/剪贴板/宠物/歌词/算力各自的安装包在工作台「设置 → 启动端」页集中下载。',
  '',
  '【卸载】双击 卸载.cmd（移除开机自启并删除程序目录；不影响已装的其它客户端）。',
].join('\r\n');

// baseUrl = 工作台对 Agent 可达的根地址；key=启动端全局 key；uid+nkey=下载者本人（弹他/她的消息）
// opts.uninstall=true 出「卸载包」：setup.ps1 + 卸载.cmd + 使用说明（不带 安装.cmd，要的就是个小包）
function buildPackage(baseUrl, key, uid, nkey, opts = {}) {
  const ps = '\uFEFF' + PS_TEMPLATE
    .replace(/__SERVER__/g, String(baseUrl || '').trim().replace(/\/+$/, ''))
    .replace(/__KEY__/g, key)
    .replace(/__UID__/g, String(Number(uid) || 0))
    .replace(/__NKEY__/g, nkey);
  const entries = [{ name: 'setup.ps1', data: ps }];
  if (!opts.uninstall) entries.push({ name: '安装.cmd', data: CMD_INSTALL });
  entries.push({ name: '卸载.cmd', data: CMD_UNINSTALL });
  entries.push({ name: '使用说明.txt', data: README_TXT });
  return buildZip(entries);
}

module.exports = {
  DEVICE_ID_RE, ONLINE_MS, POLL_INTERVAL_S,
  getAgentKey, rotateAgentKey, checkAgentKey,
  ensureAgent, listAgents, updateAgent, deleteAgent,
  notifyKeyFor, pollPayload,
  PS_TEMPLATE, buildPackage,
};

