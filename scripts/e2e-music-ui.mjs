// E2E（v1.16.0）：音乐 tab 的浏览器界面——面板/目录树/歌曲卡、底部悬浮播放条、➕待播、
// 播放列表与收藏弹框、歌词弹框（LRCLIB 本地桩）、全屏满屏播放（主色渐变/倍速/延时/停止）、
// 右下角「音乐」悬浮按钮、整页不限宽（.main.main-full）、切页签不断播。
//
// 音频是真可解码的：ID3 + 若干「全零 MPEG1 Layer3 帧」（417B/帧，静音——Chromium 能解，
// timeupdate 会走），这样进度条/歌词高亮/播放暂停图标都能真验，而不是只看静态 DOM。
// 隔离 DATA_DIR + 系统临时区音乐目录，绝不碰 data/ 根与真实曲库。
//   node scripts/e2e-music-ui.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3197;
const B = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(tmpdir(), 'wb-music-ui-'));

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 合成素材：真可解码的 JPEG + 静音 MP3 ----------
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

const MUSIC = fs.mkdtempSync(path.join(tmpdir(), 'mcmusic-ui-'));
fs.mkdirSync(path.join(MUSIC, '专辑A'));
fs.mkdirSync(path.join(MUSIC, '专辑B'));
fs.writeFileSync(path.join(MUSIC, '专辑A', 'A1.mp3'), Buffer.concat([id3({ TIT2: '夜曲', TPE1: '周杰伦', TALB: '十一月的萧邦' }, true), SILENCE]));
fs.writeFileSync(path.join(MUSIC, '专辑A', 'B2 - 无人声.mp3'), Buffer.concat([id3({ TIT2: '无人声', TPE1: 'B2' }, false), SILENCE]));
fs.writeFileSync(path.join(MUSIC, '专辑B', '老歌 - 无标签.mp3'), SILENCE);
fs.writeFileSync(path.join(MUSIC, '专辑B', 'cover.jpg'), JPEG);
const MUSIC_NORM = MUSIC.replace(/\\/g, '/');

// ---------- 假 LRCLIB：get 命中同步歌词（省一步 search） ----------
const lrclib = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.startsWith('/api/get')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ syncedLyrics: '[00:00.60]夜曲第一行\n[00:09.00]夜曲第二行', plainLyrics: '夜曲第一行\n夜曲第二行' }));
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

