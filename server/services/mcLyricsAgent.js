// 悬浮歌词代理后端（v1.17.0）：桌面歌词脚本的支持层——key 管理 / 设备登记 / 正在播放会话 /
// poll 载荷 / 安装包打包（setup.ps1 + 字体，WPF 浮窗，PowerShell 5.1）。
// 凭证照电脑监控/剪贴板代理的「key 即凭证」模式：设备不持有用户 token，只持有
// settings.mc_agent_key（32hex，管理员可轮换）。poll 是唯一免登录端点（index.js EXEMPT
// 精确匹配 /mc/agent/poll），注册/心跳/配置下发/正在播放全在这一条 GET 里，agent 两秒一次。
// 正在播放是进程内单份、后写覆盖先写（15 秒没人续报即视为停了）——全家场景只有一套音响在响，
// 谁最后上报谁生效；浏览器侧由 musicState.js 节流上报（POST /mc/nowplaying，任意登录用户）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const { fetchLyrics } = require('./mcService');
const { buildZip } = require('./zipService');

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/; // agent 生成 PC+12hex；宽一点容忍手写

// ---------- 代理 key（settings.mc_agent_key，32hex；首次需要时生成） ----------
function getAgentKey() {
  let k = String(getSetting(db, 'mc_agent_key', '') || '');
  if (!/^[0-9a-f]{32}$/.test(k)) {
    k = crypto.randomBytes(16).toString('hex');
    setSetting(db, 'mc_agent_key', k);
  }
  return k;
}
// 轮换：老设备下一轮 poll 立刻 403，管理员再发一次安装包即可（包里嵌的是新 key）
function rotateAgentKey() {
  const k = crypto.randomBytes(16).toString('hex');
  setSetting(db, 'mc_agent_key', k);
  return k;
}
function checkAgentKey(key) {
  return typeof key === 'string' && /^[0-9a-f]{32}$/.test(key)
    && key === String(getSetting(db, 'mc_agent_key', '') || '');
}

// ---------- 设备登记（mc_lyrics_agents，主库）：poll 即 upsert ----------
function ensureAgent(id, computer, ver, ip) {
  const now = Date.now();
  const comp = String(computer || '').slice(0, 60);
  const v = String(ver || '').slice(0, 20);
  const ipS = String(ip || '').slice(0, 64);
  if (db.prepare('SELECT 1 FROM mc_lyrics_agents WHERE id=?').get(id)) {
    db.prepare(`UPDATE mc_lyrics_agents SET last_seen=?, polls=polls+1,
      computer=COALESCE(NULLIF(?,''), computer), agent_version=COALESCE(NULLIF(?,''), agent_version), ip=? WHERE id=?`)
      .run(now, comp, v, ipS, id);
  } else {
    db.prepare(`INSERT INTO mc_lyrics_agents(id, name, computer, agent_version, ip, first_seen, last_seen, polls)
      VALUES(?,?,?,?,?,?,?,1)`).run(id, '', comp, v, ipS, now, now);
  }
  return db.prepare('SELECT * FROM mc_lyrics_agents WHERE id=?').get(id);
}
const ONLINE_MS = 15000; // agent 2s 一 poll，15s 没来就算离线
function listAgents() {
  const now = Date.now();
  return db.prepare('SELECT * FROM mc_lyrics_agents ORDER BY last_seen DESC').all()
    .map((r) => ({ ...r, show: !!r.show, online: now - (r.last_seen || 0) < ONLINE_MS }));
}
function updateAgent(id, patch) {
  const row = db.prepare('SELECT * FROM mc_lyrics_agents WHERE id=?').get(id);
  if (!row) return { ok: false, error: '设备不存在' };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
    db.prepare('UPDATE mc_lyrics_agents SET name=? WHERE id=?').run(String(patch.name || '').slice(0, 40), id);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'show')) {
    db.prepare('UPDATE mc_lyrics_agents SET show=? WHERE id=?').run(patch.show ? 1 : 0, id);
  }
  return { ok: true };
}
function deleteAgent(id) {
  const r = db.prepare('DELETE FROM mc_lyrics_agents WHERE id=?').run(id);
  return { ok: !!r.changes };
}

