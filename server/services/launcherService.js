// 集中启动端代理后端（v1.18.0 引入，v1.18.3 重构托盘）：Windows 托盘启动端助手的支持层。
// 启动端 = 一个 PowerShell 常驻进程（NotifyIcon 托盘，无退出按钮），统一用一条
// GET /api/launcher/agent/poll 心跳对接工作台（index.js EXEMPT 精确匹配）：
//   - 注册/心跳/本机各服务状态上报（sv 参数，JSON）全在这条 GET 里，20 秒一次；
//   - 心跳回程复用「短消息桌面通知」的未读消息查询（uid + users.notify_key 双凭证，
//     key 不匹配只少给消息、不拦心跳——设备在场性靠 settings.launcher_key，消息可读性靠每用户 notify_key）；
//   - 已读回执走既有 EXEMPT 端点 POST /api/messages/agent/read（不新开面）。
// v1.18.3 托盘重构（用户实测三连报：右键菜单闪一下就没了/歌词永远启动中/想一键全装+托盘勾选）：
//   - 消息泵：v1 的 Start-Sleep 死循环不泵 Windows 消息——菜单闪退、Register-ObjectEvent 点击
//     根本不触发。v2 改标准 WinForms 消息循环（Application.Run + Forms.Timer），事件全用
//     直接 add_Click（在 UI 线程内触发，与悬浮歌词代理同一套被生产验证过的写法）；
//   - 心跳挪后台 runspace：HTTP 永不阻塞托盘（15s 超时也只挂后台线程）；
//   - 看护：勾着「开」而进程没在跑的客户端每 45s 自动重拉（v1 只在开机拉一次，代理一死
//     就永远停在「启动中」）；勾「关」而仍在跑的按托盘设置停掉；
//   - 托盘七项里「电脑监控/剪贴板采集/电子宠物/悬浮歌词」全部可勾选启用/停用（偏好落 state.json）；
//   - 安装包改全家桶：内嵌 clients\ 四个客户端安装脚本（与集中下载各页同源同 key），
//     -Cmd install 一键全装；-Cmd uninstall 一键全卸（监控/剪贴板/宠物/歌词 + 启动端自己）。
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
    `SELECT m.*, COALESCE(NULLIF(u2.display_name,''), u2.username) AS from_name FROM messages m
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

// ---------- 启动端助手脚本（v2：PowerShell 5.1 + WinForms 托盘 + 真消息循环，Windows） ----------
// 结构（v1.18.3 重构，根治用户实测三连报）：
//   ① UI 线程跑 [System.Windows.Forms.Application]::Run() —— 标准 WinForms 消息循环，
//      右键菜单不再闪退、add_Click 直接触发（v1 的 Start-Sleep 死循环不泵消息，
//      Register-ObjectEvent 在无泵环境下根本不触发——菜单闪一下就没了的根因）；
//   ② 心跳/已读回执挪后台 runspace（与悬浮歌词代理同一套生产验证过的双 runspace 写法），
//      HTTP 15s 超时也只挂后台线程，托盘永不卡；
//   ③ 看护：勾「开」而没在跑的客户端每 45s 重拉（v1 只在开机拉一次，代理一死永远「启动中」）；
//      勾「关」而仍在跑的按托盘设置停掉；
//   ④ 托盘：短消息两开关 + 监控/剪贴板/宠物/歌词四个可勾选启用项 + 转写算力只读 + 连接目标只读；
//      四项偏好落 state.json，下次开机保持。整体不设退出/关闭按钮——卸载走设置页的卸载包（全卸）。
//   ⑤ -Cmd install 一键全装：先装启动端，再静默装包内 clients\ 下的四个客户端；
//      -Cmd uninstall 一键全卸：监控/剪贴板/宠物/歌词 + 启动端自己（录音转写算力不动）。
// 写法约束：PS 里不用反引号、不用 ${} 变量花括号语法——本模板要嵌进 JS String.raw 字面量。
const PS_TEMPLATE = String.raw`# =====================================================================
#  全能工作台 · 集中启动端助手 v2（Windows PowerShell 5.1 + WinForms 托盘）
#  - 无参数或 run   ：常驻运行（开机自启拉起的就是这个）
#  - -Cmd install   ：装启动端到 %LOCALAPPDATA%\WorkbenchLauncher + 静默装包内
#                     clients\ 的监控/剪贴板/宠物/歌词四个客户端 + 设开机自启 + 启动
#  - -Cmd uninstall ：一键全卸（启动端 + 监控/剪贴板/宠物/歌词；录音转写算力不动）
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

