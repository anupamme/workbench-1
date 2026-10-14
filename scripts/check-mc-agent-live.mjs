// check-mc-agent-live：悬浮歌词代理「活体」回归（v1.18.4 新增）。
//   背景：v1.17.0 起 PS_TEMPLATE 互斥体行 `New-Object Mutex($false, 'Global\' + $AppName)`
//   在参数模式被逗号拆成 3 个参数砸中 (bool,string,out bool) 重载，代理在任何真机上秒退
//   （exit 1、无日志）——Parser::ParseFile 只查语法永远抓不到这类「运行时参数绑定」错误。
//   本检查分两段：
//   ① 静态：四个客户端 PS 模板里 New-Object 参数表内不允许出现「逗号 + 裸 + 拼接」；
//   ② 活体：渲染模板 → 隔离 LOCALAPPDATA + 测试专用 AppName → 真跑 powershell 7 秒 →
//      断言进程存活、轮询打到桩服务器、agent.log 写出「启动」行（= WPF 初始化也过了）。
//   node scripts/check-mc-agent-live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const mcAgent = require_(path.join(ROOT, 'server/services/mcLyricsAgent.js'));

let pass = 0, fail = 0;
const ok = (c, n, e) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  <<< ' + String(e || '')}`); };

// ---------- ① 静态：New-Object 参数表内「逗号后裸 +」= 参数被拆散的高危形态 ----------
// 只匹配无嵌套括号的参数表：`($false, 'Global\' + $AppName)` 命中；
// 已加括号的 `($false, ('Global\' + $AppName))` 因内容含嵌套括号不命中。
const ARG_SPLIT_BUG = /New-Object\s+[\w.]+\([^()]*,[^()]*\+/g;
const templates = { 'mcLyricsAgent': String(mcAgent.PS_TEMPLATE) };
try {
  const monitorRoutes = require_(path.join(ROOT, 'server/routes/monitorRoutes.js'));
  templates.monitor = String(monitorRoutes.buildMonitorSetupPs('http://stub'));
} catch (e) { console.log('  （monitor 模板取不到，跳过）'); }
try {
  const coreRoutes = require_(path.join(ROOT, 'server/routes/core.js'));
  templates.clipboard = String(coreRoutes.buildClipSetupPs('http://stub', 1));
} catch (e) { console.log('  （clipboard 模板取不到，跳过）'); }
try {
  const petRoutes = require_(path.join(ROOT, 'server/routes/petRoutes.js'));
  const petPs = petRoutes.buildPetSetupPs('http://stub', 1);
  if (petPs) templates.pet = String(petPs);
} catch (e) { console.log('  （pet 模板取不到，跳过）'); }
for (const [name, src] of Object.entries(templates)) {
  const hits = src.match(ARG_SPLIT_BUG) || [];
  ok(hits.length === 0, `① ${name} 模板无 New-Object 参数拆散形态`, hits.join(' | '));
}
ok(templates.mcLyricsAgent.includes("New-Object System.Threading.Mutex($false, ('Global\\' + $AppName))"),
  '① 歌词模板互斥体行已带括号（v1.18.4 修复形态）');

// ---------- ② 活体：隔离环境真跑 7 秒 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wblyr-live-'));
const APP_TEST = 'WbLyrLiveTest'; // 专用 AppName：InstDir/互斥体都不与真实安装相撞
const KEY = 'a'.repeat(32);

// 桩服务器：/api/mc/agent/poll 按 agent 合同回包（now=null → 浮窗保持隐藏）
const polls = [];
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/api/mc/agent/poll') {
    polls.push(Object.fromEntries(u.searchParams.entries()));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ now: null, font: null, global_on: false, device: null, interval: 2 }));
  } else { res.statusCode = 404; res.end('{}'); }
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const port = stub.address().port;

const ps = '﻿' + mcAgent.PS_TEMPLATE
  .replace(/__SERVER__/g, `http://127.0.0.1:${port}`)
  .replace(/__KEY__/g, KEY)
  .replace(/__FONT_FAMILY__/g, 'Microsoft YaHei')
  .replace("$AppName = 'WorkbenchLyrics'", `$AppName = '${APP_TEST}'`);
const ps1 = path.join(tmp, 'setup.ps1');
fs.writeFileSync(ps1, ps, 'utf8');

const child = spawn('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1],
  { env: { ...process.env, LOCALAPPDATA: tmp }, stdio: 'ignore', windowsHide: true });

const t0 = Date.now();
await new Promise((r) => setTimeout(r, 7000));
const exited = child.exitCode !== null;
const logPath = path.join(tmp, APP_TEST, 'agent.log');
let logTxt = '';
try { logTxt = fs.readFileSync(logPath, 'utf8'); } catch { }

ok(!exited, `② 代理 7 秒后仍存活（v1.17.0 老毛病是 1 秒内 exit 1）`, `exitCode=${child.exitCode}，存活 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(polls.length >= 2, `② 轮询打到桩服务器 ≥2 次（2s 一轮，实际 ${polls.length}）`, JSON.stringify(polls.length));
ok(polls.every((p) => p.key === KEY && /^PC[0-9a-f]{12}$/.test(p.id || '')),
  '② poll 带正确 key 与 PC+12hex 设备号', JSON.stringify(polls[0] || null).slice(0, 120));
ok(logTxt.includes('启动：设备'), '② agent.log 写出「启动：设备」行（WPF 初始化通过）', logTxt.slice(0, 200));

// ---------- 收尾：杀进程、删临时目录 ----------
try { child.kill(); } catch { }
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { }
stub.close();
await new Promise((r) => setTimeout(r, 400));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }

console.log(`\n${fail === 0 ? '全绿' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
