// e2e（界面）：笔记「AI ▾ → 译成中文」（v1.13.15）
// 覆盖用户在页面上真能看到的东西：按钮叫「译成中文」、发出去的是「译成简体中文」的提示词、
// 结果显示区挂着「识别为英文」徽标、正文已是中文时当场提示且**一次 AI 请求都不发**。
// 起隔离 DATA_DIR 的服务器 + 本地假 AI 端点，不碰任何真实数据。
//   node scripts/e2e-note-ai-translate-ui.mjs
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3979;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-noteaiui-'));

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

// ---------- 假 AI 端点 ----------
const hits = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 原样记下 */ }
    hits.push(body);
    const userMsg = (body.messages || []).find((m) => m.role === 'user')?.content || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: '【中文译文】发布流程周五总出问题，数据库迁移应当拆出发布脚本单独执行。' },
        finish_reason: userMsg.includes('TRUNCATE_MARK') ? 'length' : 'stop',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
    }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TTS_ROOT: path.join(DATA, 'tts'), DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stdout.write(d); });
server.stderr.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stderr.write(d); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 40s 未就绪');
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

const EN = [
  '# Release notes',
  '',
  'The release pipeline is still flaky on Fridays. The database migration should be moved out',
  'of the release script and run as a separate step, otherwise a failed migration leaves the',
  'service in a half-updated state that nobody notices until Monday morning.',
].join('\n');
const ZH = '这是一篇中文笔记：发布流程还不太稳，周五发布经常出问题，得把数据库迁移拆出去单独跑。';

