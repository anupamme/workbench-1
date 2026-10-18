// E2E（v1.18.8，v1.18.9 改为默认收缩）：左侧目录可收缩成图标栏。
// 验的是真浏览器里的行为，不是静态 DOM：
//   ① 首次登录（新浏览器、localStorage 无记录）默认收缩：60px 图标栏、只剩 ☰
//   ② 用户主动点 ☰ 展开 → 190px 带文字，并记为「这个人要展开」（localStorage '0'）
//   ③ 刷新后保持展开；再点 ‹ 收起也记得住（'1'）
//   ④ 手机目录是抽屉：收缩态不生效（仍 232px、文字还在），由顶栏 ☰ 开关
// 隔离 DATA_DIR + 独立端口，跑完即删。
//   node scripts/e2e-nav-collapse.mjs
import { chromium } from 'playwright';
import { startServer, login, checker, sleep } from './_noteE2E.mjs';

const { ck, done } = checker();
const PORT = 3198;

const srv = await startServer({ tag: 'navcollapse', port: PORT });
const B = srv.B;
let br = null;
try {
  const lg = await login(B, 'admin', 'test123456');
  br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
    // 注意：不碰 wb_nav_collapsed —— 新上下文本来就是空的，正好验「首次登录默认收缩」
  }, [lg.token, JSON.stringify(lg.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 200)));

  await p.goto(`${B}/#/`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.sidebar .nav a', { timeout: 20000 });
  await sleep(300);

  const sideW = () => p.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const lblVisible = () => p.locator('.sidebar .nav a .lbl').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  });
  const iconVisible = () => p.locator('.sidebar .nav a .ico').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const toggleIcon = () => p.locator('.nav-toggle .material-icons').innerText();
  const firstLabel = (await p.locator('.sidebar .nav a .lbl').first().innerText()).trim();

  // ---------- A. 首次登录：默认收缩 ----------
  ck('A1 首次登录默认收缩：目录宽 60px', (await sideW()) === 60, await sideW());
  ck('A2 默认带 collapsed 类', await p.locator('.sidebar.collapsed').count() === 1);
  ck('A3 默认菜单文字隐藏', !(await lblVisible()));
  ck('A4 默认只剩三横 ☰ 展开按钮', (await p.locator('.nav-toggle').count()) === 1 && (await toggleIcon()) === 'menu', await toggleIcon());
  ck('A5 默认 logo 文字隐藏（左上角只有 ☰）', !(await p.locator('.sidebar .logo-name').isVisible()));
  ck('A6 图标仍可见（22px 图标列）', await iconVisible());
  const tip = await p.locator('.sidebar .nav a').first().getAttribute('title');
  ck('A7 收缩时图标带 title 提示（悬浮显示菜单名）', tip === firstLabel, `${tip} vs ${firstLabel}`);
  ck('A8 默认没写 localStorage（未做选择就不落偏好）', (await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))) === null, String(await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))));

  // ---------- B. 用户主动展开：记住「我要展开」 ----------
  await p.locator('.nav-toggle').click();
  await sleep(350);
  ck('B1 点 ☰ 展开 → 190px 带文字', (await sideW()) === 190 && await lblVisible(), String(await sideW()));
  ck('B2 展开后按钮变成 ‹（收起）', (await toggleIcon()) === 'chevron_left', await toggleIcon());
  ck('B3 展开选择记进 localStorage = 0', (await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))) === '0');
  ck('B4 展开后 hover 空 title（用可见文字而非提示）', (await p.locator('.sidebar .nav a').first().getAttribute('title')) === null);

  // ---------- C. 刷新保持展开 ----------
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.sidebar .nav a', { timeout: 20000 });
  await sleep(300);
  ck('C1 刷新后仍是展开态 190px（主动展开过就一直展开）', (await sideW()) === 190, String(await sideW()));
  ck('C2 刷新后文字仍可见', await lblVisible());

  // 展开态下点导航仍正常
  await p.locator('.sidebar .nav a').nth(1).click();
  await sleep(500);
  ck('C3 展开态点菜单能正常跳页', !p.url().endsWith('#/'), p.url());

  // ---------- D. 主动收起：也记得住 ----------
  await p.locator('.nav-toggle').click();
  await sleep(350);
  ck('D1 点 ‹ 收起回 60px', (await sideW()) === 60, String(await sideW()));
  ck('D2 收起选择记进 localStorage = 1', (await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))) === '1');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.sidebar .nav a', { timeout: 20000 });
  await sleep(300);
  ck('D3 刷新后仍是收缩态 60px', (await sideW()) === 60 && (await toggleIcon()) === 'menu', String(await sideW()));

  // ---------- E. 手机抽屉不受收缩态影响 ----------
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(350);
  ck('E1 手机上抽屉里的收缩按钮隐藏', !(await p.locator('.nav-toggle').isVisible()));
  await p.locator('.mobile-topbar .hamburger').click();
  await sleep(400);
  const mw = await sideW();
  ck('E2 抽屉宽度仍是 232px（收缩态不生效）', mw === 232, mw);
  ck('E3 抽屉里菜单文字照常显示', await lblVisible());
  ck('E4 抽屉里 logo 文字照常显示', await p.locator('.sidebar .logo-name').isVisible());

  ck('Z1 全程无前端异常', perr.length === 0, perr.join(' | '));
} catch (e) {
  ck('运行异常', false, e && e.stack ? e.stack.slice(0, 400) : String(e));
} finally {
  if (br) await br.close().catch(() => {});
  srv.stop();
}
done();
