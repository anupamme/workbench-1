// E2E（v1.18.6）：首页看板「音乐播放器」卡片。
// 需求原话：「左侧显示旋转的唱片的封面图，旋转效果与下方悬浮栏位的唱片旋转转速一样。右边显示播放进度条带有
// 播放时长、未播放时长。右侧下方是一组按钮：播放暂停键、前一曲后一曲、音量大小。音乐播放列表默认使用收藏夹内
// 的歌曲。按钮下方显示2行歌词随着音乐播放显示。看板模块设置的个人设置和总的设置页面的看板模块全局设置都要能
// 控制这个播放器的显示和关闭。」
//
// 本脚本直接锁几条容易悄悄回退的点：
//   · 转速一致：卡片唱片与底部悬浮条唱片的 animationDuration 必须都是 30s（两个元素同时读，一次断言）
//   · 共用播放器：从卡片暂停，底部悬浮条的播放图标同步翻转（双向同一份 musicState）
//   · 歌词口径：上一行（浅）+ 当前行（亮），随播放逐行下移
//   · 两个开关面板：注册表驱动（/dashboard/modules）+ 个人隐藏 + 管理员全局停用
//   · 服务端行为探针：/mc/library?all=1 回全库 3 首，不带 all 时根目录回 0 首（只加不改）
// 隔离 DATA_DIR + 系统临时区音乐目录，绝不碰 data/ 根与真实曲库。
//   node scripts/e2e-dash-music-card.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3198;
const B = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(tmpdir(), 'wb-dashmc-'));

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 合成素材：真可解码的 JPEG + 静音 MP3（同 e2e-music-ui） ----------
// 手拼的 FFD8+垃圾字节+FFD9 过不了浏览器 <img> 解码（@error 会把 has_cover 翻回 0、封面图消失），
// 先用一次性 Chromium 画 16x16 渐变 toDataURL('image/jpeg') 拿真 JPEG 字节。
const { chromium } = await import('playwright');
let JPEG;
{
  const b0 = await chromium.launch();
  const p0 = await b0.newPage();
  const dataUrl = await p0.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 16, 16);
    grad.addColorStop(0, '#3a6ff2');
    grad.addColorStop(1, '#e055a0');
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 16);
    return c.toDataURL('image/jpeg', 0.85);
  });
  await b0.close();
  JPEG = Buffer.from(dataUrl.split(',')[1], 'base64');
}
function id3(texts, withCover) {
  const frames = [];
  const fr = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8'), Buffer.from([0])]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    frames.push(Buffer.concat([h, body]));
  };
  for (const [id, text] of Object.entries(texts)) fr(id, text);
  if (withCover) {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg', 'latin1'), Buffer.from([0]), Buffer.from([3]), Buffer.from([0]), JPEG]);
    const h = Buffer.alloc(10); h.write('APIC', 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    frames.push(Buffer.concat([h, body]));
  }
  const body = Buffer.concat(frames);
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1'); h[3] = 3;
  h[6] = (body.length >> 21) & 0x7f; h[7] = (body.length >> 14) & 0x7f; h[8] = (body.length >> 7) & 0x7f; h[9] = body.length & 0x7f;
  return Buffer.concat([h, body]);
}
// MPEG1 L3 128kbps 44100Hz 立体声，padding=0 → 帧长 floor(144*128000/44100)=417B；全零帧=静音，可解码
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
const SILENCE = Buffer.concat(Array(1148).fill(FRAME)); // ≈30.0s

const MUSIC = fs.mkdtempSync(path.join(tmpdir(), 'dashmc-music-'));
fs.mkdirSync(path.join(MUSIC, '专辑A'));
fs.mkdirSync(path.join(MUSIC, '专辑B'));
// 路径序（COLLATE NOCASE）= 专辑A/A1.mp3 → 专辑A/B2 · 无人声.mp3 → 专辑B/老歌.mp3
fs.writeFileSync(path.join(MUSIC, '专辑A', 'A1.mp3'), Buffer.concat([id3({ TIT2: '夜曲', TPE1: '周杰伦', TALB: '十一月的萧邦' }, true), SILENCE]));
fs.writeFileSync(path.join(MUSIC, '专辑A', 'B2 - 无人声.mp3'), Buffer.concat([id3({ TIT2: '无人声', TPE1: 'B2' }, false), SILENCE]));
fs.writeFileSync(path.join(MUSIC, '专辑B', '老歌 - 无标签.mp3'), SILENCE);
const MUSIC_NORM = MUSIC.replace(/\\/g, '/');

