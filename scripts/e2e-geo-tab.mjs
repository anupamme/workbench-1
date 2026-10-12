// e2e：学习 → 地理 tab（v1.13.15 起 = 自制地球仪页）
//
// 用户需求：「把这个地球仪功能页的功能，加入到【学习】——增加一个 tab 页【地理】，
// 把参考页面的地球仪全部功能完整代码加入到这个 tab 页。像原生在工作台一样。」
// 随后追加：「你照着地球仪的模式，完整复刻一套新的不用这个版权的效果给我看。」
//
// 实现事实（决定了本测试怎么断言）：
//   · 页面是**本站自研**的 web/public/geo/globe.html（单文件，源码在本仓库）——
//     无第三方版权、无完整性自检，所以「线上字节 == 工作区源文件」这条既证明发布链没改写，
//     也顺带证明线上跑的确实是我们的文件（反向断言：页面里不许出现第三方版权标识
//     「尖子声原创」/ earth-globe，那份第三方页已移出构建树）。
//   · 学习页用全高 iframe 嵌入（geo/globe.html 相对路径，fnOS 网关前缀自动跟随）。
//   · 硬断言：①静态文件逐字节相同；②iframe 里页面启动成功（#loading.done、无 #fatal）；
//     ③功能真在跑（3D 标签层算出地名、点地球出经纬度、拖动真的转动地球、2D 能切且底图解码）。
//
// 地球仪本体的深度硬判据（镜像/自转方向/极地视角/像素差）在 Logs/probe-globe-fixed.mjs，
// 那份是开发期的验收脚本；这里守的是「接进工作台之后」这条链。
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
const PAGE = 'geo/globe.html';

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
  console.log('— ① 静态托管（自制地球仪页随前端一起发布，字节级原样）');
  const localHtml = readFileSync(path.join(ROOT, 'web/public', PAGE));
  const verInFile = (localHtml.toString('utf8').match(/自制版 v[\d.]+/) || [''])[0];
  ok(!!verInFile, '工作区源文件带自制版版本号（部署后用它能一眼认出线上是这一版）', verInFile || '没找到');

  const r = await fetch(`${B}/${PAGE}`);
  const buf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200, `GET /${PAGE} 200（不需要登录——该页是独立页面，无 token 概念）`, String(r.status));
  ok(buf.length === localHtml.length && sha(buf) === sha(localHtml), '线上字节 == 工作区源文件（发布链没改写它）',
    `${buf.length} B / ${sha(buf).slice(0, 12)}…`);
  const served = buf.toString('utf8');
  ok(served.includes('<!DOCTYPE html'), '返回的是 HTML 页面（不是 SPA 兜底 index.html）');
  ok(served.includes(verInFile), '线上就是这一版（版本号对得上）', verInFile);
  // 反向断言：线上跑的必须是我们自制的页，不能是那份第三方版权页
  ok(!served.includes('尖子声原创') && !served.includes('earth-globe'),
    '线上没有第三方版权标识（自制版已替换掉 earth-globe.html）');

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
  ok(new RegExp(`${PAGE.replace('.', '\\.')}$`).test(src || ''), `iframe 指向 ${PAGE}（相对路径，fnOS 网关前缀自动跟随）`, src || '');

  // 占满窗口宽度（v1.13.17，用户要求「整个画面自适应宽度，不要限制宽度」）：
  // 工作台每一页都被 App.vue 的 `.main` 封在 1200px 里，本面板挂载期间借 mainFull 开关放开。
  const mainState = () => p.evaluate(() => {
    const m = document.querySelector('main.main');
    return m ? { max: getComputedStyle(m).maxWidth, w: Math.round(m.getBoundingClientRect().width) } : null;
  });
  const full = await mainState();
  ok(!!full && full.max === 'none', '地理 tab 挂载时 .main 放开 1200px 上限（main-full）', JSON.stringify(full));
  {
    // 把窗口拉宽到 1800 才看得出「真没上限」：默认 1440 的视口里左侧栏占掉约 190，内容区只有 1250，
    // 就算没放开也只差几十像素——必须换个宽视口来问这件事。
    await p.setViewportSize({ width: 1800, height: 900 });
    await sleep(500);
    const wide = await mainState();
    const fb = await frameEl.boundingBox();
    ok(!!wide && wide.w > 1500, '窗口拉宽到 1800 时内容区跟着变宽（没有 1200px 上限了）', JSON.stringify(wide));
    ok(!!fb && fb.width > 1400, '地球仪 iframe 跟着铺满窗口宽度', fb ? `${Math.round(fb.width)}px` : 'null');
    await p.setViewportSize({ width: 1440, height: 900 });
    await sleep(400);
  }

  const fr = p.frames().find((f) => f.url().includes('globe.html'));
  ok(!!fr, 'iframe 已加载到地球仪页');
  await fr.waitForSelector('#loading.done', { timeout: 60000 }).catch(() => {});
  await sleep(800);

  // 页面自报家门：品牌栏那行版本号 == 工作区文件里的那一行（证明进的是我们这份文件）
  const brandVer = await fr.evaluate(() => {
    const el = document.querySelector('.brand .ver');
    return el ? el.textContent.trim() : '';
  }).catch(() => '');
  ok(brandVer === verInFile, 'iframe 里的是自制版（品牌栏版本号与源文件一致）', brandVer);

  const fatal = await fr.evaluate(() => {
    const f = document.getElementById('fatal');
    return f && getComputedStyle(f).display !== 'none' ? f.innerText.slice(0, 100) : '';
  }).catch(() => '');
  ok(!fatal, '没有「地球仪无法启动」遮罩（WebGL 初始化成功）', fatal);
  ok(await fr.locator('#globe-canvas').count() === 1, '3D canvas 存在');
  ok(await fr.locator('#map-2d-container').count() === 1, '2D 容器存在（两套模式都在页面里）');
  ok(await fr.locator('#btn-2d').count() === 1 && await fr.locator('#btn-3d').count() === 1, '3D / 2D 切换按钮都在');

  // 渲染器真在跑：3D 标签层被算出地名（WebGL 帧缓冲读不到，用「算出来的东西」作证据）
  const live = await fr.evaluate(() => {
    const layer = document.getElementById('labels-3d-layer');
    const labels = layer ? [...layer.children].map((e) => ({ t: (e.textContent || '').trim(), d: e.style.display }))
      .filter((o) => o.t && o.d !== 'none').map((o) => o.t) : [];
    const c = document.getElementById('globe-canvas');
    return { labels: labels.slice(0, 6), n: labels.length, canvas: c ? [c.width, c.height] : null };
  }).catch((e) => ({ err: String(e && e.message).slice(0, 80) }));
  ok(live.n >= 4, '3D 标签层有地名（渲染器真的在算）', live.err ? live.err : `${live.n} 个：${(live.labels || []).join('/')}`);
  ok(!!live.canvas && live.canvas[0] > 200, '3D canvas 有尺寸', JSON.stringify(live.canvas));

  // 点一下地球 → 坐标面板给出经纬度（这个页面最主要的功能）
  const box = await frameEl.boundingBox().catch(() => null);
  const readCenter = () => fr.evaluate(() => ((document.getElementById('coordinate-result') || {}).innerText || '')
    .replace(/\s+/g, ' ').trim());
  {
    if (box) {
      await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await sleep(900);
    }
    const res = await readCenter();
    ok(/[0-9]/.test(res) && !res.includes('请点击'), '点地球后坐标面板给出经纬度', String(res).slice(0, 80));
  }

  // 拖动 → 地球真的跟着转（不是把底图钉在屏幕上——这是复刻过程中修掉的那个 bug）
  {
    const before = await readCenter();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 12 });
    await p.mouse.up();
    await sleep(700);
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    await sleep(400);
    const after = await readCenter();
    ok(after !== before && /[0-9]/.test(after), '拖动后中心经纬度变了（地球真在转）', `${before} → ${after}`);
  }

  // 2D 平面图（底图真的解码）
  await fr.locator('#btn-2d').click({ force: true }).catch(() => {});
  await sleep(1200);
  const cls = await fr.evaluate(() => document.body.className);
  ok(cls.includes('mode-2d'), '点「2D 平面图模式」后页面进入 mode-2d', cls);
  ok(await fr.evaluate(() => {
    const im = document.getElementById('earth-texture');
    return !!(im && im.complete && im.naturalWidth > 1000);
  }), '2D 底图（5400×2700）解码成功');
  ok(await fr.locator('#map2d').isVisible(), '2D 平面地图可见');
  await fr.locator('#btn-3d').click({ force: true }).catch(() => {});
  await sleep(600);
  ok(await fr.locator('#globe-container').isVisible(), '切回 3D 正常');

  // 全屏能力（iframe 必须带 allow="fullscreen"，否则页内全屏按钮点了没反应）
  const allow = await frameEl.getAttribute('allow');
  ok((allow || '').includes('fullscreen'), 'iframe 带 allow="fullscreen"（页内全屏按钮可用）', allow || '');

  // 切走再切回：组件不残留、能再次加载（tab 反复切换是日常动作）
  // ⚠️ 切走要挑一个**自己不放宽**的 tab：心愿卡自 v1.13.18 起也申请铺满（mainFull），
  // 拿它验证「上限还回来」会假红——这里用「打字」。
  await p.locator('.tabs button', { hasText: '打字' }).first().click();
  await sleep(400);
  ok((await p.locator('iframe.geo-frame').count()) === 0, '切到别的 tab 后地球仪 iframe 被卸载（不留后台 WebGL 上下文）');
  const back = await mainState();
  ok(!!back && back.max !== 'none', '切走之后 .main 的 1200px 上限还回来（别的页面布局不受影响）', JSON.stringify(back));
  await p.locator('.tabs button', { hasText: '地理' }).first().click();
  await p.waitForSelector('iframe.geo-frame', { timeout: 10000 });
  // iframe 元素一挂上就存在了，但它里面的 frame 还要等导航才注册进来（刚挂上是 about:blank）
  // ——直接 p.frames().find() 会拿到 undefined，这里轮询等它出现（曾经在这条上偶发假红）
  let fr2 = null;
  for (let i = 0; i < 60 && !fr2; i++) {
    fr2 = p.frames().find((f) => f.url().includes('globe.html'));
    if (!fr2) await sleep(250);
  }
  if (fr2) await fr2.waitForSelector('#loading.done', { timeout: 60000 }).catch(() => {});
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
