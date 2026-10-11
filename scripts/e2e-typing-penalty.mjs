// e2e：学习 → 兑现登记「处罚标准」↔ 电脑监控预警联动（v1.13.5）
//
// 覆盖用户提的需求：
//   ① 「兑现登记」页「奖励标准」下面新增「处罚标准」卡 —— 配【哪台电脑】【每次扣多少】【扣哪个成员】【推给哪些成员】
//   ② 电脑监控命中预警关键字 → 兑现记录里自动多一笔负数（-¥X + 「处罚」标记），合计变负 = 欠账
//   ③ 备注 =《预警违法电脑使用规定，扣减X元》+ 处罚标准说明 + AI 分析原文
//   ④ 赚钱日历（money tab）显示「本月处罚扣款」并计入待兑现扣减
//   ⑤ 规则由 UI 配置并落库（PUT 往返），普通成员进不了这张卡
//
// 视觉模型用本机 stub 顶替（真 AI 不可控，见 test-monitor-penalty.mjs）。UI 段走真 Playwright。
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）。
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';

const PORT = 3193;
const STUB_PORT = 3192;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-pen-ui-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

const visionText = '孩子正在浏览 4399 小游戏网站，标签页：赛尔号。';
const stub = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: visionText } }], usage: { total_tokens: 88 } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));

const cleanup = () => { try { server.kill(); } catch {} try { stub.close(); } catch {} };
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
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 0x41)]);
async function uploadShot(devId, key) {
  const fd = new FormData();
  fd.append('id', devId);
  fd.append('key', key);
  fd.append('computer', '测试机');
  fd.append('shot', new Blob([JPG], { type: 'image/jpeg' }), 'shot.jpg');
  const r = await fetch(`${B}/api/monitor/agent/shot`, { method: 'POST', body: fd });
  return { status: r.status, j: await r.json().catch(() => null) };
}