// ---------- 桌面歌词设置（全局开关 + 字体，settings 表；poll 下发给全部设备） ----------
function deskOn() { return String(getSetting(db, 'mc_desk_on', '1') || '1') !== '0'; }
function setDeskOn(v) { setSetting(db, 'mc_desk_on', v ? '1' : '0'); }
function fontFamilySetting() { return String(getSetting(db, 'mc_font_family', '') || '').trim().slice(0, 60); }
function setFontFamily(v) { setSetting(db, 'mc_font_family', String(v || '').trim().slice(0, 60)); }
function fontSizeSetting() {
  const n = parseInt(getSetting(db, 'mc_font_size', '36'), 10);
  return Number.isFinite(n) ? Math.min(96, Math.max(12, n)) : 36;
}
function setFontSize(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return;
  setSetting(db, 'mc_font_size', String(Math.min(96, Math.max(12, n))));
}
// v1.18.5 文字透明度（0.15~1；作用于整个浮窗=文字+阴影，背景本来透明不受影响）
function fontOpacitySetting() {
  const n = parseFloat(getSetting(db, 'mc_font_opacity', '1'));
  return Number.isFinite(n) ? Math.min(1, Math.max(0.15, Math.round(n * 100) / 100)) : 1;
}
function setFontOpacity(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return;
  setSetting(db, 'mc_font_opacity', String(Math.min(1, Math.max(0.15, Math.round(n * 100) / 100))));
}
// 空串 = 用安装包自带的思源黑体（agent 本地解析 file:///…font.otf#家族名）；其余 = 系统字体名
const FONT_OPTIONS = [
  { v: '', n: '内置思源黑体（安装包自带）' },
  { v: '微软雅黑', n: '微软雅黑（系统）' },
  { v: '黑体', n: '黑体（系统）' },
  { v: '宋体', n: '宋体（系统）' },
  { v: '楷体', n: '楷体（系统）' },
  { v: '仿宋', n: '仿宋（系统）' },
];

// ---------- 正在播放会话（进程内单份；15s 龄化 = 停止） ----------
let nowPlaying = null;
function setNowPlaying(user, b) {
  const id = parseInt(b && b.id, 10);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'bad id' };
  nowPlaying = {
    track_id: id,
    pos: Math.max(0, +b.pos || 0),
    playing: !!b.playing,
    user: String(user || '').slice(0, 40),
    updated_at: Date.now(),
  };
  return { ok: true };
}
function getNowPlaying() {
  if (!nowPlaying || Date.now() - nowPlaying.updated_at > 15000) return null;
  return nowPlaying;
}

// ---------- 歌词行（服务端解析好再下发，agent 只做插值找行） ----------
// LRC：一行多时间标签的展开成多行；非 LRC 文本按歌曲时长均匀铺开（agent 拿到的永远是 [{t,text}]）
function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!times.length) continue;
    const txt = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of times) {
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseFloat('0.' + m[3]) : 0);
      out.push({ t, text: txt });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
function linesForAgent(text, synced, durSec) {
  if (!text) return [];
  if (synced) {
    const lines = parseLrc(text);
    if (lines.length) return lines.slice(0, 400);
  }
  const raw = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 400);
  if (!raw.length) return [];
  const dur = durSec && durSec > 5 ? durSec : raw.length * 4; // 没时长就按每行 4 秒铺
  const step = dur / raw.length;
  return raw.map((t, i) => ({ t: Math.round(i * step * 100) / 100, text: t }));
}