# 四个被管理的客户端：安装目录名 / 常驻脚本名 / 单实例互斥锁名（与各自安装包一致）
$AgApps = @{
  monitor   = @{ app = 'WorkbenchMonitor';    file = 'monitor.ps1';     mtx = 'Global\WorkbenchMonitor_v2' }
  clipboard = @{ app = 'WorkbenchClipboard';  file = 'watcher.ps1';     mtx = 'Global\WorkbenchClipboard' }
  pet       = @{ app = 'WorkbenchDesktopPet'; file = 'desktop-pet.ps1'; mtx = 'Global\WorkbenchDesktopPet' }
  lyrics    = @{ app = 'WorkbenchLyrics';     file = 'setup.ps1';       mtx = 'Global\WorkbenchLyrics' }
}

# ---------- 安装（一键全装） ----------
if ($Cmd -eq 'install') {
  New-Item -ItemType Directory -Force -Path $InstDir | Out-Null
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $InstDir 'launcher.ps1') -Force
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $AppName -Value ('powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstDir 'launcher.ps1') + '"')
  # 包内 clients\ 带着其余四个客户端的安装脚本（与工作台「设置→启动端」集中下载同源同密钥）。
  # 各脚本首跑=自装（复制自身到 %LOCALAPPDATA% + 设自启 + 转常驻），这里只负责逐个静默拉起。
  $cliDir = Join-Path (Split-Path $PSCommandPath -Parent) 'clients'
  foreach ($f in @('monitor-setup.ps1', 'clipboard-setup.ps1', 'desktop-pet-setup.ps1')) {
    $p = Join-Path $cliDir $f
    if (Test-Path -LiteralPath $p) {
      Write-Host ('正在安装客户端：' + $f)
      Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $p + '"')
    } else {
      Write-Host ('跳过（包内没有）：' + $f)
    }
  }
  $lyr = Join-Path $cliDir 'lyrics\setup.ps1'
  if (Test-Path -LiteralPath $lyr) {
    Write-Host '正在安装客户端：悬浮歌词（含思源黑体字体）'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $lyr + '" -Cmd install')
  }
  Write-Host ''
  Write-Host ('启动端已安装到 ' + $InstDir + '，并设了开机自启。')
  Write-Host '各客户端正在后台安装（各自装到 %LOCALAPPDATA% 并设开机自启，几秒内陆续就绪）。'
  Write-Host '托盘右键菜单可勾选启用/停用：电脑监控、剪贴板采集、电子宠物、悬浮歌词。'
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstDir 'launcher.ps1') + '"')
  exit 0
}

