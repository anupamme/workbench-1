// 集中启动端（v1.18.0）e2e：设置页「启动端」tab 的全部后端面。
//
// 覆盖：包下载（管理员/RFC5987 中文名/条目/BOM/CRLF）→ setup.ps1 只做 PowerShell
// Parser::ParseFile 语法级校验（**绝不执行安装分支**——本机绝不跑 setup.ps1）→
// 模板关键内容（无退出菜单项/四方块图标四笔/心跳与已读两个只读端点/代理绕过走
// WebRequest.DefaultWebProxy 而非 PS5.1 没有的 ServicePointManager 静态属性/trap 兜底/
// state.json 偏好持久化）→ 用包里抠出的 key 走 /launcher/agent/poll 全回合：
// 403/400 拦截、注册心跳、sv 状态上报白名单落库与 8KB 上限丢弃、消息复用
// （发→取→弹→已读回执走既有 /messages/agent/read→空）、错 nk 只少给消息不拦心跳、
// 在线判定（LAUNCHER_ONLINE_MS 压到 3s）、改名/删除/轮换 key、非管理员 403。
//   node scripts/e2e-launcher.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

process.env.LAUNCHER_ONLINE_MS = '3000'; // 服务端子进程经 spread(process.env) 读到

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3198;
const B = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(tmpdir(), 'wb-launcher-e2e-'));

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 起隔离服务 ----------
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* 已退 */ } });

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(B + '/api/health')).ok) return true; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200) }; } };
async function api(method, p, { token, body, headers } = {}) {
  const r = await fetch(B + '/api' + p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, j: await j(r), raw: r };
}
async function pollQ(qs) {
  const r = await fetch(B + '/api/launcher/agent/poll' + (qs ? '?' + qs : ''));
  return { status: r.status, j: await j(r) };
}

