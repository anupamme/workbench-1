// E2E（v1.18.8）：左侧目录可收缩成图标栏。
// 验的是真浏览器里的行为，不是静态 DOM：
//   ① 展开态 190px，文字可见，左上角有「收起」按钮
//   ② 点收起 → 60px 图标栏，只剩图标（文字 label 不可见），左上角只剩三横 ☰
//   ③ 收缩记忆在 localStorage，刷新后仍是收缩态
//   ④ 点 ☰ 能展开回 190px 带文字，且 localStorage 记为 0
//   ⑤ 手机上目录是抽屉：收缩态不生效（仍 232px、文字还在），由顶栏 ☰ 开关
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

  // ---------- A. 展开态 ----------
  ck('A1 默认展开：目录宽 190px', (await sideW()) === 190, await sideW());
  ck('A2 展开态菜单文字可见', await lblVisible());
  ck('A3 左上角有收起按钮（chevron_left）', (await p.locator('.nav-toggle').count()) === 1 && (await toggleIcon()) === 'chevron_left', await toggleIcon());
  ck('A4 展开态 logo 文字可见', await p.locator('.sidebar .logo-name').isVisible());
  ck('A5 默认 localStorage 未记收缩', (await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))) !== '1');

  // ---------- B. 收起 ----------
  await p.locator('.nav-toggle').click();
  await sleep(350);
  ck('B1 收起后宽度 60px 图标栏', (await sideW()) === 60, await sideW());
  ck('B2 目录带 collapsed 类', await p.locator('.sidebar.collapsed').count() === 1);
  ck('B3 菜单文字全部隐藏', !(await lblVisible()));
  ck('B4 图标仍然可见（22px 图标列）', await iconVisible());
  ck('B5 收缩后左上角只剩三横 ☰（logo 文字让位）', !(await p.locator('.sidebar .logo-name').isVisible()) && (await toggleIcon()) === 'menu', await toggleIcon());
  const tip = await p.locator('.sidebar .nav a').first().getAttribute('title');
  ck('B6 收缩时图标带 title 提示（悬浮显示菜单名）', tip === firstLabel, `${tip} vs ${firstLabel}`);
  ck('B7 localStorage 记为 1', (await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))) === '1');

  // ---------- C. 刷新保持 ----------
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.sidebar .nav a', { timeout: 20000 });
  await sleep(300);
  ck('C1 刷新后仍是收缩态（60px）', (await sideW()) === 60, await sideW());
  ck('C2 刷新后仍是 ☰ 展开按钮', (await toggleIcon()) === 'menu');
  ck('C3 刷新后文字仍隐藏、图标仍在', !(await lblVisible()) && await iconVisible());

  // 收缩态下点导航仍能跳页且保持收缩
  await p.locator('.sidebar .nav a').nth(1).click();
  await sleep(500);
  ck('C4 收缩态点图标能正常跳页且不弹开目录', (await sideW()) === 60 && !p.url().endsWith('#/'), p.url());

  // ---------- D. 展开回来 ----------
  await p.locator('.nav-toggle').click();
  await sleep(350);
  ck('D1 点 ☰ 展开回 190px', (await sideW()) === 190, await sideW());
  ck('D2 菜单文字回来了', await lblVisible());
  ck('D3 展开后 localStorage 记为 0', (await p.evaluate(() => localStorage.getItem('wb_nav_collapsed'))) === '0');
  ck('D4 展开后 hover 空 title（用可见文字而非提示）', (await p.locator('.sidebar .nav a').first().getAttribute('title')) === null);

  // ---------- E. 手机抽屉不受收缩态影响 ----------
  await p.locator('.nav-toggle').click(); // 先收回收缩态
  await sleep(350);
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
