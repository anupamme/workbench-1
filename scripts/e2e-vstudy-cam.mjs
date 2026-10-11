// e2e：v1.13.8 「学习监控状态」——视频教学播放时本机摄像头同步开启、定时截图存服务器、流水表可见可删
//
// 用户需求（2026-10-11）：视频播放画面右侧开一个小窗（约主画面 1/4，320 分辨率），视频一开播摄像头就开；
// 窗下是「截图流水」表：每 N 分钟（设置页可改，默认 3）截一张，显示历史截图路径；
// 文件名 = 日期时间 + 播放的视频名称；管理员可多选删除；流水表默认 10 行/页（可选 5/10/15/30/50/100）带前后翻页。
//
// 覆盖：
//   ① 设置项：GET/POST /settings/vstudy-check 的 cam_interval_min（默认 3、范围 1~60），/vstudy/config 下发；
//   ② 上传：POST /vstudy/cam（JPEG 二进制）→ 文件名 <日期时间>_<视频名>.jpg 落盘 data/vstudy-cam/、清单入库；
//      视频名带路径分隔符会被安全化（不存在目录穿越）；同秒撞名自动加序号；非 JPEG / 空 body 被拒；
//      关掉「视频学习检查」后上传被拒（摄像头与注意力检测一起停）；
//   ③ 列表/权限：本人只看自己；管理员可 uid=all 看全部并拿到用户名单；非管理员看别人 403；
//      看图端点只有本人或管理员能看（防拿文件名猜别人的画面）；
//   ④ 删除：仅管理员，批量删两张 → 清单与磁盘文件一起消失（再看 → 404）；
//   ⑤ 顺带回归：RIFF 家族嗅探（WAV 不能被当成 AVI 拦下）——v1.13.7 的嗅探器把 .wav 判成 avi，本版修掉；
//   ⑥ UI（假摄像头）：小窗标题【学习监控状态】、点开媒体后摄像头开、按周期真的截到图并进流水表、
//      分页（默认 10、可选 5/10/15/30/50/100、前后翻页）、管理员有勾选框+删除按钮、成员没有、
//      关闭视频后摄像头停。
// 隔离 DATA_DIR 起真实服务；Playwright 用 Chromium 假摄像头设备（--use-fake-device-for-media-stream）。
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3192;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-vscam-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试素材 ----------
const ROOT = path.join(DATA, 'study');
mkdirSync(path.join(ROOT, '初一'), { recursive: true });
// 真·可播放的 WAV（8kHz 单声道 8bit PCM，60 秒静音）：<video> 能真播 → play 事件 → 摄像头开 → 截图
function wavBuffer(seconds = 60, rate = 8000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n, 128);          // 8bit 无符号 PCM，128 = 静音
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + n, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
  head.write('data', 36); head.writeUInt32LE(n, 40);
  return Buffer.concat([head, data]);
}
writeFileSync(path.join(ROOT, '初一', '课程.wav'), wavBuffer());
writeFileSync(path.join(ROOT, '初一', '笔记.txt'), Buffer.from('课堂笔记', 'utf8'));