# ---------- 卸载（一键全卸：启动端 + 四个客户端；录音转写算力体积大需手工装，不动） ----------
if ($Cmd -eq 'uninstall') {
  foreach ($app in @('WorkbenchMonitor', 'WorkbenchClipboard', 'WorkbenchDesktopPet', 'WorkbenchLyrics', $AppName)) {
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $app -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('WorkbenchMonitor') -or $_.CommandLine.Contains('WorkbenchClipboard') -or $_.CommandLine.Contains('WorkbenchDesktopPet') -or $_.CommandLine.Contains('WorkbenchLyrics') -or $_.CommandLine.Contains($AppName)) -and $_.ProcessId -ne $PID } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Start-Sleep -Milliseconds 800
  foreach ($app in @('WorkbenchMonitor', 'WorkbenchClipboard', 'WorkbenchDesktopPet', 'WorkbenchLyrics', $AppName)) {
    $d = Join-Path $env:LOCALAPPDATA $app
    if ($d -and (Test-Path -LiteralPath $d)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host '已卸载：启动端与 电脑监控/剪贴板采集/电子宠物/悬浮歌词 客户端。'
  Write-Host '（开机自启已移除、各程序目录已删除；录音转写算力不在此列，如需删除其目录请手工处理。）'
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

# 共享状态：UI 线程与心跳后台 runspace 靠它传话（inbox=待弹消息队列，readQ=待发已读回执队列）
$st = [hashtable]::Synchronized(@{
  popup = $true; voice = $true                                   # 偏好：弹通知/播语音
  monitor = $true; clipboard = $true; pet = $true; lyrics = $true # 偏好：四客户端启用/停用（勾=开）
  last = 0; save = $false                                        # last=已计数的最大消息 id
  monDirty = $true; clipDirty = $true; petDirty = $true; lyricsDirty = $true  # 启动时强制对齐四客户端
  cur = $null; player = $null; autoplay = $false                 # 当前弹窗消息 / 语音播放器 / 服务端语音自动播
  sv = ''; inbox = $null; readQ = $null                          # 心跳上报快照 / 消息队列 / 已读队列（下面补建）
  startAt = @{}                                                  # 各客户端最近一次拉起时间（看护 45s 冷却用）
  compute = $null; computeAt = ''                                # 算力目录扫描缓存（10 分钟一次，别每拍扫 1.7GB）
})
$st.inbox = [System.Collections.ArrayList]::Synchronized([System.Collections.ArrayList]::new())
$st.readQ = [System.Collections.ArrayList]::Synchronized([System.Collections.ArrayList]::new())
$st.server = $server; $st.lKey = $lKey; $st.uid = $uid; $st.nKey = $nKey; $st.logfile = $LogFile
try {
  if (Test-Path -LiteralPath $StateFile) {
    $j = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    foreach ($k in @('popup', 'voice', 'monitor', 'clipboard', 'pet', 'lyrics')) { $v = $j.$k; if ($null -ne $v) { $st[$k] = [bool]$v } }
    if ($null -ne $j.last) { $st.last = [int]$j.last }
  }
} catch { }
function Save-State {
  try {
    $o = @{ popup = [bool]$st.popup; voice = [bool]$st.voice; monitor = [bool]$st.monitor; clipboard = [bool]$st.clipboard; pet = [bool]$st.pet; lyrics = [bool]$st.lyrics; last = [int]$st.last }
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
$st.devId = $devId

# ---------- 本机各客户端探测/拉起/停止（按 $AgApps 表，四客户端同一套动作） ----------
function Test-MutexHeld([string]$name) {
  try {
    $m = New-Object System.Threading.Mutex($false, $name)
    $held = $false
    try { $held = -not $m.WaitOne(0); if (-not $held) { $m.ReleaseMutex() } } catch { $held = $false; try { $m.ReleaseMutex() } catch { } }
    $m.Dispose()
    return $held
  } catch { return $false }
}
function Get-AgentInstalled([string]$k) {
  $a = $AgApps[$k]
  return (Test-Path -LiteralPath (Join-Path (Join-Path $env:LOCALAPPDATA $a.app) $a.file))
}
function Start-Agent([string]$k) {
  $a = $AgApps[$k]
  $p = Join-Path (Join-Path $env:LOCALAPPDATA $a.app) $a.file
  if (-not (Test-Path -LiteralPath $p)) { return }
  # v1.18.5 永久退出握手：用户在托盘重新勾选 = 明确要开——摘掉客户端落的停用标记再拉起
  try { Remove-Item -LiteralPath (Join-Path (Join-Path $env:LOCALAPPDATA $a.app) 'disabled.flag') -Force -ErrorAction SilentlyContinue } catch { }
  try {
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $p + '"')
    $st.startAt[$k] = (Get-Date).ToString('s')
    Log ('子客户端拉起：' + $a.app)
  } catch { Log ('子客户端拉起失败 ' + $a.app + '：' + $_.Exception.Message) }
}
function Stop-Agent([string]$k) {
  $a = $AgApps[$k]
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($a.app) -and $_.ProcessId -ne $PID } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Log ('子客户端停止：' + $a.app)
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
  $out = @{}
  foreach ($k in @('monitor', 'clipboard', 'pet', 'lyrics')) {
    $out[$k] = @{ installed = (Get-AgentInstalled $k); running = (Test-MutexHeld $AgApps[$k].mtx); on = [bool]$st[$k]; show = [bool]$st[$k] }
  }
  $out.compute = $st.compute
  return $out
}
function Get-AgentText($x) {
  if (-not $x.installed) { return '未安装' }
  if ($x.running) { return '运行中' }
  if ($x.on) { return '启动中' }
  return '已停用'
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

# 菜单七项（没有退出项——卸载走设置页的卸载包）。监控/剪贴板/宠物/歌词四项可勾选：
# 勾=启用（没在跑则拉起），去勾=停用（在跑则停掉）；偏好落 state.json 下次开机保持。
$menu = New-Object System.Windows.Forms.ContextMenu
$miNotify = New-Object System.Windows.Forms.MenuItem('短消息通知')
$miPopup = New-Object System.Windows.Forms.MenuItem('弹出桌面通知')
$miVoice = New-Object System.Windows.Forms.MenuItem('自动播放语音')
[void]$miNotify.MenuItems.Add($miPopup)
[void]$miNotify.MenuItems.Add($miVoice)
[void]$menu.MenuItems.Add($miNotify)
$miMonitor = New-Object System.Windows.Forms.MenuItem('电脑监控 · 检测中')
[void]$menu.MenuItems.Add($miMonitor)
$miClip = New-Object System.Windows.Forms.MenuItem('剪贴板采集 · 检测中')
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

# 菜单点击：直接 add_Click（v2 有真消息循环，在 UI 线程内触发；只翻 $st 标志位，
# Apply-Pending 统一应用——不在事件里做耗时动作，菜单零卡顿）
$null = $miPopup.Add_Click({ $st.popup = -not $st.popup; $st.save = $true })
$null = $miVoice.Add_Click({ $st.voice = -not $st.voice; $st.save = $true })
$null = $miMonitor.Add_Click({ $st.monitor = -not $st.monitor; $st.monDirty = $true })
$null = $miClip.Add_Click({ $st.clipboard = -not $st.clipboard; $st.clipDirty = $true })
$null = $miPet.Add_Click({ $st.pet = -not $st.pet; $st.petDirty = $true })
$null = $miLyrics.Add_Click({ $st.lyrics = -not $st.lyrics; $st.lyricsDirty = $true })
$null = $miTarget.Add_Click({ try { Start-Process ($st.server) } catch { } })
# 点击弹窗任意位置 = 已读（回执交给心跳线程发）+ 打开消息页
$null = $notify.Add_BalloonTipClicked({
  $m = $st.cur
  if ($m) {
    $st.cur = $null
    [void]$st.readQ.Add([int]$m.id)
    try { Start-Process ($st.server + '/#/messages') } catch { }
  }
})

# 主线程应用待办：勾选态、偏好落盘、四客户端对齐（启动时四个 Dirty 均为真＝
# 「设置一次下次启动保持」的执行点：勾着的没跑就拉、去勾的在跑就停）
function Apply-Pending {
  try {
    $miPopup.Checked = [bool]$st.popup
    $miVoice.Checked = [bool]$st.voice
    $miMonitor.Checked = ((Get-AgentInstalled 'monitor') -and [bool]$st.monitor)
    $miClip.Checked = ((Get-AgentInstalled 'clipboard') -and [bool]$st.clipboard)
    $miPet.Checked = ((Get-AgentInstalled 'pet') -and [bool]$st.pet)
    $miLyrics.Checked = ((Get-AgentInstalled 'lyrics') -and [bool]$st.lyrics)
    if ($st.monDirty) {
      $st.monDirty = $false
      if (Get-AgentInstalled 'monitor') { if ($st.monitor) { Start-Agent 'monitor' } else { Stop-Agent 'monitor' } }
      $st.save = $true
    }
    if ($st.clipDirty) {
      $st.clipDirty = $false
      if (Get-AgentInstalled 'clipboard') { if ($st.clipboard) { Start-Agent 'clipboard' } else { Stop-Agent 'clipboard' } }
      $st.save = $true
    }
    if ($st.petDirty) {
      $st.petDirty = $false
      if (Get-AgentInstalled 'pet') { if ($st.pet) { Start-Agent 'pet' } else { Stop-Agent 'pet' } }
      $st.save = $true
    }
    if ($st.lyricsDirty) {
      $st.lyricsDirty = $false
      if (Get-AgentInstalled 'lyrics') { if ($st.lyrics) { Start-Agent 'lyrics' } else { Stop-Agent 'lyrics' } }
      $st.save = $true
    }
    if ($st.save) { $st.save = $false; Save-State }
  } catch { Log ('apply failed: ' + $_.Exception.Message) }
}

# 状态刷新 + 看护（约 10 秒一拍）：文案/可勾选、心跳 sv 快照、
# 勾「开」而没在跑的 45s 冷却后重拉（代理崩溃自愈）；勾「关」而仍在跑的按设置停掉。
function Update-StatusText {
  try {
    $d = Get-StatusData
    $miMonitor.Text = '电脑监控 · ' + (Get-AgentText $d.monitor)
    $miMonitor.Enabled = [bool]$d.monitor.installed
    $miClip.Text = '剪贴板采集 · ' + (Get-AgentText $d.clipboard)
    $miClip.Enabled = [bool]$d.clipboard.installed
    $miPet.Text = '电子宠物 · ' + (Get-AgentText $d.pet)
    $miPet.Enabled = [bool]$d.pet.installed
    $miLyrics.Text = '悬浮歌词 · ' + (Get-AgentText $d.lyrics)
    $miLyrics.Enabled = [bool]$d.lyrics.installed
    $miAsr.Text = 'VibeASR 1.5B · ' + ($(if ($d.compute.asr.installed) { '已安装 ' + [string]$d.compute.asr.gb + ' GB' } else { '未安装' }))
    $miV7b.Text = 'VibeVoice 7B · ' + ($(if ($d.compute.v7b.installed) { '已安装 ' + [string]$d.compute.v7b.gb + ' GB' } else { '未安装' }))
    foreach ($k in @('monitor', 'clipboard', 'pet', 'lyrics')) {
      $x = $d[$k]
      if (-not $x.installed) { continue }
      # v1.18.5 永久退出握手：客户端右键「永久退出」会落 disabled.flag——尊重它：
      # 把托盘勾选翻成未勾并落盘（本拍 continue 跳过看护，下一拍自然走「未勾」分支）
      if ($x.on -and (Test-Path -LiteralPath (Join-Path (Join-Path $env:LOCALAPPDATA $AgApps[$k].app) 'disabled.flag'))) {
        $st[$k] = $false
        $st.save = $true
        Log ('客户端请求永久停用（disabled.flag），托盘已翻为未勾：' + $AgApps[$k].app)
        continue
      }
      if ($x.on -and -not $x.running) {
        $ago = 999
        $la = [string]$st.startAt[$k]
        if ($la) { try { $ago = ((Get-Date) - [datetime]$la).TotalSeconds } catch { } }
        if ($ago -gt 45) { Start-Agent $k; Log ('看护拉起（勾着开但没在跑）：' + $AgApps[$k].app) }
      } elseif (-not $x.on -and $x.running) {
        Stop-Agent $k
        Log ('按托盘设置停用：' + $AgApps[$k].app)
      }
    }
    $st.sv = ConvertTo-Json @{
      notify = @{ on = $true; popup = [bool]$st.popup; voice = [bool]$st.voice }
      monitor = $d.monitor; clipboard = $d.clipboard; pet = $d.pet; lyrics = $d.lyrics
      compute = $d.compute; target = $server
    } -Compress -Depth 5
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

# 取回的消息统一弹最后一条（都记日志）；语音按「自动播放语音」+服务端 autoplay 开关播
function Drain-Inbox {
  if ($st.inbox.Count -le 0) { return }
  $newest = $null
  while ($st.inbox.Count -gt 0) {
    $m = $st.inbox[0]
    $st.inbox.RemoveAt(0)
    if ($null -eq $m) { continue }
    $newest = $m
    Log ('收到消息 #' + $m.id + ' from ' + $m.from_name)
  }
  if ($null -eq $newest) { return }
  if (-not $st.popup) { return }
  $m = $newest
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
  if ($st.autoplay -and $m.is_voice -and $st.voice) { Play-Voice $m }
  $st.cur = $m
  $notify.BalloonTipTitle = $title
  $notify.BalloonTipText = $body
  $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $notify.ShowBalloonTip(15000)
}

# ---------- 心跳后台 runspace：20s 一跳（HTTP 15s 超时只挂这条线程，托盘永不卡） ----------
# 双向：inbox 送回待弹消息；readQ 取走弹窗点击产生的已读回执并发掉。
$pollScript = @'
$ErrorActionPreference = 'Stop'
$interval = 20
$fail = 0
while ($true) {
  try {
    $qs = '?id=' + $st.devId + '&key=' + $st.lKey + '&uid=' + $st.uid + '&nk=' + $st.nKey + '&computer=' + [uri]::EscapeDataString([string]$env:COMPUTERNAME) + '&v=2&after=' + [int]$st.last
    $sv = [string]$st.sv
    if ($sv) { $qs = $qs + '&sv=' + [uri]::EscapeDataString($sv) }
    $r = Invoke-RestMethod -Uri ([string]$st.server + '/api/launcher/agent/poll' + $qs) -TimeoutSec 15
    if ($r.ok) {
      $st.autoplay = [bool]$r.autoplay
      if ($r.interval) { $interval = [int]$r.interval }
      foreach ($m in @($r.messages)) {
        if ($null -eq $m) { continue }
        if ([int]$m.id -gt [int]$st.last) { $st.last = [int]$m.id; $st.save = $true }
        [void]$st.inbox.Add($m)
      }
      while ($st.readQ.Count -gt 0) {
        $rid = $st.readQ[0]
        $st.readQ.RemoveAt(0)
        try {
          $body = @{ key = $st.nKey; uid = [int]$st.uid; id = [int]$rid } | ConvertTo-Json
          Invoke-RestMethod -Method Post -Uri ([string]$st.server + '/api/messages/agent/read') -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
        } catch { }
      }
      if ($fail -gt 0) {
        try { Add-Content -LiteralPath ([string]$st.logfile) -Value ((Get-Date -Format 'MM-dd HH:mm:ss') + ' poll 恢复（此前连续失败 ' + $fail + ' 次）') -Encoding UTF8 } catch { }
      }
      $fail = 0
    }
  } catch {
    $fail++
    if ($fail -le 3 -or ($fail % 15) -eq 0) {
      try { Add-Content -LiteralPath ([string]$st.logfile) -Value ((Get-Date -Format 'MM-dd HH:mm:ss') + ' poll 失败 x' + $fail + '：' + $_.Exception.Message) -Encoding UTF8 } catch { }
    }
  }
  Start-Sleep -Seconds $interval
}
'@
$pollRs = [runspacefactory]::CreateRunspace()
$pollRs.Open()
$pollRs.SessionStateProxy.SetVariable('st', $st)
$pollPs = [powershell]::Create()
$pollPs.Runspace = $pollRs
$null = $pollPs.AddScript($pollScript).BeginInvoke()

# 启动即对齐一轮（先应用偏好再刷新状态，避免看护和启动 Dirty 双拉），
# 然后 UI 定时器 400ms 一拍做待办/弹消息，每 25 拍（约 10s）刷新状态与看护。
Apply-Pending
$null = Update-StatusText
$uiTimer = New-Object System.Windows.Forms.Timer
$uiTimer.Interval = 400
$script:tickN = 0
$null = $uiTimer.Add_Tick({
  try {
    Apply-Pending
    Drain-Inbox
    $script:tickN = [int]$script:tickN + 1
    if ($script:tickN -ge 25) { $script:tickN = 0; $null = Update-StatusText }
  } catch { try { Log ('tick failed: ' + $_.Exception.Message) } catch { } }
})
$uiTimer.Start()
Log ('launcher started -> ' + $server + ' (uid ' + $uid + ', dev ' + $devId + ')')
# 标准 WinForms 消息循环：托盘菜单/点击/气泡全靠它（v1 无泵循环=菜单闪退的根治）
[System.Windows.Forms.Application]::Run()
`;

// ---------- 安装包（全家桶：启动端 + clients\ 四客户端安装脚本） ----------
const CMD_INSTALL = [
  '@echo off',
  'chcp 65001 >nul',
  'title Workbench Launcher - Install All',
  'echo.',
  'echo  全能工作台 · 集中启动端 一键安装（含 电脑监控/剪贴板采集/电子宠物/悬浮歌词）',
  'echo  ----------------------------------------------------------------------',
  'echo  全部装到 %LOCALAPPDATA% 并设开机自启（任务栏右下角出现四方块图标）。',
  'echo  装完在托盘右键菜单里勾选启用/停用各客户端；录音转写算力不在此包（需另装）。',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cmd install',
  'echo.',
  'pause',
].join('\r\n');
const CMD_UNINSTALL = [
  '@echo off',
  'chcp 65001 >nul',
  'title Workbench Launcher - Uninstall All',
  'echo.',
  'echo  全能工作台 · 一键卸载（启动端 + 监控/剪贴板/宠物/歌词客户端）',
  'echo  ----------------------------------------------------------------',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cmd uninstall',
  'echo.',
  'pause',
].join('\r\n');
const README_TXT = '\uFEFF' + [
  '全能工作台 · 集中启动端（Windows，一键全装）',
  '',
  '【装法】双击 安装.cmd。一次性装好：启动端 + 电脑监控 + 剪贴板采集 + 电子宠物 + 悬浮歌词，',
  '全部在 %LOCALAPPDATA% 下各自目录并设开机自启，任务栏右下角出现与网页同款的四方块图标。',
  '（电子宠物需先在网页「宠物页」打开桌面宠物开关；没开时安装包自动跳过它，开起后再来下载补装。）',
  '（录音转写算力体积大，不在此包——需要时在「设置 → 启动端」页单独安装。）',
  '',
  '【托盘菜单（右键四方块图标）】',
  '  短消息通知 —— 弹出桌面通知 / 自动播放语音 两个开关；',
  '  电脑监控 · 剪贴板采集 · 电子宠物 · 悬浮歌词 —— 四个可勾选项：勾=启用（没在跑自动拉起，',
  '        崩了 45 秒内看护重拉），去勾=停用；设置一次下次开机保持。未安装的项灰色显示「未安装」；',
  '  录音转写算力 —— VibeASR 1.5B / VibeVoice 7B 是否就位、安装路径、模型容量（只读）；',
  '  连接目标 —— 当前对接的工作台地址（点击浏览器打开）。',
  '  按设计整体没有退出按钮；要撤掉请用 卸载.cmd（一键卸载启动端与四个客户端）。',
  '',
  '【消息弹窗】有新短消息时右下角弹窗；点击弹窗 = 标记已读并打开消息页；',
  '语音消息按「自动播放语音」开关自动播放。',
  '',
  '【说明】启动端只调两个只读接口：20 秒一次 GET /api/launcher/agent/poll（心跳 + 取消息），',
  '弹窗点击时 POST /api/messages/agent/read（已读回执）。四个客户端各自只调自己的只读接口，',
  '不执行任何服务端下发的代码。排查日志在各程序目录的 agent.log / monitor 日志里。',
  '',
  '【单独补装/卸载】某客户端要重装时，在网页「设置 → 启动端」的集中下载表里单独取包。',
].join('\r\n');

// baseUrl = 工作台对 Agent 可达的根地址；key=启动端全局 key；uid+nkey=下载者本人（弹他/她的消息）
// 安装包=全家桶：clients\ 内嵌监控/剪贴板/宠物/歌词四个客户端的安装脚本（与集中下载同源同 key，
// 宠物未开桌面开关时自动跳过）；opts.uninstall=true 出「卸载包」：只带 setup.ps1 + 卸载.cmd +
// 使用说明（卸载分支自含四客户端清理逻辑，不需要 clients\，要的就是个小包）。
function buildPackage(baseUrl, key, uid, nkey, opts = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const ps = '\uFEFF' + PS_TEMPLATE
    .replace(/__SERVER__/g, base)
    .replace(/__KEY__/g, key)
    .replace(/__UID__/g, String(Number(uid) || 0))
    .replace(/__NKEY__/g, nkey);
  const entries = [{ name: 'setup.ps1', data: ps }];
  if (!opts.uninstall) {
    // 懒加载路由模块取各客户端模板（懒加载避开 routes ↔ services 的加载环）
    const monitorRoutes = require('../routes/monitorRoutes');
    entries.push({ name: 'clients/monitor-setup.ps1', data: monitorRoutes.buildMonitorSetupPs(base) });
    const coreRoutes = require('../routes/core');
    entries.push({ name: 'clients/clipboard-setup.ps1', data: coreRoutes.buildClipSetupPs(base, uid) });
    const petRoutes = require('../routes/petRoutes');
    const petPs = petRoutes.buildPetSetupPs(base, uid); // 宠物页没开桌面开关 → null → 跳过（builder 不带 BOM）
    if (petPs) entries.push({ name: 'clients/desktop-pet-setup.ps1', data: '﻿' + petPs });
    const mcLyrics = require('./mcLyricsAgent');
    const font = mcLyrics.bundledFont();
    entries.push({
      name: 'clients/lyrics/setup.ps1',
      data: '\uFEFF' + mcLyrics.PS_TEMPLATE
        .replace(/__SERVER__/g, base)
        .replace(/__KEY__/g, mcLyrics.getAgentKey())
        .replace(/__FONT_FAMILY__/g, font ? font.family : 'Microsoft YaHei'),
    });
    if (font) entries.push({ name: 'clients/lyrics/font.otf', data: fs.readFileSync(font.path) });
    entries.push({ name: '安装.cmd', data: CMD_INSTALL });
  }
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