// ---------- 假 LRCLIB：三行同步词（0.6/2.0/4.0s），够验「上一行 + 当前行」逐行走 ----------
const LYR = '[00:00.60]第一句歌词\n[00:02.00]第二句歌词\n[00:04.00]第三句歌词';
const lrclib = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.startsWith('/api/get')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ syncedLyrics: LYR, plainLyrics: '第一句歌词\n第二句歌词\n第三句歌词' }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lrclib.listen(0, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: DATA, TTS_ROOT: path.join(DATA, 'tts'),
    DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456',
    MC_LRCLIB_BASE: `http://127.0.0.1:${lrclib.address().port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(d); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await sleep(250);
  }
  throw new Error('服务 20s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
// 时间文本 "m:ss" → 秒
const secOf = (s) => {
  const m = String(s).trim().match(/^(\d+):(\d\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

let br = null;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'A0 admin 登录拿到 token');
  ok((await api('POST', '/api/mc/settings', { token: T, body: { root: MUSIC_NORM } })).status === 200, 'A1 预配音乐路径');
  const sc = await api('POST', '/api/mc/scan', { token: T, body: {} });
  ok(sc.j.ok === true && sc.j.added === 3, 'A2 预扫描 3 首入库', JSON.stringify(sc.j).slice(0, 120));

  // ---------- A. 注册表与两个开关面板（服务端行为探针） ----------
  const mods = await api('GET', '/api/dashboard/modules', { token: T });
  const card = (mods.j.cards || []).find((c) => c.key === 'music');
  ok(!!card && card.label === '音乐播放器', 'A3 /dashboard/modules 注册了 music=音乐播放器（两个开关面板都读它）', JSON.stringify(card));
  const lay0 = await api('GET', '/api/dashboard/layout', { token: T });
  ok((lay0.j.keys || []).includes('music'), 'A4 新租户默认布局含 music');
  // 旧用户的已保存布局（不含 music）→ 新模块前插到第一位，保证老用户也能看到
  const legacy = ['clock', 'weather', 'commute', 'links', 'todos', 'events', 'news', 'hot', 'kids', 'holiday'];
  ok((await api('POST', '/api/dashboard/layout', { token: T, body: { keys: legacy } })).status === 200, 'A5 模拟旧用户布局（10 个旧模块）');
  const lay1 = await api('GET', '/api/dashboard/layout', { token: T });
  ok(lay1.j.all?.[0] === 'music' && lay1.j.keys?.[0] === 'music',
    'A6 新模块自动前插到老用户布局第一位（misc.js 既有逻辑）', JSON.stringify(lay1.j.all));
  // 管理员全局停用 → 全员移除
  ok((await api('PUT', '/api/dashboard/modules', { token: T, body: { disabled: ['music'] } })).status === 200, 'A7 管理员全局停用 music');
  const lay2 = await api('GET', '/api/dashboard/layout', { token: T });
  ok(!(lay2.j.keys || []).includes('music') && (lay2.j.all || []).includes('music'),
    'A8 全局停用后 keys 拿不到 music（顺序仍保留在 all 里，重新启用可恢复）');
  ok((await api('PUT', '/api/dashboard/modules', { token: T, body: { disabled: [] } })).status === 200, 'A9 还原全局开关');

  // ---------- A10-A12. 服务端探针：/mc/library?all=1 ----------
  const libRoot = await api('GET', '/api/mc/library?dir=', { token: T });
  ok(Array.isArray(libRoot.j.tracks) && libRoot.j.tracks.length === 0,
    'A10 不带 all：根目录直属 0 首（3 首都在子目录，原行为未变）', JSON.stringify(libRoot.j.tracks?.length));
  const libAll = await api('GET', '/api/mc/library?all=1', { token: T });
  ok((libAll.j.tracks || []).length === 3,
    'A11 带 all=1：一次给全库 3 首（看板「全部曲库」播放列表的来源）', JSON.stringify((libAll.j.tracks || []).map((t) => t.title)));
  {
    const paths = (libAll.j.tracks || []).map((t) => String(t.path));
    const sorted = [...paths].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    ok(paths.length === 3 && paths.join('|') === sorted.join('|') && libAll.j.tracks[0].title === '夜曲',
      'A12 all=1 按 path 升序（COLLATE NOCASE，第一首=专辑A 的 A1.mp3）', paths.join('|'));
  }

  // ---------- A13. 预置两首收藏（默认播放列表） ----------
  const byTitle = Object.fromEntries((libAll.j.tracks || []).map((t) => [t.title, t.id]));
  await api('POST', '/api/mc/favorite', { token: T, body: { id: byTitle['无人声'], on: true } });
  await sleep(1100); // 拉开 created_at，让收藏夹顺序确定（DESC = 夜曲在前）
  await api('POST', '/api/mc/favorite', { token: T, body: { id: byTitle['夜曲'], on: true } });
  const favs = await api('GET', '/api/mc/favorites', { token: T });
  const favOrder = (favs.j.tracks || []).map((t) => t.title);
  ok(favOrder.length === 2 && favOrder[0] === '夜曲',
    'A13 收藏夹 2 首，最近收藏的排最前（卡片默认播放列表）', JSON.stringify(favOrder));

  br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await br.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(lg.j.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 200)));

  // ---------- B. 首页卡片渲染 ----------
  await p.goto(`${B}/#/`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.dash-card', { timeout: 20000 });
  await sleep(800);
  ok((await p.locator('.dash-card', { hasText: '音乐播放器' }).count()) === 1, 'B1 首页出现「音乐播放器」卡片');
  ok(await p.locator('.mcard').count() === 1, 'B2 MusicCard 组件已挂载（异步 chunk 加载成功）');
  const pills = await p.locator('.mcard .pill').allInnerTexts();
  ok(pills.length === 2 && pills[0].includes('收藏夹') && pills[1].includes('全部曲库'),
    'B3 两个来源药丸（收藏夹 / 全部曲库）', JSON.stringify(pills));
  ok((await p.locator('.mcard .pill.on').innerText()).includes('收藏夹'), 'B4 默认选中「收藏夹」');
  ok((await p.locator('.mcard .line .t').innerText()).trim() === '未在播放', 'B5 未播放时标题「未在播放」');
  ok((await p.locator('.mcard .disc.mspin').count()) === 0, 'B6 未播放时唱片不转（mspin 只在播放时加）');
  let tt = await p.locator('.mcard .prow .tm').allInnerTexts();
  ok(tt.length === 2 && tt[0].trim() === '0:00' && tt[1].trim() === '-0:00',
    'B7 进度两侧 = 播放时长 / 未播放时长（剩余带 - 前缀）', JSON.stringify(tt));
  ok((await p.locator('.mcard .ll.dim').innerText()).includes('收藏夹'),
    'B8 空队列时歌词位给引导文案（提到收藏夹/全部曲库）');

  // ---------- C. 起播（默认收藏夹）＋ 转速与悬浮条一致 ----------
  await p.locator('.mcard .ctrl .cbtn.big').click(); // 队列空 → 用选中来源起播
  await p.waitForTimeout(900);
  ok((await p.locator('.mcard .line .t').innerText()).trim() === favOrder[0],
    'C1 卡片「播放」从收藏夹第 1 首起播', favOrder[0]);
  ok((await p.locator('.mcard .disc.mspin').count()) === 1, 'C2 播放中唱片带 mspin（转起来）');
  // 需求第 1 条：转速必须与下方悬浮栏的唱片一样 → 两个元素同时读，一次断言
  // 右下角悬浮按钮：.float-ai 有两个（音乐 / AI 助手），按 title 认「播放条」那个
  await p.locator('.float-ai[title*="播放条"]').click(); // 展开底部悬浮播放条
  await p.waitForSelector('.mcbar .disc.mspin', { timeout: 8000 });
  // 动效加在 img / .noimg 上（有封面走 img，没封面走 .noimg），两种都兜住
  const spinDur = (discSel) => p.locator(discSel).evaluate((el) => {
    const c = el.querySelector('img') || el.querySelector('.noimg');
    return c ? getComputedStyle(c).animationDuration : 'none';
  });
  const dCard = await spinDur('.mcard .disc.mspin');
  const dBar = await spinDur('.mcbar .disc.mspin');
  ok(dCard === '30s' && dBar === '30s', 'C3 卡片唱片与底部悬浮条唱片转速一致，都是 30s/圈', `卡片=${dCard} 悬浮条=${dBar}`);
  ok((await p.locator('.mcard .line .t').innerText()).trim() === (await p.locator('.mcbar .mid .t').innerText()).trim(),
    'C4 卡片与悬浮条显示同一首歌（共用同一个播放器）');

  // ---------- D. 两行歌词随播放前进 ----------
  await sleep(2600); // pos ≈ 3.5s：第二行(2.0s)是当前行
  let top = (await p.locator('.mcard .ll.top').innerText()).trim();
  let bot = (await p.locator('.mcard .ll.bot').innerText()).trim();
  ok(top === '第一句歌词' && bot === '第二句歌词',
    'D1 歌词两行 = 上一行 + 当前行（pos≈3.5s：第一句/第二句）', `${top} / ${bot}`);
  ok((await p.locator('.mcard .ll.bot.cur').count()) === 1, 'D2 当前行有高亮 class', bot);
  await sleep(2200); // pos ≈ 5.7s：第三行(4.0s)成为当前行
  top = (await p.locator('.mcard .ll.top').innerText()).trim();
  bot = (await p.locator('.mcard .ll.bot').innerText()).trim();
  ok(top === '第二句歌词' && bot === '第三句歌词', 'D3 随播放逐行下移（第二句/第三句）', `${top} / ${bot}`);
  // 可选留档：E2E_SHOT=<路径> 时把播放中（含歌词/封面/进度）的卡片截下来
  if (process.env.E2E_SHOT) {
    await p.locator('.dash-card', { hasText: '音乐播放器' }).screenshot({ path: process.env.E2E_SHOT });
    console.log(`  · 已截图：${process.env.E2E_SHOT}`);
  }

  // ---------- E. 进度条：已播递增、剩余递减、可拖拽 seek ----------
  ok(await p.locator('.mcard .pbar').getAttribute('draggable') === 'false',
    'E1 进度条 draggable=false（拖动 seek 不会把整张卡片拖走）');
  const t1 = secOf(await p.locator('.mcard .prow .tm').first().innerText());
  const r1 = secOf((await p.locator('.mcard .prow .tm').last().innerText()).replace('-', ''));
  // 右侧若错写成「总长」，t1+r1 会 ≈ 34 而不是 30——这条同时验「右边是剩余」和「两边加起来=全曲」
  ok(t1 >= 2 && Math.abs(t1 + r1 - 30) <= 1, 'E2 已播 + 未播放 ≈ 总长 30s（右边是剩余，不是总长）', `${t1}/${r1}`);
  const box = await p.locator('.mcard .pbar').boundingBox();
  await p.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2); // 点一半 → seek 到 ~15s
  await p.waitForTimeout(400);
  const t2 = secOf(await p.locator('.mcard .prow .tm').first().innerText());
  ok(t2 >= 14 && t2 <= 17, 'E3 点进度条中点 → seek 到 ~15s', String(t2));

  // ---------- F. 按钮组：暂停/下一曲/上一曲/音量 ----------
  await p.locator('.mcard .ctrl .cbtn.big').click(); // 暂停
  await p.waitForTimeout(400);
  ok((await p.locator('.mcard .disc.mspin').count()) === 0, 'F1 暂停后唱片停转');
  ok((await p.locator('.mcard .ctrl .cbtn.big .material-icons').innerText()).trim() === 'play_arrow', 'F2 暂停后按钮变播放图标');
  // 共用播放器双向验证：卡片按暂停，底部悬浮条同步
  ok((await p.locator('.mcbar .ctrl .cbtn.big .material-icons').innerText()).trim() === 'play_arrow',
    'F3 卡片上暂停 → 底部悬浮条同步显示为「已暂停」（同一份状态）');
  await p.locator('.mcard .ctrl .cbtn.big').click(); // 继续播
  await p.waitForTimeout(300);
  ok((await p.locator('.mcbar .ctrl .cbtn.big .material-icons').innerText()).trim() === 'pause',
    'F4 卡片上继续播放 → 悬浮条同步为「播放中」');
  await p.locator('.mcard .ctrl .cbtn').nth(2).click(); // 下一曲（顺序：上一曲/播放暂停/下一曲/静音）
  await p.waitForTimeout(700);
  ok((await p.locator('.mcard .line .t').innerText()).trim() === favOrder[1], 'F5 下一曲 → 收藏夹第 2 首', favOrder[1]);
  await p.locator('.mcard .ctrl .cbtn').nth(0).click(); // 上一曲（刚起播 pos<3 直接回上一首）
  await p.waitForTimeout(700);
  ok((await p.locator('.mcard .line .t').innerText()).trim() === favOrder[0], 'F6 上一曲 → 回到第 1 首');
  const vol = p.locator('.mcard .ctrl input[type="range"]');
  ok(await vol.getAttribute('draggable') === 'false', 'F7 音量滑杆 draggable=false（拉滑杆不会拖走卡片）');
  await vol.fill('0.42');
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => localStorage.getItem('mc_volume')) === '0.42',
    'F8 音量滑杆改 musicState.volume 并落 localStorage（与悬浮条同一份）');

  // ---------- G. 切「全部曲库」（切换即换队列起播） ----------
  await p.locator('.mcard .pill', { hasText: '全部曲库' }).click();
  await p.waitForTimeout(1200);
  ok((await p.locator('.mcard .pill.on').innerText()).includes('全部曲库'), 'G1 药丸选中态切到「全部曲库」');
  ok(await p.evaluate(() => localStorage.getItem('mc_cardsrc')) === 'all', 'G2 来源选择已记住（mc_cardsrc=all）');
  ok((await p.locator('.mcard .line .t').innerText()).trim() === '夜曲',
    'G3 全部曲库按 path 序从第 1 首起播');
  ok((await p.locator('.mcard .disc.mspin').count()) === 1, 'G4 换来源后继续播放（唱片继续转）');
  await p.locator('.mcard .ctrl .cbtn').nth(2).click(); // 下一曲 → 全库第 2 首
  await p.waitForTimeout(700);
  ok((await p.locator('.mcard .line .t').innerText()).trim() === '无人声', 'G5 全库队列可下一曲（3 首都在队列里）');

  // ---------- H. 换页不断播 / 卡片照实还原 ----------
  await p.goto(`${B}/#/tools`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.goto(`${B}/#/`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.mcard', { timeout: 15000 });
  await p.waitForTimeout(700);
  ok((await p.locator('.mcard .line .t').innerText()).trim() === '无人声',
    'H1 离开首页再回来，卡片照实显示仍在播的那首（播放不因换页中断）');
  ok(secOf(await p.locator('.mcard .prow .tm').first().innerText()) > 0, 'H2 进度还在往前走（不是从 0 重来）');
  ok(await p.evaluate(() => localStorage.getItem('mc_cardsrc')) === 'all', 'H3 来源选择重载后仍记住「全部曲库」');

  // ---------- I. 个人隐藏（看板模块设置） ----------
  const hide = await api('POST', '/api/dashboard/hidden', { token: T, body: { hidden: ['music'] } });
  ok(hide.status === 200 && hide.j.hidden.includes('music'), 'I1 个人隐藏 music');
  await p.goto(`${B}/#/tools`, { waitUntil: 'domcontentloaded' });
  await p.goto(`${B}/#/`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.dash-card', { timeout: 15000 });
  await p.waitForTimeout(900);
  ok((await p.locator('.mcard').count()) === 0, 'I2 个人隐藏后首页不再渲染音乐播放器卡片');
  await api('POST', '/api/dashboard/hidden', { token: T, body: { hidden: [] } });
  ok(true, 'I3 还原个人隐藏');

  ok(perr.length === 0, 'J1 全程无前端 JS 报错', perr.join(' | '));
} catch (e) {
  failed++;
  console.error('  ✗ 异常：', e.message);
} finally {
  try { if (br) await br.close(); } catch { /* 忽略 */ }
  try { server.kill(); } catch { /* 忽略 */ }
  try { lrclib.close(); } catch { /* 忽略 */ }
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄迟滞 */ }
  try { fs.rmSync(MUSIC, { recursive: true, force: true }); } catch { /* 同上 */ }
}

console.log(`\n${failed === 0 ? '全绿' : '有失败'}：${passed} 通过 / ${failed} 失败`);
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 50).unref();
