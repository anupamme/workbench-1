// e2e：学习 → 打字 → 记录（打字记录页流水表）v1.13.13
//
// 用户需求（原话）：「打字-打字记录-流水表中，日期再增加时间。咱增加一列打字项目，
//   是通过游戏模式还是诗词模式还是歌词模式 还是钢琴模式要能看到。」
//
// 覆盖点：
//   ① 一次练习 = 一行流水（session 归并）：同一 session 的多次心跳只累加一行，不是 20 秒一条；
//   ② 流水行带开始时间（日期 + HH:MM）与打字项目（game/poetry/lyrics/piano）；
//   ③ 不同 session / 不同模式 → 各自一行；
//   ④ 旧前端（不带 session）回落「一天一行」，且**与历史回填同 id**——升级当天不会重复计一行；
//   ⑤ 历史回填：升级前只有 typing_days 的按天数据，升级后流水里仍有那些天（mode 空 = 历史记录，且不编时间）；
//   ⑥ 金额口径没被这套流水改动：/typing/summary 的 correct/net/待兑现仍只认 typing_days；
//   ⑦ UI：记录页表头出现「日期时间 / 打字项目」，行里能看到时间与「诗词模式」等中文名。
//
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）。
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3299;   // 别用 319x：本机其它 e2e（如 e2e-story-ui 的 3195）若留了僵尸进程会与本测试抢同一端口
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-typrec-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
function boot() {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
}
async function stop() {
  if (!server) return;
  const dead = new Promise((r) => server.once('exit', r));
  try { server.kill(); } catch { /* 已退 */ }
  await Promise.race([dead, sleep(5000)]);
  server = null;
}
process.on('exit', () => { try { server && server.kill(); } catch { /* ignore */ } });

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