try {
  if (!(await waitUp())) throw new Error('服务器启动超时');

  // ---------- 登录 + 建一个普通用户 ----------
  const lg = await api('POST', '/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.token;
  const ADMIN_UID = lg.j.user?.id || 1;
  ok(!!T, 'A1 管理员登录', JSON.stringify(lg.j).slice(0, 120));
  const nu = await api('POST', '/users', { token: T, body: { username: 'plain1', password: 'p1234567', role: 'user', allowed_pages: ['settings'], allowed_tabs: { settings: ['launcher'] } } });
  const nuLg = await api('POST', '/auth/login', { body: { username: 'plain1', password: 'p1234567' } });
  const T2 = nuLg.j.token;
  ok(!!nu.j.id && !!T2, 'A2 普通用户创建并登录（勾了 settings.launcher tab）', JSON.stringify(nu.j) + JSON.stringify(nuLg.j).slice(0, 80));

  const a0 = await api('GET', '/launcher/agents', { token: T });
  ok(a0.status === 200 && Array.isArray(a0.j.agents) && a0.j.agents.length === 0 && a0.j.online_ms === 3000,
    'A3 设备清单空 + online_ms 透传 env 压缩值', JSON.stringify(a0.j).slice(0, 120));

  // ---------- 包下载 ----------
  const p403 = await fetch(B + '/api/launcher/agent/package');
  ok(p403.status === 401, 'B1 未登录下载 401', String(p403.status));
  const pkgRes = await fetch(B + '/api/launcher/agent/package', { headers: { Authorization: 'Bearer ' + T, Origin: B } });
  const pkgBuf = Buffer.from(await pkgRes.arrayBuffer());
  ok(pkgRes.status === 200 && pkgBuf.slice(0, 2).toString('latin1') === 'PK', 'B2 安装包下载（管理员，ZIP 魔数）', `status=${pkgRes.status} bytes=${pkgBuf.length}`);
  ok((pkgRes.headers.get('content-disposition') || '').includes(encodeURIComponent('启动端安装包.zip')), 'B3 文件名 RFC5987 中文名');
  const zipMod = await import('../server/services/zipService.js');
  const extractZip = zipMod.extractZip || zipMod.default?.extractZip;
  const by = Object.fromEntries(extractZip(pkgBuf).map((e) => [e.name, e.data]));
  ok(['setup.ps1', '安装.cmd', '卸载.cmd', '使用说明.txt'].every((n) => by[n]), 'B4 安装包四条目齐', Object.keys(by).join('|'));
  const unRes = await fetch(B + '/api/launcher/agent/package?mode=uninstall', { headers: { Authorization: 'Bearer ' + T, Origin: B } });
  const unBuf = Buffer.from(await unRes.arrayBuffer());
  const unBy = Object.fromEntries(extractZip(unBuf).map((e) => [e.name, e.data]));
  ok(unRes.status === 200 && ['setup.ps1', '卸载.cmd', '使用说明.txt'].every((n) => unBy[n]) && !unBy['安装.cmd'],
    'B5 卸载包三件套（不带 安装.cmd）', Object.keys(unBy).join('|'));

  const ps = by['setup.ps1'];
  const psText = ps.toString('utf8');
  ok(ps[0] === 0xef && ps[1] === 0xbb && ps[2] === 0xbf, 'B6 setup.ps1 带 UTF-8 BOM');
  for (const n of ['安装.cmd', '卸载.cmd']) {
    const d = by[n];
    ok(d.includes(Buffer.from('\r\n')) && !(d[0] === 0xef) && d.toString('utf8').includes('setup.ps1') && d.toString('utf8').includes('chcp 65001'),
      `B7 ${n}：CRLF、无 BOM、chcp 65001、引用 setup.ps1`);
  }
  ok(by['使用说明.txt'][0] === 0xef && by['使用说明.txt'][1] === 0xbb && by['使用说明.txt'][2] === 0xbf, 'B8 使用说明.txt 带 BOM');

  // ---------- 模板内容（用户规格的硬断言） ----------
  ok(psText.includes('[System.Net.WebRequest]::DefaultWebProxy = $null') && !psText.includes('ServicePointManager]::DefaultWebProxy'),
    'C1 代理绕过走 WebRequest.DefaultWebProxy（PS5.1 没有 ServicePointManager.DefaultWebProxy，裸赋值会炸常驻进程）');
  ok(psText.includes('trap {') && psText.includes('致命错误，代理退出'), 'C2 trap 兜底（未捕获异常写 agent.log 再退）');
  ok(!psText.includes("MenuItem('退出") && !psText.includes('MenuItem(\'关闭\')') && !psText.includes('Application::Exit') && !psText.includes('Close()'),
    'C3 没有退出/关闭菜单项与 Exit 调用（按用户规格整体不设退出）');
  ok((psText.match(/FillRectangle\(\\\$brush,/g) || psText.match(/FillRectangle\(/g) || []).length >= 4,
    'C4 四方块图标：FillRectangle 至少四笔');
  ok(psText.includes('/api/launcher/agent/poll') && psText.includes('/api/messages/agent/read'),
    'C5 只调两个只读端点（心跳 + 已读回执）');
  ok(psText.includes('launcher.ps1') && psText.includes('CurrentVersion\\Run') && psText.includes('-STA'),
    'C6 安装段：拷贝 launcher.ps1 + HKCU Run 自启 + STA（WinForms 托盘）');
  ok(psText.includes('state.json') && psText.includes('petDirty') && psText.includes('lyricsDirty'),
    'C7 偏好落 state.json、启动时强制对齐宠物/歌词子进程（设置一次下次启动保持）');
  ok(psText.includes('WorkbenchMonitor_v2') && psText.includes('WorkbenchClipboard') && psText.includes('WorkbenchDesktopPet') && psText.includes('WorkbenchLyrics'),
    'C8 探测四个既有代理的互斥锁');
  ok(psText.includes('LauncherTlsTrust'), 'C9 自签 HTTPS 用编译型 C# 证书回调（脚本块回调在 TLS 线程必炸）');

  // 占位符替换 + 凭据内嵌
  const km = /\$lKey\s*=\s*'([0-9a-f]{32})'/.exec(psText);
  const um = /\$uid\s*=\s*(\d+)/.exec(psText);
  const nm = /\$nKey\s*=\s*'([0-9a-f]{32})'/.exec(psText);
  ok(!!km && !!um && !!nm && Number(um[1]) === Number(ADMIN_UID)
    && psText.includes(`'${B}'`) && !psText.includes('__SERVER__') && !psText.includes('__KEY__') && !psText.includes('__UID__') && !psText.includes('__NKEY__'),
    'C10 占位符全替换：回连地址=下载来源、uid=下载者、key/nkey 32hex', `${B} uid=${um && um[1]}`);
  const KEY = km && km[1];
  const NKEY = nm && nm[1];

  // PowerShell 语法级校验：只 ParseFile 绝不执行（安装分支会写注册表/装自启，本机绝不跑）
  const psPath = path.join(DATA, 'setup-syntax-check.ps1');
  fs.writeFileSync(psPath, ps);
  const psChk = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${psPath.replace(/'/g, "''")}', [ref]$null, [ref]$e) | Out-Null; if ($e -and $e.Count) { $e | ForEach-Object { Write-Output ('ERR:' + $_.Message) }; exit 1 } else { Write-Output 'SYNTAX-OK'; exit 0 }`],
    { encoding: 'utf8', timeout: 60000 });
  ok(psChk.status === 0 && (psChk.stdout || '').includes('SYNTAX-OK'), 'C11 setup.ps1 PowerShell 语法检查通过（Parser::ParseFile，不执行）',
    ((psChk.stdout || '') + (psChk.stderr || '')).slice(0, 400));

  // ---------- poll 全回合 ----------
  const DEVID = 'PCe2e00000001';
  ok((await pollQ('id=' + DEVID)).status === 403, 'D1 无 key 403');
  ok((await pollQ('key=' + '0'.repeat(32) + '&id=' + DEVID)).status === 403, 'D2 错 key 403');
  ok((await pollQ('key=' + KEY + '&id=ab')).status === 400, 'D3 设备号太短 400（6-64 位约束）');

  const SV = JSON.stringify({
    notify: { on: true, popup: true, voice: false },
    monitor: { installed: true, running: true }, clipboard: { installed: true, running: false },
    pet: { installed: false, running: false, show: true }, lyrics: { installed: false, running: false, show: true },
    compute: { asr: { installed: true, path: 'D:\\LLM\\vibeasr', gb: 1.7 }, v7b: { installed: false, path: '', gb: 0 } },
    target: B,
  });
  const p1 = await pollQ(`key=${KEY}&id=${DEVID}&computer=${encodeURIComponent('测试机')}&v=1&uid=${ADMIN_UID}&nk=${NKEY}&after=0&sv=${encodeURIComponent(SV)}`);
  ok(p1.status === 200 && p1.j.ok === true && p1.j.notify_ok === true && p1.j.messages.length === 0 && p1.j.interval === 20 && p1.j.last_id === 0,
    'D4 首次 poll：注册 + 无消息 + interval 20', JSON.stringify(p1.j).slice(0, 200));

  // 发一条消息 → poll 取回 → 已读 → 空
  const sm = await api('POST', '/messages', { token: T, body: { to_user: ADMIN_UID, subject: '启动端测试', content: '你好，托盘' } });
  ok(sm.status === 200 && sm.j.count === 1, 'D5 管理员给自己发一条消息', JSON.stringify(sm.j));
  const mid = sm.j.id;
  const p2 = await pollQ(`key=${KEY}&id=${DEVID}&uid=${ADMIN_UID}&nk=${NKEY}&after=0`);
  const m0 = p2.j.messages[0];
  ok(p2.status === 200 && p2.j.messages.length === 1 && m0.id === mid && m0.subject === '启动端测试' && m0.content === '你好，托盘'
    && m0.from_name && m0.module_label && p2.j.last_id === mid,
    'D6 心跳取回未读消息（主题/正文/发件人/模块标签）', JSON.stringify(p2.j.messages).slice(0, 200));
  const p3 = await pollQ(`key=${KEY}&id=${DEVID}&uid=${ADMIN_UID}&nk=${NKEY}&after=${mid}`);
  ok(p3.j.messages.length === 0 && p3.j.last_id === mid, 'D7 after=last_id 增量：不再重复给');
  const rd = await api('POST', '/messages/agent/read', { body: { key: NKEY, uid: ADMIN_UID, id: mid } });
  const p4 = await pollQ(`key=${KEY}&id=${DEVID}&uid=${ADMIN_UID}&nk=${NKEY}&after=0`);
  ok(rd.status === 200 && p4.j.messages.length === 0, 'D8 已读回执走既有 /messages/agent/read：标完后全量也不回');

  // 错 nk：只少给消息、不拦心跳
  const p5 = await pollQ(`key=${KEY}&id=${DEVID}&uid=${ADMIN_UID}&nk=${'f'.repeat(32)}&after=0`);
  ok(p5.status === 200 && p5.j.ok === true && p5.j.notify_ok === false && p5.j.messages.length === 0,
    'D9 错 notify_key：心跳照常（ok=true）、消息为空并如实告知 notify_ok=false');

  // sv 落库 + 在线判定 + 清单
  const ag1 = await api('GET', '/launcher/agents', { token: T });
  const row = ag1.j.agents[0];
  ok(ag1.j.agents.length === 1 && row.id === DEVID && row.computer === '测试机' && row.online === true
    && row.user_name === 'admin' && row.polls >= 5
    && row.report.monitor.running === true && row.report.clipboard.running === false
    && row.report.compute.asr.gb === 1.7 && row.report.target === B,
    'E1 设备清单：computer/对接人/在线/poll 计数/sv 明细落库', JSON.stringify(row).slice(0, 300));
  const big = await pollQ(`key=${KEY}&id=${DEVID}&sv=${encodeURIComponent(JSON.stringify({ monitor: { x: 'A'.repeat(9000) } }))}`);
  const ag2 = await api('GET', '/launcher/agents', { token: T });
  ok(big.status === 200 && JSON.stringify(ag2.j.agents[0].report) === '{}',
    'E2 超肥上报整份丢弃（{}），不撑爆库');
  // 在线判定：env 压到 3s，等 3.4s 无心跳即离线
  await sleep(3400);
  const ag3 = await api('GET', '/launcher/agents', { token: T });
  ok(ag3.j.agents[0].online === false, 'E3 LAUNCHER_ONLINE_MS=3s：3.4s 无心跳判离线');

  // 改名 / 删除 / 再上线自动重登记
  const rn = await api('PUT', '/launcher/agents/' + DEVID, { token: T, body: { name: '客厅电脑' } });
  ok(rn.status === 200 && rn.j.agents[0].name === '客厅电脑', 'E4 改名生效');
  const rn2 = await api('PUT', '/launcher/agents/PC-not-exist', { token: T, body: { name: 'x' } });
  ok(rn2.status === 404, 'E5 改名不存在设备 404');
  await pollQ(`key=${KEY}&id=${DEVID}`);
  const del = await api('DELETE', '/launcher/agents/' + DEVID, { token: T });
  ok(del.status === 200 && del.j.agents.length === 0, 'E6 删除设备');
  const re = await pollQ(`key=${KEY}&id=${DEVID}`);
  ok(re.status === 200, 'E7 删除后再 poll 自动重新登记（poll 即 upsert）');

  // 轮换 key：旧 key 立即 403、新 key 可用
  const rot = await api('POST', '/launcher/agent/rotate-key', { token: T });
  const KEY2 = rot.j.key;
  ok(rot.status === 200 && /^[0-9a-f]{32}$/.test(KEY2) && KEY2 !== KEY, 'F1 轮换出全新 32hex key');
  ok((await pollQ(`key=${KEY}&id=${DEVID}`)).status === 403, 'F2 旧 key 立即 403（设备失联，重装即恢复）');
  const p6 = await pollQ(`key=${KEY2}&id=${DEVID}`);
  ok(p6.status === 200 && p6.j.ok === true, 'F3 新 key 心跳正常');

  // ---------- 非管理员闸 ----------
  const g2 = await api('GET', '/launcher/agents', { token: T2 });
  ok(g2.status === 403, 'G1 普通用户看设备清单 403（路由内限管理员）', String(g2.status));
  const pk2 = await fetch(B + '/api/launcher/agent/package', { headers: { Authorization: 'Bearer ' + T2 } });
  ok(pk2.status === 403, 'G2 普通用户下载安装包 403');
  const rot2 = await api('POST', '/launcher/agent/rotate-key', { token: T2 });
  ok(rot2.status === 403, 'G3 普通用户轮换 key 403');
} catch (e) {
  ok(false, '检查跑完（异常中断算失败）', e && (e.stack || e.message));
} finally {
  try { srv.kill('SIGKILL'); } catch { /* 已退 */ }
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); break; } catch { /* 句柄未释放 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  setTimeout(() => process.exit(failed ? 1 : 0), 300).unref();
}
console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