// ---------- poll 载荷：配置 + 正在播放（含歌词行）。agent 2s 一次全靠它 ----------
function pollPayload(agent) {
  const np = getNowPlaying();
  let now = null;
  if (np) {
    const t = db.prepare('SELECT id,title,artist,album,duration_ms,lyrics,lyrics_synced,lyrics_ok FROM mc_tracks WHERE id=?').get(np.track_id);
    if (t) {
      // 没缓存歌词：踢一次异步抓取，本轮先空着，下一轮 poll（2 秒后）大概率就有了
      if (!t.lyrics_ok) { fetchLyrics(t).catch(() => { }); }
      const durSec = t.duration_ms ? t.duration_ms / 1000 : 0;
      now = {
        playing: !!np.playing,
        track_id: t.id,
        title: t.title || '',
        artist: t.artist || '',
        pos: Math.round(np.pos * 10) / 10,
        dur: Math.round(durSec),
        updated_at: np.updated_at,
        synced: !!(t.lyrics_synced && t.lyrics),
        lines: linesForAgent(t.lyrics, t.lyrics_synced, durSec),
      };
    }
  }
  return {
    ok: true,
    device: { id: agent.id, name: agent.name || agent.computer || agent.id, show: !!agent.show },
    global_on: deskOn(),
    font: { family: fontFamilySetting(), size: fontSizeSetting(), opacity: fontOpacitySetting() },
    now,
    server_time: Date.now(),
  };
}