const today = new Date().toLocaleDateString('sv').slice(0, 10);
const oldDay = new Date(Date.now() - 3 * 86400000).toLocaleDateString('sv').slice(0, 10);   // 模拟「升级前某天」
let browser;
try {
  boot();
  await waitReady();

  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  const ADMINUSER = lg.j.user || lg.j.b?.user;
  ok(!!T, 'admin 登录');

  // ---------- ① 同一 session 的多次心跳 → 一行；带时间与模式 ----------
  console.log('— 练习流水：session 归并 / 时间 / 打字项目');
  const p1 = await api('POST', '/api/typing/progress', { token: T, body: { mode: 'poetry', session: 'sPoemTest01', seconds: 30, correct: 100, wrong: 5 } });
  const p2 = await api('POST', '/api/typing/progress', { token: T, body: { mode: 'poetry', session: 'sPoemTest01', seconds: 20, correct: 50, wrong: 2 } });
  ok(p1.status === 200 && p2.status === 200, '两次心跳上报都成功', `${p1.status} / ${p2.status}`);
  let rec = await api('GET', '/api/typing/records', { token: T });
  let logs = rec.j.logs || [];
  ok(logs.length === 1, '同一 session 两次心跳只产出 1 行流水', `实际 ${logs.length} 行`);
  const poem = logs.find((l) => l.mode === 'poetry');
  ok(!!poem && poem.correct === 150 && poem.wrong === 7 && poem.seconds === 50, '两次心跳的秒数/打对/打错累加进同一行',
    poem ? `${poem.seconds}s ${poem.correct}对${poem.wrong}错` : '(缺行)');
  ok(!!poem && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(poem.at || ''), '流水行带开始时间（日期 + 时分）', poem && poem.at);
  ok(!!poem && poem.day === today, '流水行的 day = 今天', poem && poem.day);
  ok(!!poem && poem.net === 150 - 3 * 7, '流水行有效字数 = 打对 − 3×打错', poem && String(poem.net));

  // ---------- ② 再来一场别的模式 → 各占一行；旧前端（无 session）→ 一天一行 ----------
  await api('POST', '/api/typing/progress', { token: T, body: { mode: 'piano', session: 'sPianoTest02', seconds: 60, correct: 60, wrong: 3 } });
  await api('POST', '/api/typing/progress', { token: T, body: { seconds: 10, correct: 10, wrong: 0 } });   // 旧前端：没有 mode/session
  await api('POST', '/api/typing/progress', { token: T, body: { seconds: 10, correct: 10, wrong: 0 } });   // 旧前端再来一次
  rec = await api('GET', '/api/typing/records', { token: T });
  logs = rec.j.logs || [];
  ok(logs.length === 3, '三场练习（诗词 / 钢琴 / 旧前端兜底）→ 3 行流水', `实际 ${logs.length} 行`);
  const piano = logs.find((l) => l.mode === 'piano');
  ok(!!piano && piano.correct === 60, '钢琴模式的流水行独立成行', piano ? `${piano.correct}对` : '(缺行)');
  const fallback = logs.filter((l) => !l.mode);
  ok(fallback.length === 1 && fallback[0].correct === 20, '旧前端两次上报并进同一行（不是每次一条）',
    fallback.length ? `${fallback[0].correct} 对` : '(缺行)');
  ok(logs.filter((l) => l.day === today).length === 3, '今天的流水共 3 行');

  // ---------- ③ 金额口径没被改动：summary 仍只认 typing_days ----------
  console.log('— 金额口径回归（赚钱日历仍按 typing_days）');
  const sum = await api('GET', '/api/typing/summary', { token: T });
  const t = sum.j.totals || {};
  ok(t.correct === 150 + 60 + 20 && t.wrong === 7 + 3, 'summary 的 correct/wrong = 三场练习之和（typing_days 未动）',
    `${t.correct}对${t.wrong}错`);
  ok(t.net === t.correct - 3 * t.wrong, 'summary 有效字数口径不变', String(t.net));
  ok(Math.abs(t.money - Math.round((t.net * sum.j.config.reward_yuan / sum.j.config.reward_chars) * 100) / 100) < 1e-9,
    '应得金额仍按 有效字数 × 费率 算', `¥${t.money}`);
  const dayRow = (sum.j.days || []).find((d) => d.day === today);
  ok(!!dayRow && dayRow.correct === t.correct, '赚钱日历当天行 = typing_days 的当天汇总（流水表不影响它）');

  // ---------- ④ 历史回填：升级前的按天数据不能消失 ----------
  console.log('— 历史回填（typing_days → typing_logs）');
  await stop();
  {
    const db = new DatabaseSync(path.join(DATA, 'workbench.sqlite'));
    // 用登录者自己的 uid（admin=2，库里已经有 bot 之类的成员，别写死 1）
    db.prepare("INSERT INTO typing_days(user_id,day,seconds,correct,wrong,updated_at) VALUES(?,?,600,500,20,?)")
      .run(ADMINUSER.id, oldDay, oldDay + ' 19:30:00');
    db.prepare("DELETE FROM settings WHERE key='typing_logs_seed_v11313'").run();   // 让回填再跑一次
    // 同时删掉这次测试造的流水，确保回填是从 typing_days 重建的（真升级时这里本来就是空的）
    db.prepare("DELETE FROM typing_logs WHERE session_id LIKE 's%'").run();
    db.close();
  }
  boot();
  await waitReady();
  rec = await api('GET', '/api/typing/records', { token: T });
  logs = rec.j.logs || [];
  const hist = logs.find((l) => l.day === oldDay);
  ok(!!hist, '升级前那天的按天数据在流水里仍在（历史不会整片消失）', hist ? `day=${hist.day}` : '(缺行)');
  ok(!!hist && hist.correct === 500 && hist.wrong === 20, '回填行带着原来的打对/打错', hist ? `${hist.correct}对${hist.wrong}错` : '-');
  ok(!!hist && hist.mode === '', '回填行没有模式（面板显示「历史记录」）', hist && JSON.stringify(hist.mode));
  ok(!!hist && hist.at === '', '回填行没有具体时间——不编时间，前端只显示日期', hist && JSON.stringify(hist.at));
  const todayBucket = logs.filter((l) => l.day === today && !l.mode);
  ok(todayBucket.length === 1 && todayBucket[0].correct === 20,
    '当天的「按天兜底行」与回填同 id（升级当天不会重复计一行）', todayBucket.length ? `${todayBucket[0].correct} 对` : '(缺行)');

  // 新前端的一行（重启后打的）——给下面的 UI 段准备一条带模式的行
  await api('POST', '/api/typing/progress', { token: T, body: { mode: 'game', session: 'sGameUITest3', seconds: 30, correct: 88, wrong: 1 } });

  // ---------- ⑤ UI：记录页表头与行 ----------
  console.log('— UI：记录页流水表');
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(([tk, u]) => {
    localStorage.setItem('wb_token', tk);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(ADMINUSER)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
  p.on('dialog', (d) => { d.dismiss().catch(() => {}); });

  await p.goto(`${B}/#/learning?tab=records`);
  await p.waitForSelector('.rc-table tbody tr', { timeout: 15000 });
  const heads = (await p.locator('.rc-table').first().locator('thead th').allInnerTexts()).map((s) => s.trim());
  ok(heads.includes('日期时间'), '表头是「日期时间」（原来的「日期」）', heads.join(' / '));
  ok(heads.includes('打字项目'), '表头新增「打字项目」列');
  const bodyTxt = await p.locator('.rc-table').first().innerText();
  ok(/游戏模式|诗词模式|歌词模式|钢琴模式/.test(bodyTxt), '行里显示中文模式名（如「诗词模式」）',
    (bodyTxt.match(/游戏模式|诗词模式|歌词模式|钢琴模式/) || [''])[0]);
  const rowsTxt = await p.locator('.rc-table').first().locator('tbody tr').allInnerTexts();
  ok(rowsTxt.some((x) => /\d{2}:\d{2}/.test(x)), '行里显示具体时间（HH:MM）', (rowsTxt.find((x) => /\d{2}:\d{2}/.test(x)) || '').replace(/\s+/g, ' ').slice(0, 80));
  ok(rowsTxt.some((x) => x.includes('历史记录') && x.includes(oldDay)), '回填的历史行显示「历史记录」且只有日期没有时间');
  ok((await p.locator('.credit-box').count()) === 1, '赊账兑换区还在（没被这次改动挤掉）');
  ok(perr.length === 0, `页面无 JS 报错${perr.length ? '：' + perr.join(' | ') : ''}`);

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', e && e.stack || e);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  await stop();
  await sleep(200);
  process.exit(failed ? 1 : 0);
}