let br = null;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'A0 admin 登录拿到 token');
  ok((await api('POST', '/api/mc/settings', { token: T, body: { root: MUSIC_NORM } })).status === 200, 'A1 预配音乐路径');
  const sc = await api('POST', '/api/mc/scan', { token: T, body: {} });
  ok(sc.j.ok === true && sc.j.added === 3, 'A2 预扫描 3 首入库', JSON.stringify(sc.j).slice(0, 120));

  br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await br.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(lg.j.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 200)));

  // ---------- A. 设置页：视频路径改名 + 音乐路径卡在下方 ----------
  await p.goto(`${B}/#/settings`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.masonry h3', { timeout: 20000 });
  const h3s = (await p.locator('.masonry h3').allInnerTexts()).map((s) => s.trim());
  ok(h3s.includes('视频路径') && !h3s.includes('人工智能视频路径'), 'A3 「人工智能视频路径」已改名「视频路径」', h3s.join('|'));
  ok(h3s.includes('音乐路径'), 'A4 设置页有「音乐路径」卡', h3s.join('|'));
  ok(h3s.indexOf('视频路径') < h3s.indexOf('音乐路径'), 'A5 音乐路径排在视频路径下面', h3s.join('|'));

  // ---------- B. 音乐面板：统计卡 + 目录树 + 歌曲多列卡 + 整页不限宽 ----------
  await p.goto(`${B}/#/smart-home?tab=music`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.mc-body', { timeout: 20000 });
  await sleep(600);
  const stats = await p.locator('.mc-stat').allInnerTexts();
  ok(stats.length === 4 && stats[0].includes('3') && stats[0].includes('歌曲数量')
    && stats[1].includes('2') && stats[1].includes('已有封面')
    && stats[2].includes('1') && stats[2].includes('未匹配封面')
    && stats[3].includes('1') && stats[3].includes('待处理'),
    'B1 四张统计卡：3/2/1/1（歌曲/已有封面/未匹配/待处理）', JSON.stringify(stats));
  ok((await p.locator('.mc-left .tree .tree-root').innerText()).includes('全部音乐'), 'B2 目录树根节点「全部音乐」');
  let rows = await p.locator('.mc-left .tree .row .name').allInnerTexts();
  ok(rows.join('|') === '专辑A|专辑B', 'B3 树上两个专辑目录', rows.join('|'));
  ok((await p.locator('.main.main-full').count()) === 1, 'B4 音乐页 .main.main-full（整页不限宽，需求第 1 点）');
  let subdirs = await p.locator('.mc-subdirs button').allInnerTexts();
  ok(subdirs.length === 2 && subdirs[0].includes('专辑A') && subdirs[1].includes('专辑B'), 'B5 根目录默认视图给两个子目录快捷', JSON.stringify(subdirs));

  // 点树节点 专辑A → 右侧切到该目录歌曲
  await p.locator('.mc-left .tree .row', { hasText: '专辑A' }).click();
  await p.waitForSelector('.mc-card', { timeout: 8000 });
  ok((await p.locator('.zone-head').innerText()).includes('专辑A'), 'B6 点树节点右侧切到「专辑A」');
  const cards = p.locator('.mc-card');
  ok((await cards.count()) === 2, 'B7 专辑A 两张歌曲卡');
  const cardTxt = await p.locator('.mc-card', { hasText: '夜曲' }).innerText();
  ok(cardTxt.includes('夜曲') && cardTxt.includes('周杰伦') && cardTxt.includes('十一月的萧邦') && /0:\d\d/.test(cardTxt),
    'B8 卡片显示 歌名/歌手/专辑/时长', cardTxt.replace(/\n/g, '/'));
  ok((await p.locator('.mc-card', { hasText: '夜曲' }).locator('.mc-cover img').count()) === 1
    && (await p.locator('.mc-card', { hasText: '无人声' }).locator('.mc-noimg').count()) === 1,
    'B9 有封面显图、无封面显占位');
  // v1.16.1：歌曲卡上的悬浮按钮从 1 个变 2 个——「加入播放列表待播」(.mc-add-queue) 与「加入我的收藏」(.mc-add)
  ok((await p.locator('.mc-card').first().locator('.mc-add-queue').count()) === 1
    && (await p.locator('.mc-card').first().locator('.mc-add[title^="加入我的收藏"]').count()) === 1,
    'B10 歌曲卡带 ➕ 加入待播按钮 与 ♡ 收藏按钮');

  // ---------- B11~B25. 歌手视图（v1.16.7）：左栏歌手 → 右栏该歌手的专辑 → 点专辑出歌单 ----------
  // 右栏到底渲染的是「专辑卡」还是「歌曲卡」，靠 .mc-dur 的形态区分（专辑卡=N 首 / 歌曲卡=0:27）
  const waitAlbums = (n) => p.waitForFunction((k) => {
    const cards = document.querySelectorAll('.zone .mc-card');
    return cards.length === k && /首$/.test((cards[0].querySelector('.mc-dur') || {}).textContent?.trim() || '');
  }, n, { timeout: 8000 });
  const waitSongs = (n) => p.waitForFunction((k) => {
    const cards = document.querySelectorAll('.zone .mc-card');
    return cards.length === k && /^\d+:\d\d$/.test((cards[0].querySelector('.mc-dur') || {}).textContent?.trim() || '');
  }, n, { timeout: 8000 });

  ok((await p.locator('.mc-modes button', { hasText: '目录' }).getAttribute('class')).includes('pri'),
    'B11 左栏新增「目录/歌手」切换键，默认停在「目录」');
  await p.locator('.mc-modes button', { hasText: '歌手' }).click();
  await p.waitForSelector('.mc-artists .ar-row', { timeout: 8000 });
  const arNames = await p.locator('.mc-artists .ar-row .ar-name').allInnerTexts();
  ok(arNames.length === 3 && ['周杰伦', 'B2', '老歌'].every((n) => arNames.includes(n)),
    'B12 切到歌手模式：左栏列出 3 位歌手', arNames.join('|'));
  ok((await p.locator('.mc-artists .tree-root').innerText()).includes('全部歌手（3）'),
    'B13 左栏第一行是「全部歌手（3）」');
  ok((await p.locator('.mc-artists .ar-row', { hasText: '周杰伦' }).locator('.ar-num').innerText()) === '1 首 · 1 张',
    'B14 每位歌手行带「N 首 · M 张」');
  await waitAlbums(3);
  ok((await p.locator('.zone-head').innerText()).includes('全部歌手')
    && (await p.locator('.zone-head').innerText()).includes('3 张专辑'),
    'B15 「全部歌手」时右栏摊平全部 3 张专辑');
  await p.locator('.mc-artists .ar-row', { hasText: '周杰伦' }).click();
  await waitAlbums(1);
  ok((await p.locator('.mc-card .mc-title').innerText()) === '十一月的萧邦'
    && (await p.locator('.mc-artists .ar-row', { hasText: '周杰伦' }).getAttribute('class')).includes('sel'),
    'B16 点歌手「周杰伦」→ 右栏只剩他这 1 张专辑，左栏该行高亮');
  ok((await p.locator('.zone-head').innerText()).includes('周杰伦 的专辑'), 'B17 右栏标题跟着切到「周杰伦 的专辑」');
  await p.locator('.mc-card', { hasText: '十一月的萧邦' }).click();
  await waitSongs(1);
  ok((await p.locator('.mc-card .mc-title').innerText()) === '夜曲'
    && (await p.locator('.zone-head').innerText()).includes('十一月的萧邦'),
    'B18 点专辑 → 右栏出这张专辑的歌单（1 首：夜曲）');
  ok((await p.locator('.zone-head button', { hasText: '返回专辑' }).count()) === 1, 'B19 专辑层出现「返回专辑」键');
  await p.locator('.zone-head button', { hasText: '返回专辑' }).click();
  await waitAlbums(1);
  ok((await p.locator('.zone-head button', { hasText: '全部专辑' }).count()) === 1, 'B20 返回专辑层（回到该歌手的专辑列表）');
  await p.locator('.zone-head button', { hasText: '全部专辑' }).click();
  await waitAlbums(3);
  ok((await p.locator('.zone-head button', { hasText: '全部专辑' }).count()) === 0,
    'B21 再返回一层 = 全部歌手（3 张专辑，返回键消失）');
  await p.locator('.mc-artists .ar-row', { hasText: 'B2' }).click();
  await waitAlbums(1);
  ok((await p.locator('.mc-card .mc-title').innerText()) === '未知专辑',
    'B22 没有专辑标签的歌归入「未知专辑」档（与「没选专辑」是两回事）');
  // 服务端契约：两个新端点（没有新表，全部 GROUP BY 自 mc_tracks 的 artist/album 列）
  const arApi = await api('GET', '/api/mc/artists', { token: T });
  const zjl = (arApi.j.artists || []).find((a) => a.name === '周杰伦') || {};
  ok(arApi.status === 200 && (arApi.j.artists || []).length === 3 && arApi.j.total === 3
    && zjl.albums && zjl.albums[0].name === '十一月的萧邦' && arApi.j.unknown_label === '未知歌手',
    'B23 /api/mc/artists：3 位歌手、专辑挂在歌手下面', JSON.stringify((arApi.j.artists || []).map((a) => a.name)));
  const alApi = await api('GET', `/api/mc/album-tracks?artist=${encodeURIComponent('周杰伦')}&album=${encodeURIComponent('十一月的萧邦')}`, { token: T });
  ok(alApi.status === 200 && alApi.j.tracks.length === 1 && alApi.j.tracks[0].title === '夜曲'
    && alApi.j.tracks[0].fav === false,
    'B24 /api/mc/album-tracks：按 歌手+专辑 精确取回该专辑的 1 首并带上收藏态');
  // 切回目录视图（C 段仍按原来那条路点歌，右栏必须回到「专辑A」的 2 首）
  await p.locator('.mc-modes button', { hasText: '目录' }).click();
  await waitSongs(2);
  ok((await p.locator('.zone-head').innerText()).includes('专辑A'),
    'B25 切回目录视图，右栏回到「专辑A」的 2 首');

  // ---------- C. 点歌 → 底部浮起播放条（需求第 5/6 点） ----------
  await p.locator('.mc-card', { hasText: '夜曲' }).click();
  await p.waitForSelector('.mcbar', { timeout: 8000 });
  ok((await p.locator('.mcbar .t').innerText()) === '夜曲', 'C1 点歌浮出播放条，歌名=夜曲');
  ok((await p.locator('.mcbar .a').innerText()).includes('周杰伦') && (await p.locator('.mcbar .a').innerText()).includes('十一月的萧邦'),
    'C2 条上显示 歌手 · 专辑');
  for (const t of ['上一曲', '下一曲', '歌词']) {
    ok((await p.locator(`.mcbar button[title*="${t}"]`).count()) >= 1, `C3 播放条有「${t}」键`);
  }
  ok((await p.locator('.mcbar .fx button[title="静音"]').count()) === 1
    && (await p.locator('.mcbar .fx input[title="音量"]').count()) === 1, 'C3b 播放条有音量键（静音钮 + 音量条）');
  // 右下角悬浮面板必须已上移让位（否则盖住 音量/列表/歌词/收起 这排键——首轮实测就是这么挂的）
  ok((await p.locator('.float-search.bar-up').count()) === 1, 'C3c 播放条浮起时右下角悬浮面板上移让位');
  // 真播放：静音帧可解码 → playing=true → 大键变暂停、唱片 spin、进度走字
  //（图标 v1.16.1 起一律 Material Icons 单色连字：textContent 就是连字名 pause / play_arrow）
  let playing = true;
  try {
    await p.waitForFunction(() => (document.querySelector('.mcbar .ctrl .big') || {}).textContent?.includes('pause'), null, { timeout: 8000 });
  } catch { playing = false; }
  ok(playing, 'C4 <audio> 真播起来（大键变 pause）——全零静音帧可解码');
  if (playing) {
    // C5（v1.16.4 加强）：唱片必须真的在「慢慢转」——容器 div 自己**不许有动画**
    // （全局工具类 .spin 是 1s/圈的加载动画，命中容器就会把图片的 60s/圈盖掉，
    //   v1.16.1 的「唱片没变慢」就是这个原因），只有图片/占位图标转、且时长 ≥ 30s
    const discAnim = await p.locator('.mcbar .disc').evaluate((el) => {
      const rest = getComputedStyle(el);
      const inner = el.querySelector('img, .noimg');
      const is = inner ? getComputedStyle(inner) : null;
      return { cls: el.className, restName: rest.animationName, inName: is ? is.animationName : '', inDur: is ? is.animationDuration : '' };
    });
    console.log('     —— 唱片动画实测：', JSON.stringify(discAnim));
    ok(discAnim.cls.includes('mspin') && discAnim.restName === 'none' && !discAnim.cls.split(/\s+/).includes('spin'),
      'C5a 唱片容器自身无动画（不再被全局 .spin 抢占）');
    // C5b（v1.16.7）：钉死 30s/圈——「稍微快一点」把 60s 减半，这里跟到 30，
    // 上下限都卡死，免得日后又被悄悄改回 60s 或掉进 1s/圈。
    ok(/mcspin/.test(discAnim.inName) && parseFloat(discAnim.inDur) === 30,
      `C5b 唱片图片 30s/圈慢转（${discAnim.inName} ${discAnim.inDur}）`);
    let posAdvanced = false;
    try {
      await p.waitForFunction(() => (document.querySelector('.mcbar .prow .tm') || {}).textContent !== '0:00', null, { timeout: 8000 });
      posAdvanced = true;
    } catch { /* 保持 false */ }
    ok(posAdvanced, 'C6 进度条已播时间在走');
  }

  // ---------- D. ➕ 待播 / 播放列表弹框 / 收藏 ----------
  await p.locator('.mc-card', { hasText: '无人声' }).locator('.mc-add-queue').click();
  await sleep(400);
  ok((await p.locator('.zone-head').innerText()).includes('加入待播'), 'D1 ➕ 后提示「加入待播」');
  await p.locator('.mcbar button[title="播放列表 / 我的收藏"]').click();
  await p.waitForSelector('.mcbar .plist', { timeout: 5000 });
  ok((await p.locator('.mcbar .plist .ly-head').innerText()).includes('播放列表（2）'), 'D2 播放列表弹框：队列 2 首');
  let plRows = await p.locator('.mcbar .pl-row').allInnerTexts();
  ok(plRows.length === 2 && plRows[0].includes('play_arrow') && plRows[0].includes('夜曲') && plRows[1].includes('无人声'),
    'D3 队列顺序：夜曲（正在播 play_arrow）→ 无人声（待播）', JSON.stringify(plRows));

  const heart = p.locator('.mcbar .fx button[title^="收藏"]');
  ok((await heart.innerText()) === 'favorite_border', 'D4 收藏心初始未收藏（favorite_border）');
  await heart.click();
  // 必须精确等于 favorite——includes('favorite') 对 favorite_border 也成立，那样等于没断言
  await p.waitForFunction(() => (document.querySelector('.mcbar .fx button[title^="收藏"]') || {}).textContent?.trim() === 'favorite', null, { timeout: 5000 });
  ok(true, 'D5 点心变 favorite（已收藏）');
  await p.locator('.mcbar .plist .ly-head button', { hasText: '我的收藏' }).click();
  await sleep(400);
  let favRows = await p.locator('.mcbar .plist .pl-row').allInnerTexts();
  ok(favRows.length === 1 && favRows[0].includes('夜曲'), 'D6 我的收藏视图里 1 首=夜曲', JSON.stringify(favRows));
  ok((await p.locator('.mcbar .plist .ly-head button.pri').innerText()).includes('我的收藏（1）'),
    'D6b 我的收藏视图处于选中态（.pri）');
  const favApi = await api('GET', '/api/mc/favorites', { token: T });
  ok(favApi.j.tracks?.length === 1 && favApi.j.tracks[0].title === '夜曲', 'D7 服务端收藏库核对：1 首夜曲');
  await heart.click(); // 已收藏再点 = 进收藏夹视图（双职责）
  await sleep(300);
  ok((await p.locator('.mcbar .plist .ly-head button.pri').innerText()).includes('我的收藏'),
    'D8 已收藏再点心=停在收藏夹（不取消收藏）');
  await p.locator('.mcbar .plist .ly-head button', { hasText: '播放列表' }).click();
  await p.locator('.mcbar .plist .ly-head button', { hasText: 'close' }).click();

  // ---------- E. 歌词弹框（LRCLIB 桩，逐行高亮） ----------
  await p.locator('.mcbar button[title="歌词"]').click();
  await p.waitForSelector('.mcbar .lyrics', { timeout: 5000 });
  await p.waitForFunction(() => (document.querySelector('.mcbar .lyrics .ly-lines') || {}).children?.length >= 2, null, { timeout: 8000 });
  const lrc = await p.locator('.mcbar .lyrics .ly-lines p').allInnerTexts();
  ok(lrc.join('|').includes('夜曲第一行') && lrc.join('|').includes('夜曲第二行'), 'E1 歌词弹框展示桩返回的两行', lrc.join('|'));
  if (playing) {
    let hi = false;
    try {
      await p.waitForFunction(() => document.querySelector('.mcbar .lyrics .ly-lines p.cur') !== null, null, { timeout: 6000 });
      hi = true;
    } catch { /* 保持 false */ }
    ok(hi, 'E2 随播放当前行高亮（.cur）');
  }
  await p.locator('.mcbar .lyrics .ly-head button', { hasText: '关闭' }).click();

  // ---------- F. 循环切换 + 进度条拖点 ----------
  // 循环键 = .fx 第一个按钮（[title*=全角括号] 的 CSS 属性选择器在 Playwright 里解析不出来，别用）
  const loopBtn = p.locator('.mcbar .fx button').first();
  ok((await loopBtn.getAttribute('title')).includes('点击切换'), 'F0 循环键在 .fx 首位（title 带切换提示）',
    await loopBtn.getAttribute('title'));
  const seq = [];
  for (let i = 0; i < 3; i++) { await loopBtn.click(); seq.push(await loopBtn.innerText()); }
  ok(seq.join('→') === 'repeat_one→repeat→arrow_forward', 'F1 循环键三连击：单曲→列表→顺序（Material 单色图标）', seq.join('→'));
  if (playing) {
    const bb = await p.locator('.mcbar .pbar').boundingBox();
    await p.mouse.click(bb.x + bb.width * 0.08, bb.y + bb.height / 2); // 拖回 8%（≈2.4s）
    await sleep(500);
    const tm = await p.locator('.mcbar .prow .tm').first().innerText();
    ok(/^(0:0|0:1|0:2)/.test(tm), 'F2 点进度条 8% 处真 seek（已播回到 0:0x）', tm);
  }

  // ---------- G. 全屏满屏播放（需求第 7 点） ----------
  // 唱片持续 spin 动画会让 Playwright 判「element is not stable」等满 30s——真人点旋转唱片毫无障碍，
  // 这里 force 跳过稳定性等待（定位仍唯一，事件照常真实派发）
  await p.locator('.mcbar .disc').click({ force: true });
  await p.waitForSelector('.mcfull', { timeout: 5000 });
  ok((await p.locator('.mcfull .tt').innerText()) === '夜曲', 'G1 点唱片展开全屏，歌名=夜曲');
  const bg = await p.locator('.mcfull').evaluate((el) => el.style.background);
  ok(bg.includes('gradient'), 'G2 全屏背景是渐变（主色或暗色回落）', bg.slice(0, 80));
  ok((await p.locator('.mcfull .fdisc').count()) === 1 && (await p.locator('.mcfull .flines, .mcfull .fplain').count()) >= 1,
    'G3 左唱片 + 右歌词');
  // G3b（v1.16.4）：放大唱片同样只许图片慢转，容器不得被全局 .spin（1s/圈）抢占
  const fdiscAnim = await p.locator('.mcfull .fdisc').evaluate((el) => {
    const inner = el.querySelector('img, .noimg');
    return { cls: el.className, restName: getComputedStyle(el).animationName, inName: inner ? getComputedStyle(inner).animationName : '', inDur: inner ? getComputedStyle(inner).animationDuration : '' };
  });
  console.log('     —— 全屏唱片动画实测：', JSON.stringify(fdiscAnim));
  // G3b（v1.16.7）：全屏唱片钉死 35s/圈（与底部播放条 30s 同节奏的另一处）
  ok(fdiscAnim.cls.includes('mspin') && fdiscAnim.restName === 'none' && /mcspin2/.test(fdiscAnim.inName) && parseFloat(fdiscAnim.inDur) === 35,
    `G3b 放大唱片也是慢转（容器无动画 / 图片 ${fdiscAnim.inName} ${fdiscAnim.inDur}）`);
  const playBox = await p.locator('.mcfull .cbtn.play').boundingBox();
  ok(playBox && playBox.width >= 70, 'G4 大播放键比普通键大（≥70px）', playBox && String(playBox.width));
  const subTxt = await p.locator('.mcfull .crow.sub').innerText();
  ok(/1x/.test(subTxt) && subTxt.includes('favorite') && subTxt.includes('queue_music')
    && subTxt.includes('timer') && subTxt.includes('stop'),
    'G5 下排有 收藏/列表/倍速/音量/延时/停止', subTxt.replace(/\n/g, '/'));
  await p.locator('.mcfull .crow.sub button', { hasText: '1x' }).click();
  ok((await p.locator('.mcfull .crow.sub button', { hasText: '1.25x' }).count()) === 1, 'G6 倍速 1x → 1.25x');
  ok((await p.evaluate(() => localStorage.getItem('mc_rate'))) === '1.25', 'G7 倍速记忆到 localStorage(mc_rate)');
  await p.locator('.mcfull .crow.sub button[title^="延时"]').click();
  await p.waitForSelector('.mcfull .fsleep', { timeout: 4000 });
  const sleepBtns = await p.locator('.mcfull .fsleep .sk-row button').allInnerTexts();
  ok(sleepBtns.join('|').includes('15 分钟') && sleepBtns.join('|').includes('90 分钟'), 'G8 延时停止给 15/30/60/90 分钟', sleepBtns.join('|'));
  await p.locator('.mcfull .fsleep .sk-row button', { hasText: '15 分钟' }).click();
  await p.waitForSelector('.mcfull .sleeptip', { timeout: 4000 });
  ok((await p.locator('.mcfull .sleeptip').innerText()).includes('延时停止'), 'G9 选 15 分钟出现剩余提示');
  await p.locator('.mcfull .crow.sub button[title^="延时"]').click();
  await p.locator('.mcfull .fsleep .sk-row button', { hasText: '取消' }).click();
  ok((await p.locator('.mcfull .sleeptip').count()) === 0, 'G10 取消延时提示消失');
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-music-ui-full.png') });
  // ESC 收全屏（回悬浮条）
  await p.keyboard.press('Escape');
  await sleep(400);
  ok((await p.locator('.mcfull').count()) === 0 && (await p.locator('.mcbar').count()) === 1, 'G11 ESC 收全屏、悬浮条还在');
  // 停止键：全屏+悬浮条一起收
  await p.locator('.mcbar .disc').click({ force: true });
  await p.waitForSelector('.mcfull', { timeout: 4000 });
  await p.locator('.mcfull .crow.sub button[title^="停止"]').click(); // ^锚定：避开「延时停止」
  await sleep(400);
  ok((await p.locator('.mcfull').count()) === 0 && (await p.locator('.mcbar').count()) === 0, 'G12 停止后全屏与悬浮条都收起');
  ok((await p.locator('.float-search.bar-up').count()) === 0, 'G13 播放条收起后右下角悬浮面板落回原位');

  // ---------- H. 右下角「音乐」悬浮按钮（需求第 6 点：排在 AI助手 前面） ----------
  const floatBtns = await p.locator('.float-search > *').allInnerTexts();
  const iMusic = floatBtns.findIndex((t) => t.includes('音乐'));
  const iAi = floatBtns.findIndex((t) => t.includes('AI助手'));
  ok(iMusic >= 0 && iAi >= 0 && iMusic < iAi, 'H1 「音乐」按钮在「AI助手」前面', JSON.stringify(floatBtns));
  await p.locator('.float-search .float-ai', { hasText: '音乐' }).click();
  await p.waitForSelector('.mcbar', { timeout: 5000 });
  ok((await p.locator('.mcbar .t').innerText()) === '夜曲' && (await p.locator('.mcbar .ctrl .big').innerText()) === 'play_arrow',
    'H2 再浮起：队列还在（夜曲，暂停态 play_arrow）');
  ok((await p.locator('.float-search.bar-up').count()) === 1, 'H2b 悬浮面板再次上移让位');
  if (playing) {
    await p.locator('.mcbar .ctrl .big').click();
    let resumed = false;
    try {
      await p.waitForFunction(() => (document.querySelector('.mcbar .ctrl .big') || {}).textContent?.includes('pause'), null, { timeout: 6000 });
      resumed = true;
    } catch { /* 保持 false */ }
    ok(resumed, 'H3 暂停后按播放能接着播');
  }

  // ---------- I. 切页签：不限宽开关回落 + 播放条不断播 ----------
  await p.getByRole('button', { name: '米家', exact: true }).click();
  await sleep(900);
  ok((await p.locator('.main.main-full').count()) === 0, 'I1 切走音乐页 .main-full 回落（1200px 封顶恢复）');
  ok((await p.locator('.mcbar').count()) === 1, 'I2 播放条跨页签常驻（musicState 单例）');
  await p.getByRole('button', { name: '音乐', exact: true }).click();
  await p.waitForSelector('.mc-body', { timeout: 8000 });
  ok((await p.locator('.main.main-full').count()) === 1, 'I3 切回音乐页恢复不限宽');
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-music-ui-panel.png'), fullPage: true });

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