let browser;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  const ADMINUSER = lg.j.user || lg.j.b?.user;
  const ADMIN = ADMINUSER.id || 1;
  ok(!!T, 'admin 登录');

  const kid = await api('POST', '/api/users', { token: T, body: { username: 'kid', password: 'kid123456', role: 'user', display_name: '小明' } });
  const KID = kid.j.id;
  await api('POST', '/api/ai/config', {
    token: T,
    body: { model: 'stub', base_url: `http://127.0.0.1:${STUB_PORT}/v1`, api_key: 'k', vision_model: 'stub-v', vision_base_url: `http://127.0.0.1:${STUB_PORT}/v1`, vision_api_key: 'vk' },
  });
  const mc = await api('PUT', '/api/monitor/settings', { token: T, body: { ai_enabled: 1, ai_every: 1, keywords: '游戏', alert_users: [], alert_cooldown: 0 } });
  const KEY = mc.j.access_key;
  await api('GET', `/api/monitor/agent/config?id=devmain01&key=${KEY}&computer=测试机`);
  await api('PUT', '/api/monitor/devices/devmain01', { token: T, body: { name: '孩子电脑' } });
  ok(!!KID && !!KEY, '环境就绪（成员小明 / 1 台监控电脑 孩子电脑 / 关键字=游戏）');

  // ---------- UI：处罚标准卡 ----------
  console.log('— UI：兑现登记页的「处罚标准」卡');
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(ADMINUSER)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
  p.on('dialog', (d) => { d.dismiss().catch(() => {}); });

  await p.goto(`${B}/#/learning?tab=payout`);
  await p.waitForSelector('.po-card', { timeout: 15000 });
  const penCard = p.locator('.po-card', { hasText: '处罚标准' }).first();
  await penCard.scrollIntoViewIfNeeded();
  ok((await penCard.locator('h3').innerText()).includes('处罚标准'), '「处罚标准」卡片渲染在兑现登记页');
  ok(await penCard.locator('input[type=checkbox]').isChecked(), '「启用处罚标准」默认勾选');
  ok((await penCard.innerText()).includes('《预警违法电脑使用规定，扣减X元》'), '卡片里写明备注格式');
  ok((await penCard.innerText()).includes('欠账的负值'), '卡片里写明「合计为 0 时扣完变欠账负值」');
  ok((await penCard.innerText()).includes('还没有规则'), '未配置时给「还没有规则」提示');

  // 添加规则 → 选电脑 / 金额 / 扣减成员 / 推送成员
  await penCard.locator('button', { hasText: '添加处罚规则' }).click();
  const rule = penCard.locator('.pen-rule').first();
  await rule.waitFor({ timeout: 5000 });
  ok((await rule.locator('.pen-head').innerText()).includes('规则 1'), '新规则块出现（规则 1）');
  const devSel = rule.locator('select').nth(0);
  ok((await devSel.locator('option').allInnerTexts()).some((t) => t.includes('孩子电脑')), '电脑下拉带出已接入的「孩子电脑」');
  await devSel.selectOption({ label: '孩子电脑' });
  const amt = rule.locator('input[type=number]').first();
  await amt.fill('2.5');
  const dedSel = rule.locator('select').nth(1);
  ok((await dedSel.locator('option').allInnerTexts()).some((t) => t.includes('小明')), '扣减成员下拉带出「小明」');
  await dedSel.selectOption({ label: '小明' });
  // 推送成员（UserPicker 多选）：点开下拉 → 勾小明 → 关闭
  await rule.locator('.up-box').click();
  await rule.locator('.up-drop .up-item', { hasText: '小明' }).first().click();
  ok((await rule.locator('.up-chip').count()) >= 1 && (await rule.locator('.up-chip').first().innerText()).includes('小明'), '推送成员选中「小明」（chip 出现）');
  // 收起下拉：点卡片的其它地方（UserPicker 有 document click 监听；点 .up-box 中心会落在输入框上反而保持打开）
  await penCard.locator('h3').click();
  await penCard.locator('.up-drop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  ok((await rule.locator('.up-drop').count()) === 0, '点卡片其它位置即收起推送下拉');

  await penCard.locator('button', { hasText: '保存处罚标准' }).click();
  await p.waitForSelector('.po-msg', { timeout: 8000 });
  ok(/\d+ 条规则生效/.test(await penCard.locator('.po-msg').innerText()), '保存回执说明生效条数');

  let saved = await api('GET', '/api/typing/payouts/penalty', { token: T });
  ok(saved.j.rules.length === 1 && saved.j.rules[0].device_id === 'devmain01' && saved.j.rules[0].amount === 2.5, 'UI 保存真的落库（设备/金额）');
  ok(saved.j.rules[0].deduct_user_id === KID && JSON.stringify(saved.j.rules[0].push_user_ids) === JSON.stringify([KID]), 'UI 保存真的落库（扣谁 / 推给谁）');

  // 刷新后回显（不是只改了内存）
  await p.reload();
  await p.waitForSelector('.pen-rule', { timeout: 10000 });
  const rule2 = p.locator('.pen-rule').first();
  ok((await rule2.locator('select').nth(0).inputValue()) === 'devmain01', '刷新后电脑回显');
  ok(Number(await rule2.locator('input[type=number]').first().inputValue()) === 2.5, '刷新后金额回显');
  ok((await rule2.locator('.up-chip').first().innerText()).includes('小明'), '刷新后推送成员回显');

  // ---------- 命中关键字 → 兑现记录出现负数 ----------
  console.log('— 命中预警 → 兑现记录负数 + 合计欠账');
  const up = await uploadShot('devmain01', KEY);
  ok(up.status === 200 && up.j.ok, '上报一张截图');
  const pen = await waitFor(async () => {
    const r = await api('GET', '/api/typing/payouts', { token: T });
    return (r.j || []).find((x) => x.amount < 0) || null;
  });
  ok(!!pen && pen.amount === -2.5, '兑现流水出现 -2.5');
  ok(!!pen && pen.note.includes('《预警违法电脑使用规定，扣减2.5元》') && pen.note.includes('4399'), '备注 = 规定文案 + AI 分析原文');

  await p.reload();
  await p.waitForSelector('.po-table tbody tr', { timeout: 10000 });
  // 注意：按整卡文本过滤会命中「处罚标准」卡（说明里就写着「兑现记录」），必须按 h3 定位
  const recCard = p.locator('.po-card').filter({ has: p.locator('h3', { hasText: '兑现记录' }) }).first();
  const rowTxt = await recCard.locator('tbody tr').first().innerText();
  ok(rowTxt.includes('-¥2.50') && rowTxt.includes('处罚'), '兑现记录首行显示 -¥2.50 + 「处罚」标记');
  ok((await recCard.locator('.badge.wait').count()) === 1, '处罚行带 badge（区别于普通兑现）');
  ok((await recCard.innerText()).includes('¥-2.50（欠账）'), '兑现记录合计显示 ¥-2.50（欠账）');
  const noteTitle = await recCard.locator('tbody tr').first().locator('td.note').getAttribute('title');
  ok(String(noteTitle).startsWith('《预警违法电脑使用规定，扣减2.5元》'), '备注全文挂在 title（悬停可看完整原因）');
  // 预览行按「成员」算：默认停在登录者自己（admin）身上——处罚扣的是小明，必须先把成员切过去
  const pvSel = p.locator('.po-form select').first();
  ok((await pvSel.locator('option').allInnerTexts()).some((t) => t.includes('小明')), '登记表单「成员」下拉带出小明');
  await pvSel.selectOption({ label: '小明' });
  // 切换后预览是异步重算的（watch → loadPreview），等它算出含处罚的金额再断言
  await p.waitForFunction(() => document.querySelector('.po-preview')?.innerText.includes('处罚扣款'), null, { timeout: 10000 }).catch(() => {});
  const pvTxt = await p.locator('.po-preview').innerText();
  ok(pvTxt.includes('处罚扣款') && pvTxt.includes('-¥2.5'), '登记表单上方的预览行显示「处罚扣款 -¥2.5」（分子算）', pvTxt.replace(/\s+/g, ' ').slice(0, 200));
  ok(pvTxt.includes('待兑现') && /待兑现\s*¥0\.00/.test(pvTxt.replace(/\s+/g, ' ')), '小明待兑现 0（负数不把待兑现压成负值）');

  // ---------- 赚钱日历 ----------
  console.log('— 赚钱日历：本月处罚扣款');
  await p.goto(`${B}/#/learning?tab=money`);
  await p.waitForSelector('.mn-cards', { timeout: 10000 });
  // 日历也是「按成员」看的：默认落在登录者自己（admin，无处罚）——切到小明
  const mnSel = p.locator('.mn-head select');
  await mnSel.waitFor({ timeout: 10000 });
  ok((await mnSel.locator('option').allInnerTexts()).some((t) => t.includes('小明')), '赚钱日历成员下拉带出小明');
  await mnSel.selectOption({ label: '小明' });
  // 卡片先渲染默认 0 值，数据回来才出现处罚卡——等文案落地再断言（等 .mn-cards 存在是不够的）
  await p.waitForFunction(() => document.querySelector('.mn-cards')?.innerText.includes('本月处罚扣款'), null, { timeout: 10000 }).catch(() => {});
  const cards = await p.locator('.mn-cards').innerText();
  ok(cards.includes('本月处罚扣款'), '日历出现「本月处罚扣款」卡');
  ok(cards.includes('-¥2.50'), '处罚扣款金额 -¥2.50');
  ok(await p.waitForFunction(() => /本月电脑监控处罚扣款/.test(document.querySelector('.mn-rate')?.innerText || ''), null, { timeout: 10000 }).then(() => true).catch(() => false), '费率行注明处罚扣款去向');
  // 「待兑现」那张卡必须正好 ¥0.00（欠账不把待兑现压成负值）
  const pendCard = p.locator('.mn-card').filter({ has: p.locator('span', { hasText: '待兑现' }) }).first();
  ok((await pendCard.locator('b').innerText()).trim() === '¥0.00', '待兑现 ¥0.00（负数不把待兑现压成负值）',
    await pendCard.innerText());

  // ---------- 权限：普通成员进不了这张卡 ----------
  console.log('— 权限');
  const kctx = await browser.newContext();
  const klg = await api('POST', '/api/auth/login', { body: { username: 'kid', password: 'kid123456' } });
  await kctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [klg.j.b?.token || klg.j.token, JSON.stringify(klg.j.user || klg.j.b?.user)]);
  const kp = await kctx.newPage();
  kp.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  await kp.goto(`${B}/#/learning?tab=payout`);
  await sleep(1200);
  ok((await kp.locator('.po-card', { hasText: '处罚标准' }).count()) === 0, '普通成员（无 learning 页权限）看不到兑现登记页');
  await kctx.close();
  const kg = await api('GET', '/api/typing/payouts/penalty', { token: klg.j.b?.token || klg.j.token });
  ok(kg.status === 403, '普通成员调处罚标准接口 403');

  ok(perr.length === 0, `管理端页面无 JS 报错${perr.length ? '：' + perr.join(' | ') : ''}`);

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', e && e.stack || e);
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
  await sleep(200);
  process.exit(failed ? 1 : 0);
}