// 最小 JPEG（服务端只验魔数与长度；UI 段是真 canvas 出的真 JPEG）
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(400, 0x7f), Buffer.from([0xff, 0xd9])]);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
const cleanup = () => { try { server.kill(); } catch { /* 已退 */ } };
process.on('exit', cleanup);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await sleep(500);
  }
  throw new Error('服务 30s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text(), ct };
}
// 截图上传（与浏览器同一条路：JPEG 二进制 body + ?token=）
async function postShot(token, video, buf = FAKE_JPEG) {
  const r = await fetch(`${B}/api/vstudy/cam?video=${encodeURIComponent(video)}&token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: buf,
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const CAM_DIR = path.join(DATA, 'vstudy-cam');

let browser;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'admin 登录');
  await api('POST', '/api/vstudy/settings', { token: T, body: { root: ROOT } });
  await api('POST', '/api/users', { token: T, body: { username: 'm1', password: 'm1-pass-123', role: 'user', allowed_pages: ['learning'], allowed_tabs: { learning: ['vstudy'] } } });
  const mlg = await api('POST', '/api/auth/login', { body: { username: 'm1', password: 'm1-pass-123' } });
  const MT = mlg.j.b?.token || mlg.j.token;
  ok(!!MT, '成员 m1 登录（仅 learning/vstudy 权限）');

  // ---------- ① 设置项：摄像头截图保存频率 ----------
  console.log('— 设置：摄像头截图保存频率（默认 3 分钟，可填 1~60）');
  const c0 = await api('GET', '/api/vstudy/config', { token: T });
  ok(c0.j.cam_interval_min === 3, '/vstudy/config 默认 cam_interval_min=3', JSON.stringify(c0.j.cam_interval_min));
  const s0 = await api('GET', '/api/settings/vstudy-check', { token: T });
  ok(s0.j.enabled === true && s0.j.cam_interval_min === 3, 'GET /settings/vstudy-check 回 {enabled:true, cam_interval_min:3}', JSON.stringify(s0.j));
  const s1 = await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: true, cam_interval_min: 5 } });
  ok(s1.j.cam_interval_min === 5, '保存 5 分钟生效', JSON.stringify(s1.j));
  const s2 = await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: true, cam_interval_min: 99 } });
  ok(s2.j.cam_interval_min === 60, '超过 60 收敛到 60（不写脏值）', String(s2.j.cam_interval_min));
  const s3 = await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: true, cam_interval_min: 0 } });
  ok(s3.j.cam_interval_min === 1, '小于 1 收敛到 1', String(s3.j.cam_interval_min));
  const s4 = await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: true } });
  ok(s4.j.cam_interval_min === 1, '只传 enabled 时不清掉已设的频率（仍是 1）', String(s4.j.cam_interval_min));
  const s5 = await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: true, cam_interval_min: 3 } });
  ok(s5.j.cam_interval_min === 3 && s5.j.enabled === true, '改回 3 分钟', JSON.stringify(s5.j));
  const s6 = await api('POST', '/api/settings/vstudy-check', { token: MT, body: { cam_interval_min: 7 } });
  ok(s6.status === 403, '非管理员改不了这个设置（403）', String(s6.status));
  const c1 = await api('GET', '/api/vstudy/config', { token: T });
  ok(c1.j.cam_interval_min === 3 && c1.j.check_enabled === true, '/vstudy/config 同步下发新值', JSON.stringify({ i: c1.j.cam_interval_min, e: c1.j.check_enabled }));

  // ---------- ⑤ 顺带回归：WAV 不能被嗅探成 AVI（v1.13.7 的老毛病） ----------
  console.log('— 回归：RIFF 家族嗅探（WAV ≠ AVI）');
  const tr = await api('GET', '/api/vstudy/tree?dir=' + encodeURIComponent('初一'), { token: T });
  const by = Object.fromEntries((tr.j.entries || []).map((e) => [e.name, e]));
  ok(by['课程.wav'] && by['课程.wav'].box === 'wav' && by['课程.wav'].native === true,
    '.wav → box=wav / native=true（旧版判成 avi 会被当「浏览器不能播」拦下）', JSON.stringify(by['课程.wav']));
  const pr = await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('初一/课程.wav'), { token: T });
  ok(pr.j.box === 'wav' && pr.j.playable === true, 'probe：wav 可播', JSON.stringify(pr.j));
  const fr = await fetch(`${B}/api/vstudy/file?path=${encodeURIComponent('初一/课程.wav')}&token=${encodeURIComponent(T)}`, { headers: { Range: 'bytes=0-99' } });
  ok(fr.status === 206 && fr.headers.get('content-type') === 'audio/wav', '文件响应头 audio/wav', fr.headers.get('content-type'));

  // ---------- ② 上传：命名规则 + 落盘 ----------
  console.log('— 上传：文件名 = 日期时间 + 视频名');
  const u1 = await postShot(T, '课程.wav');
  ok(u1.status === 200 && u1.j.ok === true, '上传一张截图成功', JSON.stringify(u1.j));
  ok(/^\d{8}-\d{6}_课程\.jpg$/.test(u1.j.file), '文件名 = 日期时间_视频名.jpg（扩展名已去掉，不留 .wav.jpg）', u1.j.file);
  ok(existsSync(path.join(CAM_DIR, u1.j.file)), '磁盘上真的有这个文件');
  ok(u1.j.path === path.join(CAM_DIR, u1.j.file), '回传的 path 就是服务器落盘完整路径（流水表「路径」列）', u1.j.path);
  ok(u1.j.interval_min === 3, '回传当前频率 3 分钟');
  const u2 = await postShot(T, '../..\\逃逸尝试.wav');
  ok(u2.status === 200 && !/[\\/]/.test(u2.j.file.replace(CAM_DIR, '')), '视频名里的路径分隔符被安全化（文件仍在 vstudy-cam 下）', u2.j.file);
  ok(existsSync(path.join(CAM_DIR, u2.j.file)) && u2.j.file.indexOf('_逃逸尝试.jpg') > 0, '危险名生成的文件名保留了可读部分（_逃逸尝试.jpg）', u2.j.file);
  const bad1 = await postShot(T, '课程.wav', Buffer.from('not a jpeg at all'.repeat(20)));
  ok(bad1.status === 400, '非 JPEG 数据被拒（400）', String(bad1.status));
  const bad2 = await postShot(T, '课程.wav', Buffer.from([0xff, 0xd8, 0x01]));
  ok(bad2.status === 400, '太短的 body 被拒（400）', String(bad2.status));
  const u3 = await postShot(MT, '课程.wav');
  ok(u3.status === 200, '成员 m1 也能上传（自己的截图）');

  // ---------- ③ 列表 / 权限 ----------
  console.log('— 流水列表与权限');
  const la = await api('GET', '/api/vstudy/cam/list', { token: T });
  ok(la.j.total === 2 && la.j.scope === 'me', '管理员默认「本人」2 张', JSON.stringify({ t: la.j.total, s: la.j.scope }));
  const lall = await api('GET', '/api/vstudy/cam/list?uid=all', { token: T });
  ok(lall.j.total === 3 && lall.j.scope === 'all', 'uid=all 看全部 3 张', JSON.stringify({ t: lall.j.total, s: lall.j.scope }));
  ok(Array.isArray(lall.j.users) && lall.j.users.length >= 2, 'uid=all 时下发用户名单（供下拉切人）', JSON.stringify(lall.j.users.map((u) => u.name)));
  ok(lall.j.rows[0].id > lall.j.rows[1].id, '按 id 倒序（最新截图在最上面）');
  const lm = await api('GET', '/api/vstudy/cam/list', { token: MT });
  ok(lm.j.total === 1 && lm.j.scope === 'me', '成员只看到自己的 1 张', JSON.stringify({ t: lm.j.total, s: lm.j.scope }));
  ok(lm.j.users.length === 0, '成员拿不到用户名单（看不到别人）');
  const lmAll = await api('GET', '/api/vstudy/cam/list?uid=all', { token: MT });
  ok(lmAll.status === 403, '成员查 all 被拒（403）', String(lmAll.status));
  const lmOther = await api('GET', '/api/vstudy/cam/list?uid=1', { token: MT });
  ok(lmOther.status === 403, '成员查别人 uid 被拒（403）', String(lmOther.status));
  const adminFile = u1.j.file, mFile = u3.j.file;
  const vOK = await fetch(`${B}/api/vstudy/cam/file/${encodeURIComponent(mFile)}?token=${encodeURIComponent(T)}`);
  ok(vOK.status === 200 && vOK.headers.get('content-type') === 'image/jpeg', '管理员能看成员那一张（image/jpeg）', String(vOK.status));
  const vOwn = await fetch(`${B}/api/vstudy/cam/file/${encodeURIComponent(mFile)}?token=${encodeURIComponent(MT)}`);
  ok(vOwn.status === 200, '成员能看自己那一张', String(vOwn.status));
  const vDeny = await fetch(`${B}/api/vstudy/cam/file/${encodeURIComponent(adminFile)}?token=${encodeURIComponent(MT)}`);
  ok(vDeny.status === 403, '成员看不了别人的那张（403，防拿文件名猜）', String(vDeny.status));
  const vTrav = await fetch(`${B}/api/vstudy/cam/file/${encodeURIComponent('../../windows/win.ini')}?token=${encodeURIComponent(T)}`);
  ok(vTrav.status === 404 || vTrav.status === 400, '看图端点守目录穿越（../ 被拦）', String(vTrav.status));
  const vNone = await fetch(`${B}/api/vstudy/cam/file/20260101-000000_无此图.jpg?token=${encodeURIComponent(T)}`);
  ok(vNone.status === 404, '不存在的截图 404（文件名形态合法也不给 500）', String(vNone.status));

  // ---------- ④ 删除（仅管理员批量） ----------
  console.log('— 批量删除');
  const dm = await api('POST', '/api/vstudy/cam/delete', { token: MT, body: { ids: [1] } });
  ok(dm.status === 403, '成员删不了（403）', String(dm.status));
  const delIds = lall.j.rows.slice(0, 2).map((r) => r.id);
  const delFiles = lall.j.rows.slice(0, 2).map((r) => r.file);
  const da = await api('POST', '/api/vstudy/cam/delete', { token: T, body: { ids: delIds } });
  ok(da.j.ok === true && da.j.deleted === 2, '管理员一次删 2 张', JSON.stringify(da.j));
  ok(delFiles.every((f) => !existsSync(path.join(CAM_DIR, f))), '磁盘上的图片文件也一并删除');
  const vDel = await fetch(`${B}/api/vstudy/cam/file/${encodeURIComponent(delFiles[0])}?token=${encodeURIComponent(T)}`);
  ok(vDel.status === 404, '删掉的那张再看 → 404', String(vDel.status));
  const lAfter = await api('GET', '/api/vstudy/cam/list?uid=all', { token: T });
  ok(lAfter.j.total === 1, '删完只剩 1 张', String(lAfter.j.total));

  // ---------- 关掉「视频学习检查」= 摄像头截图一并停 ----------
  console.log('— 关闭视频学习检查时上传被拒');
  await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: false, cam_interval_min: 3 } });
  const uOff = await postShot(T, '课程.wav');
  ok(uOff.status === 400 && /关闭/.test(uOff.j.error || ''), '关掉后上传被拒并说明原因', JSON.stringify(uOff.j));
  const cOff = await api('GET', '/api/vstudy/config', { token: T });
  ok(cOff.j.check_enabled === false, '/vstudy/config 的 check_enabled=false（前端据此不开摄像头）');
  await api('POST', '/api/settings/vstudy-check', { token: T, body: { enabled: true, cam_interval_min: 3 } });
  const cOn = await api('GET', '/api/vstudy/config', { token: T });
  ok(cOn.j.check_enabled === true, '重新打开后恢复');

  // ---------- 清空 + 播 12 张，给 UI 分页用 ----------
  const rest = (await api('GET', '/api/vstudy/cam/list?uid=all&pageSize=100', { token: T })).j.rows.map((r) => r.id);
  if (rest.length) await api('POST', '/api/vstudy/cam/delete', { token: T, body: { ids: rest } });
  for (let i = 0; i < 12; i++) await postShot(T, `第${i + 1}课.wav`);
  const seed = await api('GET', '/api/vstudy/cam/list?uid=all', { token: T });
  ok(seed.j.total === 12, '铺 12 张给分页用例', String(seed.j.total));

  // ---------- ⑥ UI（假摄像头） ----------
  console.log('— UI：小窗 + 流水表 + 分页 + 权限按钮');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.grantPermissions(['camera'], { origin: B });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('wb_token', t); localStorage.setItem('wb_user', u); }, [T, JSON.stringify(lg.j.user || lg.j.b?.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
  p.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  // 进浏览页：开始学习 → 学年 → 学科；cam_sec=2 把截图周期临时改成 2 秒（跑完整链路，不用等 3 分钟）
  await p.goto(`${B}/?cam_sec=2#/learning?tab=vstudy`);
  await p.locator('.big-start').waitFor({ timeout: 15000 });
  await p.locator('.big-start').click();
  await p.locator('.pick h3', { hasText: '选择学年' }).waitFor({ timeout: 10000 });
  await p.locator('.big-btn').first().click();
  await p.locator('.pick h3', { hasText: '选择学科' }).waitFor({ timeout: 10000 });
  await p.locator('.big-btn').first().click();
  const n1 = p.locator('.row.dir', { hasText: '初一' }).first();
  await n1.waitFor({ timeout: 10000 });
  await n1.click();
  await p.locator('.row.media', { hasText: '课程.wav' }).first().waitFor({ timeout: 10000 });

  ok(await p.locator('.mon-title').innerText() === '📹 学习监控状态', '右侧小窗标题 = 学习监控状态');
  const mbox = await p.locator('.monitor').boundingBox();
  const zbox = await p.locator('.player-zone').boundingBox();
  ok(mbox && mbox.width === 320 && zbox && mbox.width <= zbox.width * 0.4 && mbox.x > zbox.x + zbox.width * 0.5,
    '小窗 320px 贴在主画面右侧（约主画面 1/4 宽）', `小窗 ${mbox && Math.round(mbox.width)}px @x=${mbox && Math.round(mbox.x)} / 区域 ${zbox && Math.round(zbox.width)}px`);
  ok(await p.locator('.cam-cover').isVisible(), '未播放时摄像头是关的（盖着「摄像头未开启」）');
  ok(await p.locator('.shot-tbl tbody tr').count() === 10, '流水表默认每页 10 行');
  const sizeOpts = await p.locator('.shots-head select').last().locator('option').allInnerTexts();
  ok(JSON.stringify(sizeOpts) === JSON.stringify(['5', '10', '15', '30', '50', '100']), '每页可选 5/10/15/30/50/100', sizeOpts.join(','));
  ok(/共 12 条 · 第 1 \/ 2 页/.test(await p.locator('.shots-foot').innerText()), '分页信息：共 12 条 · 第 1/2 页', (await p.locator('.shots-foot').innerText()).replace(/\s+/g, ' '));
  ok(await p.locator('.shot-tbl th.ck').count() === 1 && await p.locator('.shots-head .del').count() === 1, '管理员：勾选框列 + 删除按钮都在');
  // 翻页
  await p.locator('.shots-foot button', { hasText: '下一页' }).click();
  await p.waitForFunction(() => /第 2 \/ 2 页/.test(document.querySelector('.shots-foot').innerText), null, { timeout: 5000 });
  ok(await p.locator('.shot-tbl tbody tr').count() === 2, '翻到第 2 页 → 2 行（12 条 10/页）');
  ok(await p.locator('.shots-foot button', { hasText: '下一页' }).isDisabled(), '最后一页「下一页」置灰');
  await p.locator('.shots-foot button', { hasText: '上一页' }).click();
  await p.waitForFunction(() => /第 1 \/ 2 页/.test(document.querySelector('.shots-foot').innerText), null, { timeout: 5000 });
  ok(await p.locator('.shots-foot button', { hasText: '上一页' }).isDisabled(), '第 1 页「上一页」置灰');
  // 改每页行数
  await p.locator('.shots-head select').last().selectOption('5');
  await p.waitForFunction(() => document.querySelectorAll('.shot-tbl tbody tr').length === 5, null, { timeout: 5000 });
  ok(/共 12 条 · 第 1 \/ 3 页/.test(await p.locator('.shots-foot').innerText()), '每页改 5 → 第 1/3 页', (await p.locator('.shots-foot').innerText()).replace(/\s+/g, ' '));
  // 勾选 → 删除按钮可用
  await p.locator('.shot-tbl tbody tr').first().locator('input[type=checkbox]').check();
  ok(!(await p.locator('.shots-head .del').isDisabled()), '勾上一条后「删除选中」可用');
  await p.locator('.shot-tbl tbody tr').first().locator('input[type=checkbox]').uncheck();
  ok(await p.locator('.shots-head .del').isDisabled(), '取消勾选后按钮置灰');

  // 播放 → 摄像头开 → 按 2 秒周期真的截到图
  const before = (await api('GET', '/api/vstudy/cam/list?uid=all&pageSize=100', { token: T })).j.total;
  await p.locator('.row.media', { hasText: '课程.wav' }).first().click();
  await p.waitForFunction(() => { const v = document.querySelector('.player-col video'); return !!(v && v.src); }, null, { timeout: 10000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector('.cam-cover'), null, { timeout: 15000 });
  ok(true, '点开媒体后本机摄像头真的开了（遮罩消失）');
  // 等第一条「课程.wav」的截图真的进表（pageSize 已经是 5，光等行数会在旧数据上立刻通过）
  await p.waitForFunction(() => {
    const t = document.querySelector('.shot-tbl tbody');
    return !!(t && /_课程\.jpg/.test(t.innerText));
  }, null, { timeout: 20000 });
  const rows = await p.locator('.shot-tbl tbody tr').all();
  const firstTxt = await rows[0].innerText();
  ok(/课程\.wav/.test(firstTxt) && /_课程\.jpg/.test(firstTxt), '流水表最新一行 = 正在播的视频', firstTxt.replace(/\s+/g, ' ').slice(0, 80));
  ok(/vstudy-cam/.test(firstTxt), '这一行显示的是服务器上的截图路径', firstTxt.replace(/\s+/g, ' ').slice(0, 120));
  await sleep(3000);
  const afterList = await api('GET', '/api/vstudy/cam/list?uid=all&pageSize=100', { token: T });
  ok(afterList.j.total > before, `摄像头按周期持续截图（${before} → ${afterList.j.total} 张）`);
  const newest = afterList.j.rows[0];
  ok(/^\d{8}-\d{6}_课程\.jpg$/.test(newest.file) && newest.video === '课程.wav', '浏览器截的那张文件名同样合规', newest.file);
  const disk = path.join(CAM_DIR, newest.file);
  ok(existsSync(disk) && readFileSync(disk).slice(0, 2).toString('latin1') === '\xff\xd8',
    '浏览器截的那张是真 JPEG 落在磁盘上', existsSync(disk) ? `${readFileSync(disk).length} B` : '缺文件');
  // 查看（window.open 新窗口）
  const popupP = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await p.locator('.shot-tbl tbody tr').first().locator('.op a').click();
  const popup = await popupP;
  ok(!!popup && /\/api\/vstudy\/cam\/file\/.*token=/.test(popup.url()), '「查看」新开窗口带 token 直链', popup ? popup.url().replace(/token=.*/, 'token=***').slice(-70) : '没弹出');
  if (popup) await popup.close().catch(() => {});
  // 关闭视频 → 摄像头停
  await p.locator('.player-zone .zone-head button', { hasText: '关闭' }).click();
  await p.waitForSelector('.cam-cover', { timeout: 8000 });
  ok(true, '关闭视频后摄像头同步关闭（遮罩回来）');
  // 清单里每一条都能在磁盘上找到（截图真落盘，不是只写库）
  const allRows = (await api('GET', '/api/vstudy/cam/list?uid=all&pageSize=100', { token: T })).j.rows;
  const miss = allRows.filter((r) => !existsSync(path.join(CAM_DIR, r.file)));
  const filesOnDisk = readdirSync(CAM_DIR).filter((f) => f.endsWith('.jpg')).length;
  ok(miss.length === 0 && filesOnDisk >= allRows.length, `清单 ${allRows.length} 条在磁盘上全都在（目录共 ${filesOnDisk} 个 .jpg）`);
  ok(perr.length === 0, 'UI 全程无 JS 报错', perr.join(' | '));

  // ---------- 成员视角：没有删除按钮 / 勾选框 / 用户下拉 ----------
  console.log('— 成员视角：只读自己的流水');
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx2.addInitScript(([t, u]) => { localStorage.setItem('wb_token', t); localStorage.setItem('wb_user', u); }, [MT, JSON.stringify(mlg.j.user || mlg.j.b?.user)]);
  const p2 = await ctx2.newPage();
  p2.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  await p2.goto(`${B}/#/learning?tab=vstudy`);
  await p2.locator('.big-start').waitFor({ timeout: 15000 });
  await p2.locator('.big-start').click();
  await p2.locator('.pick h3', { hasText: '选择学年' }).waitFor({ timeout: 10000 });
  await p2.locator('.big-btn').first().click();
  await p2.locator('.pick h3', { hasText: '选择学科' }).waitFor({ timeout: 10000 });
  await p2.locator('.big-btn').first().click();
  await p2.locator('.mon-title').waitFor({ timeout: 10000 });
  ok(await p2.locator('.shots-head .del').count() === 0, '成员看不到「删除选中」按钮');
  ok(await p2.locator('.shot-tbl th.ck').count() === 0, '成员看不到勾选框列');
  ok(await p2.locator('.shots-head select').count() === 1, '成员只有「每页行数」一个下拉（没有用户切换）');
  ok(await p2.locator('.shot-tbl tbody tr').count() === 1 && !/课程\.wav/.test(await p2.locator('.shot-tbl tbody').innerText()),
    '成员只看到自己那张（看不到管理员铺的 12 张）');

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', (e && e.stack) || e);
} finally {
  try { if (browser) await browser.close(); } catch { /* 已关 */ }
  cleanup();
  await sleep(200);
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 句柄未释放 */ }
  process.exit(failed ? 1 : 0);
}