// ---------- 桌面歌词代理脚本（PowerShell 5.1 + WPF，Windows） ----------
// 结构：后台 runspace 2s 轮询 poll 写进同步哈希表；主 runspace WPF 无边框置顶浮窗 +
// 100ms DispatcherTimer 插值（pos = 上次 pos + 本地流逝）做逐字变红卡拉 OK。
// 写法约束：PS 里不用反引号、不用 ${} 变量花括号语法——本模板要嵌进 JS String.raw 字面量。
const PS_TEMPLATE = String.raw`# =====================================================================
#  全能工作台 · 悬浮桌面歌词代理 v1（Windows PowerShell 5.1 + WPF）
#  - 无参数或 run   ：常驻运行（开机自启拉起的就是这个）
#  - -Cmd install   ：安装到 %LOCALAPPDATA%\WorkbenchLyrics + 设开机自启 + 启动
#  - -Cmd uninstall ：停进程、删自启、删目录
#  只读代理：只调 GET /api/mc/agent/poll（2 秒一次），不执行任何服务端下发的代码。
#  退出方式：右键歌词浮窗 → 退出悬浮歌词。
# =====================================================================
param([string]$Cmd = '')
$ErrorActionPreference = 'Stop'
$server  = '__SERVER__'
$aKey    = '__KEY__'
$fontFam = '__FONT_FAMILY__'
$AppName = 'WorkbenchLyrics'
$InstDir = Join-Path $env:LOCALAPPDATA $AppName
$LogFile = Join-Path $InstDir 'agent.log'

# ---------- 安装 ----------
if ($Cmd -eq 'install') {
  New-Item -ItemType Directory -Force -Path $InstDir | Out-Null
  # 重新安装 = 明确要装：摘掉「永久退出」停用标记（v1.18.5）
  Remove-Item -LiteralPath (Join-Path $InstDir 'disabled.flag') -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $InstDir 'setup.ps1') -Force
  $fontSrc = Join-Path (Split-Path $PSCommandPath -Parent) 'font.otf'
  if (Test-Path -LiteralPath $fontSrc) { Copy-Item -LiteralPath $fontSrc -Destination (Join-Path $InstDir 'font.otf') -Force }
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $AppName -Value ('powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstDir 'setup.ps1') + '"')
  Write-Host ('已安装到 ' + $InstDir)
  Write-Host '已设开机自启，悬浮歌词代理正在后台启动（播放音乐时浮窗出现在桌面底部）。'
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstDir 'setup.ps1') + '"')
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
  Write-Host '已卸载：开机自启已移除、程序目录已删除。'
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

# 单实例锁：已有常驻实例就安静退出（AbandonedMutex = 上个进程被强杀，锁已归我）
# 注意拼接必须自带括号：New-Object 参数模式里逗号后的裸 + 会被拆成独立参数，撞上
# Mutex(bool,string,out bool) 重载直接炸进程——v1.17.0 起悬浮歌词在任何真机上秒死的根因
$mtx = New-Object System.Threading.Mutex($false, ('Global\' + $AppName))
$got = $false
try { $got = $mtx.WaitOne(0) } catch { $got = $true }
if (-not $got) { exit 0 }

# 「永久退出」停用标记（v1.18.5）：右键永久退出落下、托盘勾选重开时由启动端摘掉。
# 标记在位 = 用户明确不要：开机自启/看护再拉起时安静离开（不写日志——老启动端每 45s
# 重拉一次，逐次落日志会把 agent.log 刷成复读机）
$FlagFile = Join-Path $InstDir 'disabled.flag'
if (Test-Path -LiteralPath $FlagFile) { exit 0 }

# TLS：工作台可能挂在自签 HTTPS 后面（信任证书），且不走系统代理（代理会吞 2s 轮询）
try {
  Add-Type -TypeDefinition 'using System.Net;using System.Security.Cryptography.X509Certificates;
public class WbTrustPolicy : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}' -ErrorAction SilentlyContinue
} catch { }
try { [System.Net.ServicePointManager]::CertificatePolicy = New-Object WbTrustPolicy } catch { }
try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 } catch { }
# 注意：.NET Framework 的 ServicePointManager 没有 DefaultWebProxy 静态属性——裸赋值在
# ErrorActionPreference=Stop 下抛 PropertyAssignmentException 直接炸死常驻进程（安装成功但
# 0 台设备的根因）。绕系统代理的正确写法是 WebRequest.DefaultWebProxy（PS5.1 实测可赋值）。
try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch { }

# 设备 ID：PC + SHA256(机器GUID|计算机名) 前 12 位（登记进工作台「已安装电脑」清单）
$deviceId = 'PC-unknown'
try {
  $mg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
} catch { $mg = 'no-guid' }
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hex = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($mg + '|' + $env:COMPUTERNAME))) -replace '-','').ToLower()
  $deviceId = 'PC' + $hex.Substring(0, 12)
} catch { }

# 共享状态（两个 runspace 之间靠它传话）
$st = [hashtable]::Synchronized(@{})
$st.stop = $false
$st.now = $null
$st.font = $null
$st.globalOn = $false
$st.devShow = $false
$st.recvAt = [DateTime]::MinValue
$st.id = $deviceId
$st.server = $server
$st.key = $aKey
$st.logfile = $LogFile

# 后台 runspace：2 秒一次 poll（注册/心跳/配置/正在播放全在这一条 GET）
$pollScript = @'
$ErrorActionPreference = 'Stop'
$url = $st.server.TrimEnd('/') + '/api/mc/agent/poll?id=' + $st.id + '&key=' + $st.key + '&computer=' + [uri]::EscapeDataString($env:COMPUTERNAME) + '&v=1'
$fail = 0
$lastErr = ''
while (-not $st.stop) {
  try {
    $r = Invoke-RestMethod -Uri $url -TimeoutSec 8
    $st.now = $r.now
    $st.font = $r.font
    $st.globalOn = [bool]$r.global_on
    if ($r.device) { $st.devShow = [bool]$r.device.show } else { $st.devShow = $true }
    $st.recvAt = [DateTime]::Now
    if ($fail -gt 0 -and $st.logfile) {
      try { Add-Content -LiteralPath $st.logfile -Value ((Get-Date -Format 'MM-dd HH:mm:ss') + ' poll 恢复（此前连续失败 ' + $fail + ' 次）') -Encoding UTF8 } catch { }
    }
    $fail = 0
    $lastErr = ''
  } catch {
    $fail++
    $msg = [string]$_.Exception.Message
    # 失败要留痕：头 3 次、错误内容变化、每 15 次（约 30s）各记一条，恢复时记一条——别再空 catch 吞掉
    if ($st.logfile -and ($fail -le 3 -or $msg -ne $lastErr -or ($fail % 15) -eq 0)) {
      try { Add-Content -LiteralPath $st.logfile -Value ((Get-Date -Format 'MM-dd HH:mm:ss') + ' poll 失败 x' + $fail + '：' + $msg) -Encoding UTF8 } catch { }
      $lastErr = $msg
    }
  }
  Start-Sleep -Seconds 2
}
'@
$pollRs = [runspacefactory]::CreateRunspace()
$pollRs.Open()
$pollRs.SessionStateProxy.SetVariable('st', $st)
$pollPs = [powershell]::Create()
$pollPs.Runspace = $pollRs
$null = $pollPs.AddScript($pollScript).BeginInvoke()

# 主 runspace：WPF 无边框置顶浮窗（白字灰影，唱到的字变红）
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$work = [System.Windows.SystemParameters]::WorkArea
$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.ShowActivated = $false
$win.ResizeMode = 'NoResize'
$win.SizeToContent = 'WidthAndHeight'
$win.MaxWidth = [math]::Floor($work.Width * 0.86)
# 位置（v1.18.5 多屏）：优先恢复上次拖放记忆 pos.json（拖到扩展屏也回扩展屏）；
# 没有/超出当前虚拟屏幕范围才回主屏底部居中。userMoved=用户钉过位置，tick 不再自动居中
$script:posFile = Join-Path $InstDir 'pos.json'
$script:userMoved = $false
$win.Top = [math]::Floor($work.Bottom - 150)
$win.Left = [math]::Floor($work.Left + ($work.Width - 500) / 2)
try {
  if (Test-Path -LiteralPath $script:posFile) {
    $pp = Get-Content -LiteralPath $script:posFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $pp.x -and $null -ne $pp.y) {
      $vsL = [System.Windows.SystemParameters]::VirtualScreenLeft
      $vsT = [System.Windows.SystemParameters]::VirtualScreenTop
      $vsR = $vsL + [System.Windows.SystemParameters]::VirtualScreenWidth
      $vsB = $vsT + [System.Windows.SystemParameters]::VirtualScreenHeight
      if ([double]$pp.x -ge ($vsL - 200) -and [double]$pp.x -le ($vsR - 60) -and [double]$pp.y -ge ($vsT - 200) -and [double]$pp.y -le ($vsB - 20)) {
        $win.Left = [double]$pp.x
        $win.Top = [double]$pp.y
        $script:userMoved = $true
      }
    }
  }
} catch { }

$tb = New-Object System.Windows.Controls.TextBlock
$tb.TextWrapping = 'Wrap'
$tb.TextAlignment = 'Center'
$tb.FontWeight = 'Bold'
$tb.Padding = New-Object System.Windows.Thickness(20, 8, 20, 10)
$sh = New-Object System.Windows.Media.Effects.DropShadowEffect
$sh.Color = [System.Windows.Media.Color]::FromArgb(200, 90, 90, 90)
$sh.BlurRadius = 6
$sh.ShadowDepth = 2
$tb.Effect = $sh
# 渐变卡拉OK（v1.18.5）：一支水平线性渐变笔刷当蒙版，红白之间留一段过渡带，
# 每 100ms 挪两个 GradientStop 的 Offset——变色从左往右柔和扫过去，
# 替代旧版两段 Run 的硬切（红白之间一个字 instant 翻面，太生硬）
$run = New-Object System.Windows.Documents.Run('')
$brush = New-Object System.Windows.Media.LinearGradientBrush
$brush.StartPoint = New-Object System.Windows.Point(0, 0.5)
$brush.EndPoint = New-Object System.Windows.Point(1, 0.5)
$redC = [System.Windows.Media.Color]::FromArgb(255, 255, 64, 64)
$whtC = [System.Windows.Media.Colors]::White
$gsA = New-Object System.Windows.Media.GradientStop($redC, 0.0)
$gsB = New-Object System.Windows.Media.GradientStop($redC, 0.0)
$gsC = New-Object System.Windows.Media.GradientStop($whtC, 0.0)
$gsD = New-Object System.Windows.Media.GradientStop($whtC, 1.0)
$null = $brush.GradientStops.Add($gsA)
$null = $brush.GradientStops.Add($gsB)
$null = $brush.GradientStops.Add($gsC)
$null = $brush.GradientStops.Add($gsD)
$tb.Foreground = $brush
$tb.Inlines.Add($run)
$win.Content = $tb

# 右键菜单（v1.18.5 两项）：本次退出=只退进程（开机自启还在，下次开机自动回来）；
# 永久退出=落 disabled.flag + 摘自己的开机自启（之后由启动端托盘勾选「悬浮歌词」重开）
$menu = New-Object System.Windows.Controls.ContextMenu
$miOff = New-Object System.Windows.Controls.MenuItem
$miOff.Header = '本次退出（下次开机自动回来）'
$null = $miOff.Add_Click({ $st.stop = $true; $win.Close() })
$miQuit = New-Object System.Windows.Controls.MenuItem
$miQuit.Header = '永久退出（托盘勾选「悬浮歌词」可重开）'
$null = $miQuit.Add_Click({
  try { Set-Content -LiteralPath $script:FlagFile -Value 'off' -Encoding UTF8 } catch { }
  try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $script:AppName -ErrorAction SilentlyContinue } catch { }
  try { Log '永久退出：已落停用标记并摘除开机自启（启动端托盘勾选「悬浮歌词」可重开）' } catch { }
  $st.stop = $true
  $win.Close()
})
$null = $menu.Items.Add($miOff)
$null = $menu.Items.Add($miQuit)
$tb.ContextMenu = $menu

# 左键拖动（v1.18.5）：拖完记 pos.json——重启/升级都回这个位置，tick 也不再自动居中
$null = $win.Add_MouseLeftButtonDown({
  try {
    $win.DragMove()
    $script:userMoved = $true
    try {
      $po = @{ x = [math]::Floor($win.Left); y = [math]::Floor($win.Top) }
      Set-Content -LiteralPath $script:posFile -Value (ConvertTo-Json $po -Compress) -Encoding UTF8
    } catch { }
  } catch { }
})

$script:lastText = ''
$script:lastFontSig = ''
$script:fontFile = Join-Path $InstDir 'font.otf'
$script:haveFont = Test-Path -LiteralPath $script:fontFile

# 100ms 一拍：可见性判定 + 位置插值 + 找行 + 逐字变红
function Update-Tick {
  $visible = $false
  $n = $st.now
  if ($null -ne $n -and $st.recvAt -gt [DateTime]::MinValue) {
    $age = ([DateTime]::Now - $st.recvAt).TotalSeconds
    if ($age -le 15 -and $n.playing -and $st.globalOn -and $st.devShow) { $visible = $true }
  }
  if (-not $visible) { if ($script:win.IsVisible) { $script:win.Hide() }; return }
  # 字体/字号/透明度（设置页改了，下一次 poll 生效）
  $fam = ''
  $size = 36
  $opa = 1.0
  if ($null -ne $st.font) {
    $fam = [string]$st.font.family
    $size = [int]$st.font.size
    if ($null -ne $st.font.opacity) { $opa = [double]$st.font.opacity }
  }
  if ($opa -lt 0.15) { $opa = 0.15 }
  if ($opa -gt 1) { $opa = 1 }
  if (-not $fam) {
    if ($script:haveFont) { $fam = 'file:///' + ($script:fontFile -replace '\\','/') + '#' + $script:fontFam }
    else { $fam = '微软雅黑' }
  }
  $sig = $fam + '|' + $size + '|' + $opa
  if ($sig -ne $script:lastFontSig) {
    $script:tb.FontFamily = New-Object System.Windows.Media.FontFamily($fam)
    $script:tb.FontSize = $size
    $script:win.Opacity = $opa
    $script:lastFontSig = $sig
  }
  # 播放位置插值：上次 poll 的 pos + 本地流逝
  $pos = [double]$n.pos + ([DateTime]::Now - $st.recvAt).TotalSeconds
  $lines = @()
  if ($n.lines) { $lines = @($n.lines) }
  $picked = $null
  $pickedT = 0.0
  $nextT = 0.0
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ([double]$lines[$i].t -le ($pos + 0.2)) {
      $picked = $lines[$i]
      $pickedT = [double]$lines[$i].t
      if ($i + 1 -lt $lines.Count) { $nextT = [double]$lines[$i + 1].t } else { $nextT = $pickedT + 4 }
    } else { break }
  }
  if ($null -eq $picked -or -not ([string]$picked.text)) { if ($script:win.IsVisible) { $script:win.Hide() }; return }
  $text = [string]$picked.text
  $span = $nextT - $pickedT
  if ($span -le 0.1) { $span = 0.1 }
  $frac = ($pos - $pickedT) / $span
  if ($frac -lt 0) { $frac = 0 }
  if ($frac -gt 1) { $frac = 1 }
  if ($text -ne $script:lastText) { $script:run.Text = $text; $script:lastText = $text }
  # 渐变蒙版推进：过渡带占整行 8%，gsB=红侧边缘、gsC=白侧边缘，跟着演唱进度扫
  $band = 0.08
  $script:gsB.Offset = [math]::Max(0.0, ([double]$frac - $band))
  $script:gsC.Offset = [math]::Min(1.0, [double]$frac)
  if (-not $script:win.IsVisible) { $script:win.Show() }
  # 底部居中（内容换行变高变宽后重新居中）——只在用户没拖过时做；
  # 拖过 = 用户钉了位置（可能在扩展屏），别把窗口拉回主屏
  if (-not $script:userMoved) {
    $script:win.Left = [math]::Floor($script:work.Left + (($script:work.Width - $script:win.ActualWidth) / 2))
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$null = $timer.Add_Tick({ Update-Tick })
$timer.Start()
$null = $win.Add_Closed({
  $script:st.stop = $true
  try { $script:timer.Stop() } catch { }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown([System.Windows.Threading.DispatcherPriority]::Background)
})
Log ('启动：设备 ' + $deviceId + ' → ' + $server + '，字体包 ' + $(if ($script:haveFont) { '有' } else { '无（回退微软雅黑）' }))
try { [System.Windows.Threading.Dispatcher]::Run() } finally {
  $st.stop = $true
  try { $timer.Stop() } catch { }
  try { $pollPs.Dispose() } catch { }
  try { $pollRs.Dispose() } catch { }
  try { $mtx.ReleaseMutex() } catch { }
  Log '已退出'
}
`;

