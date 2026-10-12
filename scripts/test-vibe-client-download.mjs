// 录音转写「客户端引擎下发」链路测试（2026-10-12 用户报障「新电脑装完报引擎不存在」的直接回归）
//
// 报障根因：客户端安装包（setup.ps1）只能拿到工作台 /api/vibe/client-download 里**服务器上已有**的文件，
// 而生产容器 <应用目录>/vibeasr/win-x64/ 一直不存在（镜像打于 vibeasr/ 入仓之前、升级包从不带它）
// → 客户端 engine\ 落空 → sidecar 报「引擎不存在」退出 → 看护每 30 秒重启一次（用户只看到「没反应」）。
//
// 本测试覆盖三件事：
//   A) 引擎四件套一个都没有时：list 必须**如实**自报 missing（旧版只回一个 server.js，客户端无从判断）
//   B) 四件套放进【持久数据目录】<DATA_DIR>/vibeasr/win-x64/（新增的第二个查找位置）后：
//      list 报 engine_ok、四个文件逐个可下载且字节一致；带 + 的文件名（libstdc++-6.dll）三种写法都要能取到
//   C) 生成的 setup.ps1：带 UTF-8 BOM、含新的引擎自检段、且 PowerShell 语法解析通过（不执行）
//
// 隔离 DATA_DIR 必须在 spawn server 之前设好；本测试不动真实引擎目录，用完把移开的目录移回。
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, renameSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 3199;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-vibedl-'));
const SHIPPED = path.join(ROOT, 'vibeasr', 'win-x64');         // ① 随包分发目录（仓库里就有）
const PARKED = path.join(ROOT, 'vibeasr', 'win-x64.__e2e_parked'); // 测试期间把它挪走 = 模拟生产
const STASH = path.join(DATA, 'stash');                        // 四件套暂存（② 之外）
const DATA_ENGINE = path.join(DATA, 'vibeasr', 'win-x64');      // ② 持久数据目录（新增查找位置）
const FILES = ['asr_stream_server.exe', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'];

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}${extra ? '  —— ' + extra : ''}`); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const cleanup = () => {
  try { if (existsSync(PARKED)) { if (existsSync(SHIPPED)) rmSync(SHIPPED, { recursive: true, force: true }); renameSync(PARKED, SHIPPED); } } catch (e) { console.error('!! 恢复 vibeasr/win-x64 失败：' + e.message); }
  try { if (server) server.kill(); } catch { /* */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
};

try {
  // ---------- 起隔离服务 ----------
  mkdirSync(STASH, { recursive: true });
  const from = readdirSync(SHIPPED);
  ok(FILES.every((f) => from.includes(f)), `前置：仓库 ${path.relative(ROOT, SHIPPED)} 里四件套齐（${from.join(', ')}）`);
  for (const f of FILES) copyFileSync(path.join(SHIPPED, f), path.join(STASH, f));

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/health')).ok) { up = true; break; } } catch { /* 未起 */ } await sleep(300); }
  ok(up, '隔离服务起来了');
  if (!up) throw new Error('服务未起');

  // ---------- 管理端下载 setup.ps1（顺带拿到登记密钥；脚本里内嵌） ----------
  const login = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const H = { Authorization: 'Bearer ' + login.token };
  const psRes = await fetch(B + '/api/vibe/client-files?type=setup', { headers: H });
  const psBuf = Buffer.from(await psRes.arrayBuffer());
  const ps = psBuf.toString('utf8');
  const key = (ps.match(/\$Key\s*=\s*'([0-9a-f]{32})'/) || [])[1] || '';
  ok(!!key, '生成的 setup.ps1 内嵌了 32 位登记密钥', key || '(没匹配到)');

  // ---------- C) setup.ps1：BOM + 自检段 + 语法 ----------
  ok(psBuf[0] === 0xEF && psBuf[1] === 0xBB && psBuf[2] === 0xBF, 'setup.ps1 带 UTF-8 BOM（PS 5.1 无 BOM 会把中文按 ANSI 读）');
  ok(ps.includes('$list.missing'), 'setup.ps1 读了服务端自报的 missing 名单');
  ok(ps.includes('服务器没有下发 Windows 引擎二进制'), 'setup.ps1 含引擎自检段（缺文件当场报错，不再进看护循环）');
  const psFile = path.join(DATA, 'setup-check.ps1');
  writeFileSync(psFile, psBuf);
  const chk = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${psFile.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 } else { 'OK' }`], { encoding: 'utf8' });
  ok(chk.status === 0 && /OK/.test(chk.stdout || ''), 'setup.ps1 通过 PowerShell 语法解析（只解析不执行）', (chk.stdout || '') + (chk.stderr || ''));

  // ---------- 就绪后：把 ① 挪走 = 模拟生产（生产 <app>/vibeasr/win-x64 从来不存在） ----------
  renameSync(SHIPPED, PARKED);
  ok(!existsSync(SHIPPED), '测试期把随包分发目录 ① 挪走（模拟生产容器：该目录不存在）');

  // ---------- A) 一个引擎文件都没有：必须如实自报 ----------
  const wrong = await fetch(`${B}/api/vibe/client-download?list=1&k=deadbeef`);
  ok(wrong.status === 403, '密钥不对 → 403', String(wrong.status));
  const listA = await (await fetch(`${B}/api/vibe/client-download?list=1&k=${key}`)).json();
  ok(listA.engine_ok === false, 'A: engine_ok=false（旧版这里什么都不说）', JSON.stringify(listA.engine_ok));
  ok(Array.isArray(listA.missing) && listA.missing.length === 4 && FILES.every((f) => listA.missing.includes(f)), 'A: missing 列出全部四件套', JSON.stringify(listA.missing));
  ok((listA.files || []).some((f) => f.name === 'server.js'), 'A: sidecar（server.js）照样下发');
  ok(!(listA.files || []).some((f) => /\.(exe|dll)$/i.test(f.name)), 'A: 列表里没有任何 exe/dll（客户端据此判断装不成）');
  const dlA = await fetch(`${B}/api/vibe/client-download?f=asr_stream_server.exe&k=${key}`);
  ok(dlA.status === 404, 'A: 取引擎 exe → 404（如实，不返 200 空文件）', String(dlA.status));

  // ---------- B) 把四件套放进 ② 持久数据目录 → 应立刻可用 ----------
  mkdirSync(DATA_ENGINE, { recursive: true });
  for (const f of FILES) copyFileSync(path.join(STASH, f), path.join(DATA_ENGINE, f));
  const listB = await (await fetch(`${B}/api/vibe/client-download?list=1&k=${key}`)).json();
  ok(listB.engine_ok === true, 'B: engine_ok=true', JSON.stringify(listB.engine_ok));
  ok(listB.missing.length === 0, 'B: missing 空', JSON.stringify(listB.missing));
  ok(path.resolve(listB.dir) === path.resolve(DATA_ENGINE), 'B: 服务的是持久数据目录（新增的查找位置）', listB.dir);
  ok(FILES.every((f) => (listB.files || []).some((x) => x.name === f && x.tag === 'engine')), 'B: 列表含四件套且 tag=engine', JSON.stringify(listB.files.map((f) => f.name)));
  ok((listB.files || []).some((f) => f.name === 'server.js' && f.tag === 'sidecar'), 'B: sidecar 仍在列表里');

  for (const f of FILES) {
    const r = await fetch(`${B}/api/vibe/client-download?f=${encodeURIComponent(f)}&k=${key}`);
    const got = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && sha(got) === sha(readFileSync(path.join(STASH, f))), `B: 下载 ${f} 字节一致（${got.length}B）`, `${r.status} ${got.length}`);
  }
  // libstdc++-6.dll 的旧写法：地址里 + 不编码 → 服务端收到的是「libstdc  -6.dll」（两个空格）
  // → 空格换回 + 再试一次必须仍取到同一份（否则旧部署脚本会把 404 的 JSON 当 DLL 写盘）
  const legacy = await fetch(`${B}/api/vibe/client-download?f=libstdc++-6.dll&k=${key}`, { redirect: 'manual' });
  const legacyBuf = Buffer.from(await legacy.arrayBuffer());
  ok(legacy.status === 200 && sha(legacyBuf) === sha(readFileSync(path.join(STASH, 'libstdc++-6.dll'))), 'B: 旧脚本不编码文件名（+ 变空格）仍取到同一份', `${legacy.status} ${legacyBuf.length}`);
  const rps = await fetch(`${B}/api/vibe/client-download?f=server.js&k=${key}`);
  const sidecar = await rps.text();
  ok(rps.status === 200 && sidecar.includes('vibeasr-sidecar'), 'B: server.js（sidecar）可取', String(rps.status));
  ok(sidecar.includes('工作台没下发引擎文件'), 'B: sidecar 的「引擎不存在」已补上真正的原因提示');

  console.log(`\n== ${passed} 通过 / ${failed} 失败 ==`);
} catch (e) {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  failed++;
} finally {
  cleanup();
}

// 收尾自查：移走的目录必须已复原（没复原 = 仓库被测试弄坏，必须让人看见）
if (!existsSync(SHIPPED) || existsSync(PARKED)) {
  console.error('!! 引擎随包目录未复原：' + SHIPPED);
  failed++;
} else {
  console.log('  ✓ 收尾：vibeasr/win-x64 已复原（' + readdirSync(SHIPPED).length + ' 个文件）');
}
process.exit(failed ? 1 : 0);