let br = null;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.token;
  ok(!!T, 'admin 登录拿到 token');
  ok((await api('POST', '/api/ai/config', { token: T, body: { model: 'stub-model', base_url: STUB, api_key: 'stub-key' } })).status === 200, 'AI 配置指向假端点');

  const enNote = (await api('POST', '/api/notes', { token: T, body: { title: 'E2E 英文发布说明', content: EN } })).j.id;
  const zhNote = (await api('POST', '/api/notes', { token: T, body: { title: 'E2E 中文发布说明', content: ZH } })).j.id;
  ok(enNote > 0 && zhNote > 0, '灌入英文 / 中文两篇笔记');

  const { chromium } = await import('playwright');
  br = await chromium.launch();
  const ctx = await br.newContext();
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(lg.j.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));

  // ---------- 英文笔记 ----------
  console.log('— 英文笔记：译成中文');
  await p.goto(`${B}/#/notes?note=${enNote}`);
  await p.waitForSelector('.ai-wrap button', { timeout: 20000 });
  const btns = await p.locator('.ai-wrap button').allInnerTexts();
  ok(btns.map((s) => s.trim()).includes('译成中文'), '按钮文案是「译成中文」', btns.join('/'));
  ok(!btns.some((s) => s.trim() === '翻译'), '不再有只写「翻译」的按钮', btns.join('/'));
  ok(!(await p.locator('.ai-wrap button', { hasText: '译成中文' }).getAttribute('title')).includes('翻译成英文'),
    '按钮 title 不再写「翻译成英文」');

  hits.length = 0;
  await p.locator('.ai-wrap button', { hasText: '译成中文' }).click();
  await p.waitForSelector('.modal-backdrop .modal', { timeout: 8000 });
  ok((await p.locator('.modal-backdrop .modal h3').first().innerText()).includes('AI 译成中文 · 发送前确认'),
    '弹出「发送前确认」框');
  await p.locator('.modal-backdrop .modal button', { hasText: '不脱敏，直接发送' }).click();
  await p.waitForSelector('.modal-backdrop .modal .markdown-body', { timeout: 20000 });

  const head = await p.locator('.modal-backdrop .modal h3').first().innerText();
  ok(head.includes('识别为英文'), '结果标题挂上「识别为英文」徽标', head.replace(/\s+/g, ' ').slice(0, 80));
  const body = await p.locator('.modal-backdrop .modal .markdown-body').innerText();
  ok(body.includes('【中文译文】'), '正文显示的是中文译文（假端点回的）', body.slice(0, 60));
  ok(hits.length === 1, '假端点收到 1 次请求', String(hits.length));
  const sent = (hits[0]?.messages || []).find((m) => m.role === 'user')?.content || '';
  ok(/翻译成\*\*简体中文\*\*/.test(sent), '实际发出去的提示词是「译成简体中文」');
  ok(!/翻译成英文/.test(sent), '提示词里没有「翻译成英文」');
  ok(sent.includes('The release pipeline is still flaky'), '英文原文完整带上了');
  await p.locator('.modal-backdrop .modal button', { hasText: '关闭' }).click();
  ok((await p.locator('.modal-backdrop').count()) === 0, '关闭后弹窗收起');

  // ---------- 中文笔记：不发请求，当场提示 ----------
  console.log('— 中文笔记：不白烧 token');
  await p.goto(`${B}/#/notes?note=${zhNote}`);
  await p.waitForSelector('.ai-wrap button', { timeout: 20000 });
  hits.length = 0;
  await p.locator('.ai-wrap button', { hasText: '译成中文' }).click();
  await p.locator('.modal-backdrop .modal button', { hasText: '不脱敏，直接发送' }).click();
  await p.waitForSelector('.modal-backdrop .modal .msg.err', { timeout: 15000 });
  const err = await p.locator('.modal-backdrop .modal .msg.err').innerText();
  ok(/已经是中文/.test(err), '当场提示「已经是中文，不需要翻译」', err.slice(0, 80));
  ok(/选中/.test(err) && /译成中文/.test(err), '提示里教用户「选中外文段落再点译成中文」', err.slice(0, 120));
  ok(hits.length === 0, '中文笔记一次 AI 请求都没发', `hits=${hits.length}`);
  ok((await p.locator('.modal-backdrop .modal .markdown-body').count()) === 0, '没有译文区（本来就不该有）');
  await p.locator('.modal-backdrop .modal button', { hasText: '关闭' }).click();

  // ---------- 中文笔记里选中一段英文再译 ----------
  console.log('— 选中片段优先');
  const selNote = (await api('POST', '/api/notes', { token: T, body: { title: 'E2E 中英混排', content: `${ZH}\n\n${EN}` } })).j.id;
  await p.goto(`${B}/#/notes?note=${selNote}`);
  await p.waitForSelector('.ai-wrap button', { timeout: 20000 });
  hits.length = 0;
  // 在编辑器里选中那段英文（CodeMirror 6：用 Ctrl+A 全选后重设 selection 更稳，这里直接抓内容做断言）
  // 走接口层面把「选中」喂进去，UI 只验徽标不至于把中文段判成英文
  const rr = await api('POST', `/api/notes/${selNote}/ai-assist`, { token: T, body: { action: 'translate', selection: EN } });
  ok(rr.status === 200 && rr.j.detected === 'en', '选中的英文段 → detected=en（整篇是中文也不受影响）',
    `${rr.status} detected=${rr.j.detected}`);
  ok(/翻译成\*\*简体中文\*\*/.test((hits[0]?.messages || []).find((m) => m.role === 'user')?.content || ''),
    '选中路径发的也是「译成简体中文」');

  // ---------- 长文被掐断要如实提示 ----------
  console.log('— 译文被长度上限截断');
  const truncNote = (await api('POST', '/api/notes', { token: T, body: { title: 'E2E 长英文', content: `${EN} TRUNCATE_MARK` } })).j.id;
  await p.goto(`${B}/#/notes?note=${truncNote}`);
  await p.waitForSelector('.ai-wrap button', { timeout: 20000 });
  await p.locator('.ai-wrap button', { hasText: '译成中文' }).click();
  await p.locator('.modal-backdrop .modal button', { hasText: '不脱敏，直接发送' }).click();
  await p.waitForSelector('.modal-backdrop .modal .msg.warn', { timeout: 15000 });
  const warn = await p.locator('.modal-backdrop .modal .msg.warn').innerText();
  ok(/长度上限/.test(warn) && /没译完/.test(warn), '截断时黄条提示「到了长度上限，可能没译完」', warn.slice(0, 80));
  ok((await p.locator('.modal-backdrop .modal .markdown-body').innerText()).includes('【中文译文】'), '译文照常显示（不是当成错误拦掉）');
  await p.locator('.modal-backdrop .modal button', { hasText: '关闭' }).click();

  ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
} catch (e) {
  failed++;
  console.error('  ✗ 未捕获异常:', e.message);
  if (serverLog) console.error(serverLog.slice(-1200));
} finally {
  try { if (br) await br.close(); } catch { /* 已关 */ }
  stub.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 占用，忽略 */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
