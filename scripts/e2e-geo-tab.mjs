// e2e：学习 → 地理 tab（v1.13.14）
//
// 用户需求：「把这个地球仪功能页的功能，加入到【学习】——增加一个 tab 页【地理】，
// 把参考页面的地球仪全部功能完整代码加入到这个 tab 页。像原生在工作台一样。」
//
// 实现事实（决定了本测试怎么断言）：
//   · 该地球仪页（地球仪 · 3D模拟实验室 V0916-1，© JZS LAB）主脚本对**自身**做完整性自检
//     （全文哈希 + 版权 meta / <i> / style 文本 + 必需 DOM id + 8K 纹理 data-URI 首尾与哈希），
//     任何改动都会让它自毁成「页面完整性校验失败，已停止运行」——所以只能**原样托管**
//     （web/public/geo/earth-globe.html → dist 根 geo/earth-globe.html），学习页用全高 iframe 嵌入。
//   · 因此本测试的硬断言是：①静态文件与本地 dist **逐字节相同**（没被任何环节改写）；
//     ②iframe 里自检没失败；③功能真在跑（3D 标签层算出地名、点地球出经纬度、2D 能切）。
//
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）；
// 这里用 spawn 起独立进程，env 直接透传即可。
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3451;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-geo-'));
const ROOT = path.join(import.meta.dirname, '..');

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) return; } catch { /* 未起 */ }
    await sleep(500);
  }
  throw new Error('服务 60s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text() };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let browser;
try {
  await waitReady();

  // ---------- ① 静态托管：页面原样在，且逐字节没被改写 ----------
  console.log('— ① 静态托管（地球仪页随前端一起发布，字节级原样）');
  const r = await fetch(`${B}/geo/earth-globe.html`);
  const buf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200, 'GET /geo/earth-globe.html 200（不需要登录——该页是独立第三方页，无 token 概念）', String(r.status));
  const localHtml = readFileSync(path.join(ROOT, 'web/public/geo/earth-globe.html'));
  ok(buf.length === localHtml.length && sha(buf) === sha(localHtml), '线上字节 == 工作区源文件（原样托管，没被任何环节改写）',
    `${buf.length} B / ${sha(buf).slice(0, 12)}…`);
  ok(buf.toString('utf8', 0, 200).includes('<!DOCTYPE html'), '返回的是 HTML 页面（不是 SPA 兜底 index.html）');

  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  const ADMINUSER = lg.j.user || lg.j.b?.user;
  ok(!!T, 'admin 登录');

  // ---------- ② UI：tab 存在 + iframe 里功能真在跑 ----------
  console.log('— ② 学习页「地理」tab + iframe 里的地球仪');
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(ADMINUSER)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
  p.on('dialog', (d) => { d.dismiss().catch(() => {}); });

  await p.goto(`${B}/#/learning?tab=geo`);
  await p.waitForSelector('.tabs button', { timeout: 15000 });
  const tabLabels = await p.locator('.tabs button').allInnerTexts();
  ok(tabLabels.some((t) => t.includes('地理')), 'tab 栏出现「地理」按钮', tabLabels.join('/'));
  ok((await p.locator('.tabs button.active').innerText()).includes('地理'), '深链 ?tab=geo 直达并高亮（像原生 tab 一样）');

  const frameEl = p.locator('iframe.geo-frame');
  await frameEl.waitFor({ timeout: 10000 });
  const src = await frameEl.getAttribute('src');
  ok(/geo\/earth-globe\.html$/.test(src || ''), 'iframe 指向 geo/earth-globe.html（相对路径，fnOS 网关前缀自动跟随）', src || '');

  const fr = p.frames().find((f) => f.url().includes('earth-globe.html'));
  ok(!!fr, 'iframe 已加载到地球仪页');
  await fr.waitForSelector('#globe-canvas', { timeout: 25000 }).catch(() => {});
  await sleep(3000);   // 渲染器加密载荷解码 + 首帧

  const bodyTxt = await fr.locator('body').innerText().catch(() => '');
  ok(!bodyTxt.includes('完整性校验失败'), '地球仪页自检通过（没有出现「页面完整性校验失败」）',
    bodyTxt.includes('完整性校验失败') ? '被自检拦下 = 文件被改写过' : '通过');
  ok(await fr.locator('#globe-canvas').count() === 1, '3D canvas 存在');
  ok(await fr.locator('#map-2d-container').count() === 1, '2D 容器存在（两套模式都在页面里）');
  ok(await fr.locator('#btn-2d').count() === 1 && await fr.locator('#btn-3d').count() === 1, '3D / 2D 切换按钮都在');

  // 渲染器真在跑：3D 标签层被算出地名（WebGL 帧缓冲读不到，用「算出来的东西」作证据）
  const live = await fr.evaluate(() => {
    const layer = document.getElementById('labels-3d-layer');
    const labels = layer ? [...layer.children].map((e) => (e.textContent || '').trim()).filter(Boolean) : [];
    const c = document.getElementById('globe-canvas');
    return { labels: labels.slice(0, 6), n: labels.length, canvas: c ? [c.width, c.height] : null };
  }).catch((e) => ({ err: String(e && e.message).slice(0, 80) }));
  ok(live.n >= 4, '3D 标签层有地名（渲染器真的在算）', live.err ? live.err : `${live.n} 个：${(live.labels || []).join('/')}`);
  ok(!!live.canvas && live.canvas[0] > 200, '3D canvas 有尺寸', JSON.stringify(live.canvas));

  // 点一下地球 → 坐标面板给出经纬度（这个页面最主要的功能）
  {
    const box = await frameEl.boundingBox().catch(() => null);
    if (box) {
      await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await sleep(900);
    }
    const res = await fr.evaluate(() => (document.getElementById('coordinate-result') || {}).textContent || '');
    ok(/[0-9]/.test(res) && !res.includes('请点击地图'), '点地球后坐标面板给出经纬度',
      String(res).replace(/\s+/g, ' ').slice(0, 80));
  }

  // 2D 平面图（8K 底图真的解码）
  await fr.locator('#btn-2d').click({ force: true }).catch(() => {});
  await sleep(1200);
  const cls = await fr.evaluate(() => document.body.className);
  ok(cls.includes('mode-2d'), '点「2D 平面图模式」后页面进入 mode-2d', cls);
  ok(await fr.evaluate(() => {
    const im = document.getElementById('earth-texture-src');
    return !!(im && im.complete && im.naturalWidth > 1000);
  }), '2D 底图（8K 纹理）解码成功');
  await fr.locator('#btn-3d').click({ force: true }).catch(() => {});
  await sleep(600);

  // 全屏能力（iframe 必须带 allow="fullscreen"，否则页内全屏按钮点了没反应）
  const allow = await frameEl.getAttribute('allow');
  ok((allow || '').includes('fullscreen'), 'iframe 带 allow="fullscreen"（页内全屏按钮可用）', allow || '');

  // 版权标记仍在 = 页面还是原样的
  const mark = await fr.evaluate(() => {
    const w = document.getElementById('_0x7e4c9a_w');
    return w ? (w.getAttribute('data-copyright') || '').slice(0, 8) : '';
  });
  ok(mark.startsWith('尖子声原创'), '页面自带版权标记仍在（没有二次加工）', mark);

  // 切走再切回：组件不残留、能再次加载（tab 反复切换是日常动作）
  await p.locator('.tabs button', { hasText: '心愿卡' }).first().click();
  await sleep(400);
  ok((await p.locator('iframe.geo-frame').count()) === 0, '切到别的 tab 后地球仪 iframe 被卸载（不留后台 WebGL 上下文）');
  await p.locator('.tabs button', { hasText: '地理' }).first().click();
  await p.waitForSelector('iframe.geo-frame', { timeout: 10000 });
  const fr2 = p.frames().find((f) => f.url().includes('earth-globe.html'));
  await fr2.waitForSelector('#globe-canvas', { timeout: 25000 }).catch(() => {});
  ok(!!fr2 && (await fr2.locator('#globe-canvas').count()) === 1, '切回「地理」能重新加载（第二次也正常）');
  ok((await p.url()).includes('tab=geo'), '切 tab 同步地址栏 ?tab=geo', p.url());

  ok(perr.length === 0, `页面无未捕获 JS 报错${perr.length ? '：' + perr.join(' | ') : ''}`);

  // ---------- ③ 权限：受限成员没勾「地理」就不出现 ----------
  console.log('— ③ 权限（与其它 tab 同一套 allowed_tabs 语义）');
  const kid = await api('POST', '/api/users', {
    token: T,
    body: { username: 'kid', password: 'kid123456', role: 'user', display_name: '小明' },
  });
  ok(!!kid.j.id, '建了受限成员小明');
  await api('PUT', `/api/users/${kid.j.id}`, {
    token: T,
    body: { allowed_pages: ['learning'], allowed_tabs: { learning: ['practice', 'records'] } },
  });
  const kctx = await browser.newContext();
  const klg = await api('POST', '/api/auth/login', { body: { username: 'kid', password: 'kid123456' } });
  await kctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [klg.j.b?.token || klg.j.token, JSON.stringify(klg.j.user || klg.j.b?.user)]);
  const kp = await kctx.newPage();
  kp.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  await kp.goto(`${B}/#/learning?tab=geo`);
  await kp.waitForSelector('.tabs button', { timeout: 15000 });
  const kidTabs = await kp.locator('.tabs button').allInnerTexts();
  ok(!kidTabs.some((t) => t.includes('地理')), '小明的授权里没有「地理」→ tab 不出现', kidTabs.join('/'));
  ok((await kp.locator('iframe.geo-frame').count()) === 0, '深链 ?tab=geo 也进不去（key 校验兜住）');
  // 勾上之后立刻可见（管理员在用户管理里加一个键即可）
  await api('PUT', `/api/users/${kid.j.id}`, {
    token: T,
    body: { allowed_pages: ['learning'], allowed_tabs: { learning: ['practice', 'records', 'geo'] } },
  });
  const klg2 = await api('POST', '/api/auth/login', { body: { username: 'kid', password: 'kid123456' } });
  await kctx.addInitScript(([u]) => localStorage.setItem('wb_user', u), [JSON.stringify(klg2.j.user || klg2.j.b?.user)]);
  await kp.reload();
  await kp.waitForSelector('.tabs button', { timeout: 15000 });
  ok((await kp.locator('.tabs button').allInnerTexts()).some((t) => t.includes('地理')), '管理员勾上「地理」后该成员就能看到');
  await kctx.close();

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', (e && e.stack) || e);
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
  await sleep(200);
  process.exit(failed ? 1 : 0);
}