// ---------- 安装包 ----------
// 字体随包分发（SIL OFL 1.1，可自由再分发）：server/assets/fonts/ 下的思源黑体；
// 没有该文件时照样出包（agent 回退系统微软雅黑），设置页 font_included 如实告知。
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'SourceHanSansCN-Regular.otf');
function bundledFont() {
  try {
    const st = fs.statSync(FONT_PATH);
    if (st.isFile() && st.size > 200000) return { family: 'Source Han Sans CN', path: FONT_PATH, name: 'font.otf', bytes: st.size };
  } catch { }
  return null;
}
const CMD_INSTALL = [
  '@echo off',
  'chcp 65001 >nul',
  'title Workbench Lyrics - Install',
  'echo.',
  'echo  全能工作台 · 悬浮桌面歌词 安装',
  'echo  --------------------------------',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cmd install',
  'echo.',
  'pause',
].join('\r\n');
const CMD_UNINSTALL = [
  '@echo off',
  'chcp 65001 >nul',
  'title Workbench Lyrics - Uninstall',
  'echo.',
  'echo  全能工作台 · 悬浮桌面歌词 卸载',
  'echo  --------------------------------',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Cmd uninstall',
  'echo.',
  'pause',
].join('\r\n');
const README_TXT = '\uFEFF' + [
  '全能工作台 · 悬浮桌面歌词（Windows）',
  '',
  '【装法】双击 安装.cmd。装到 %LOCALAPPDATA%\\WorkbenchLyrics，并设了开机自启。',
  '',
  '【用法】在工作台网页里播放音乐即可：桌面底部浮窗只显示正在播放的一句，',
  '唱到的字从左向右渐变变红（蒙版式柔和过渡），其余白色带灰阴影。',
  '播放暂停/停止、或网页关掉 15 秒后浮窗自动消失。',
  '浮窗可以按住左键拖到任意屏幕（包括扩展屏），松手即记住位置，重启后回到原地。',
  '右键菜单两项：「本次退出」（只退这一次，下次开机自动回来）与',
  '「永久退出」（停用 + 摘开机自启；之后在启动端托盘勾选「悬浮歌词」可重新打开，',
  '没装启动端的电脑重新运行一次安装.cmd 也可以）。',
  '',
  '【控制】工作台「人工智能 → 音乐 → 设置 → 悬浮歌词」里：总开关（关掉全部设备不显示）、',
  '每台设备的单独开关、字体字号与文字透明度。改完约 2 秒生效（代理两秒一次心跳）。',
  '',
  '【卸载】双击 卸载.cmd（移除开机自启并删除程序目录）。',
  '',
  '【字体】font.otf 是思源黑体（Source Han Sans，Adobe 出品，SIL Open Font License 1.1，',
  'https://github.com/adobe-fonts/source-han-sans —— 许可允许随包再分发）。',
  '若本包没有 font.otf，浮窗用系统微软雅黑。',
  '',
  '【原理】setup.ps1 只调一个只读接口 GET /api/mc/agent/poll（两秒一次），',
  '取回：配置开关、字体设置、正在播放与歌词行。不执行任何服务端下发的代码。',
  '身份是安装包里内嵌的设备 key + 本机机器码派生的设备号，与你的工作台账号无关。',
].join('\r\n');

// baseUrl = 工作台对 Agent 可达的根地址（如 https://cc.in1912.cc）；key 嵌进脚本（key 即凭证）
// opts.uninstall=true 出「卸载包」：setup.ps1 + 卸载.cmd + 使用说明（卸载走 setup.ps1 -Cmd uninstall，
// 所以脚本必须带；不带 8.4MB 字体与安装.cmd，卸载场景要的就是个小包）
function buildPackage(baseUrl, key, opts = {}) {
  const font = bundledFont();
  const ps = '\uFEFF' + PS_TEMPLATE
    .replace(/__SERVER__/g, String(baseUrl || '').trim().replace(/\/+$/, ''))
    .replace(/__KEY__/g, key)
    .replace(/__FONT_FAMILY__/g, font ? font.family : 'Microsoft YaHei');
  const entries = [{ name: 'setup.ps1', data: ps }];
  if (!opts.uninstall) {
    if (font) entries.push({ name: font.name, data: fs.readFileSync(font.path) });
    entries.push({ name: '安装.cmd', data: CMD_INSTALL });
  }
  entries.push({ name: '卸载.cmd', data: CMD_UNINSTALL });
  entries.push({ name: '使用说明.txt', data: README_TXT });
  return buildZip(entries);
}

module.exports = {
  DEVICE_ID_RE,
  getAgentKey, rotateAgentKey, checkAgentKey,
  ensureAgent, listAgents, updateAgent, deleteAgent,
  deskOn, setDeskOn, fontFamilySetting, setFontFamily, fontSizeSetting, setFontSize, fontOpacitySetting, setFontOpacity, FONT_OPTIONS,
  setNowPlaying, getNowPlaying, parseLrc, linesForAgent, pollPayload,
  PS_TEMPLATE, bundledFont, buildPackage,
};
