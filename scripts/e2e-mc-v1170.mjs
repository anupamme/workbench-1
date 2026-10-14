// E2E（v1.17.0）：音乐封面刮削 + 悬浮桌面歌词 全链路——纯 API + 安装包解剖，不起浏览器。
//
// 刮削：三渠道（网易/QQ/iTunes）基址全部用 env 指到本机假上游（mcService 里预留的
// MC_SCRAP_NETEASE/QQ/QQ_PIC/ITUNES），假上游回真形状的 JSON + 一台共用的假图床
// （FF D8 开头的合法 JPEG 魔数，引擎只验魔数不解码）。验证：渠道勾选持久化（含显式全关
// 的语义）、每渠道测连通（含坏渠道如实报错）、后台刮削真写盘 + has_cover=3 + /mc/cover 出图。
//
// 悬浮歌词：下载 Windows 安装包（管理员 + Origin 控制回连地址嵌包）→ 用 zipService.extractZip
// 解包 → 逐条目验（setup.ps1 BOM/占位符全替换/字体家族，font.otf ≥8MB，cmd CRLF 无 BOM，
// 说明 txt BOM）→ setup.ps1 只做 PowerShell Parser::ParseFile 语法级校验（**绝不执行安装分支**）。
// 再用包里抠出的 key 走 /mc/agent/poll 全回合：403 无 key / 400 坏设备号 / 注册心跳 / 改名 /
// 单设备显示开关 / nowplaying 上报 → 两拍歌词（首拍空行 kicking、次拍同步两行）/ desk_on
// 总开关 / 字体字号钳制 / 轮换 key 新旧切换 / 删除后再注册。
//   node scripts/e2e-mc-v1170.mjs
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3199;
const B = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(tmpdir(), 'wb-mc-1170-'));

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假图床：任何 GET 都回一张合法魔数的 JPEG（引擎只验 FF D8，不解码） ----------
const PIC_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1100, 0x41), Buffer.from([0xff, 0xd9])]);
const picHits = [];
const picServer = http.createServer((req, res) => {
  picHits.push(req.url);
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PIC_JPEG.length) });
  res.end(PIC_JPEG);
});
await new Promise((r) => picServer.listen(0, '127.0.0.1', r));
const PJ = picServer.address().port;

// ---------- 假上游三渠道（形状照 mcService.searchChannel 的真实解析路径） ----------
let neteaseFail = false; // 坏渠道开关：测「测试如实报错」用
const neteaseSrv = http.createServer((req, res) => {
  if (neteaseFail) { res.writeHead(500); res.end('boom'); return; }
  if ((req.url || '').startsWith('/api/search/get')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { songs: [{ id: 111, album: { picUrl: `http://127.0.0.1:${PJ}/netease-pic.jpg` } }] } }));
    return;
  }
  if ((req.url || '').startsWith('/api/song/detail')) { // 老接口没回专辑图的补刀路径
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ songs: [{ al: { picUrl: `http://127.0.0.1:${PJ}/netease-detail.jpg` } }] }));
    return;
  }
  res.writeHead(404); res.end();
});
const qqSrv = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/soso/fcgi-bin/client_search_cp')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { song: { list: [{ albumMid: 'ABCD123' }] } } }));
    return;
  }
  res.writeHead(404); res.end();
});
// v1.17.1 酷狗：第一条是歌手头像（singerimg，必须被跳过），第二条才是 imge.kugou.com 专辑封面。
// URL 里塞 imge.kugou.com 当路径段——searchChannel 只做 includes 判断，真实下载走本机假图床。
const kugouSrv = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/song_search_v2')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { lists: [
      { SongName: '晴天', Image: `http://127.0.0.1:${PJ}/singerimg.kugou.com/head/240/{size}.jpg` },
      { SongName: '晴天', Image: `http://127.0.0.1:${PJ}/imge.kugou.com/stdmusic/240/{size}.jpg` },
    ] } }));
    return;
  }
  res.writeHead(404); res.end();
});
const itunesSrv = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/search')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ artworkUrl100: `http://127.0.0.1:${PJ}/itunes/cover100x100bb.jpg` }] }));
    return;
  }
  res.writeHead(404); res.end();
});
for (const s of [neteaseSrv, qqSrv, kugouSrv, itunesSrv]) await new Promise((r) => s.listen(0, '127.0.0.1', r));

// ---------- 假 LRCLIB：pollPayload 的异步歌词补拉会打它 ----------
const lrclib = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/get')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ syncedLyrics: '[00:00.60]夜曲第一行\n[00:09.00]夜曲第二行', plainLyrics: '夜曲第一行\n夜曲第二行' }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lrclib.listen(0, '127.0.0.1', r));

// ---------- 曲库素材：两首无封面歌（ID3 有标签无 APIC → has_cover=0，正是刮削对象） ----------
function id3(texts) {
  const frames = [];
  const fr = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8'), Buffer.from([0])]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    frames.push(Buffer.concat([h, body]));
  };
  for (const [id, text] of Object.entries(texts)) fr(id, text);
  const body = Buffer.concat(frames);
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1'); h[3] = 3;
  h[6] = (body.length >> 21) & 0x7f; h[7] = (body.length >> 14) & 0x7f; h[8] = (body.length >> 7) & 0x7f; h[9] = body.length & 0x7f;
  return Buffer.concat([h, body]);
}
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
const SILENCE = Buffer.concat(Array(10).fill(FRAME)); // 时长够 parseMp4/时长统计用即可，本套不播音频
const MUSIC = fs.mkdtempSync(path.join(tmpdir(), 'mcmusic-1170-'));
fs.mkdirSync(path.join(MUSIC, '专辑A'));
fs.writeFileSync(path.join(MUSIC, '专辑A', 'A1.mp3'), Buffer.concat([id3({ TIT2: '夜曲', TPE1: '周杰伦', TALB: '十一月的萧邦' }), SILENCE]));
fs.writeFileSync(path.join(MUSIC, '专辑A', 'B2 - 无人声.mp3'), Buffer.concat([id3({ TIT2: '无人声', TPE1: 'B2' }), SILENCE]));
const MUSIC_NORM = MUSIC.replace(/\\/g, '/');

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: DATA, TTS_ROOT: path.join(DATA, 'tts'),
    DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456',
    MC_LRCLIB_BASE: `http://127.0.0.1:${lrclib.address().port}`,
    MC_SCRAP_NETEASE: `http://127.0.0.1:${neteaseSrv.address().port}`,
    MC_SCRAP_QQ: `http://127.0.0.1:${qqSrv.address().port}`,
    MC_SCRAP_QQ_PIC: `http://127.0.0.1:${PJ}`,
    MC_SCRAP_KUGOU: `http://127.0.0.1:${kugouSrv.address().port}`, // 光杆主机：验 legacyPath 补 /song_search_v2
    MC_SCRAP_ITUNES: `http://127.0.0.1:${itunesSrv.address().port}`,
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
async function api(method, url, { token, body, headers } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
// agent 轮询（EXEMPT 免登录，key 即凭证）——query 一律 URLSearchParams 编码，中文名才不会打坏
async function pollQ(params) {
  const r = await fetch(`${B}/api/mc/agent/poll?` + new URLSearchParams(params));
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

try {
  // ---------- A. 起服 / 登录 / 配路径 / 扫描 ----------
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'A0 admin 登录拿到 token');
  ok((await api('POST', '/api/mc/settings', { token: T, body: { root: MUSIC_NORM } })).status === 200, 'A1 预配音乐路径');
  const sc = await api('POST', '/api/mc/scan', { token: T, body: {} });
  ok(sc.j.ok === true && sc.j.added === 2, 'A2 扫描入库 2 首', JSON.stringify(sc.j).slice(0, 120));
  const cfg0 = await api('GET', '/api/mc/config', { token: T });
  ok(cfg0.j.stats?.nocover === 2 && cfg0.j.scrape?.pending === 2, 'A3 两首均无封面（nocover=2 / pending=2）', JSON.stringify(cfg0.j.stats));
  ok(Array.isArray(cfg0.j.scrape?.channels) && cfg0.j.scrape.channels.map((c) => c.id).join(',') === 'netease,qq,kugou,kuwo,itunes'
    && cfg0.j.scrape.on.join(',') === 'netease,qq,kugou,kuwo,itunes', 'A4 渠道清单五家与默认全开', JSON.stringify(cfg0.j.scrape?.on));
  const itCh = (cfg0.j.scrape.channels || []).find((c) => c.id === 'itunes') || {};
  const woCh = (cfg0.j.scrape.channels || []).find((c) => c.id === 'kuwo') || {};
  ok(itCh.no_url === true && itCh.url === '' && itCh.rec === '', 'A4a iTunes 按要求保留现有模式（no_url：不出输入框不给推荐）', JSON.stringify(itCh));
  ok(woCh.rec === 'https://kuwo.cn' && (woCh.effective || '').includes('/r.s'), 'A4b 酷我推荐地址=站点根，归一后指向 search.kuwo.cn/r.s', JSON.stringify(woCh));

  // ---------- B. 渠道勾选持久化：顺序保留 / 显式全关是真关 / 全关时 start 如实拒绝 ----------
  const s1 = await api('POST', '/api/mc/settings', { token: T, body: { scrape_on: ['qq', 'netease'] } });
  ok(s1.j.applied?.includes('scrape_on') && s1.j.scrape.on.join(',') === 'qq,netease', 'B1 勾选顺序原样持久化（顺序=优先级）', JSON.stringify(s1.j.scrape?.on));
  await api('POST', '/api/mc/settings', { token: T, body: { scrape_on: [] } });
  const cfg1 = await api('GET', '/api/mc/config', { token: T });
  ok(Array.isArray(cfg1.j.scrape.on) && cfg1.j.scrape.on.length === 0, 'B2 显式存 [] = 全关（不回退成全开）', JSON.stringify(cfg1.j.scrape.on));
  const st0 = await api('POST', '/api/mc/scrape/start', { token: T, body: {} });
  ok(st0.status === 400 && (st0.j.error || '').includes('所有渠道都被关掉了'), 'B3 全关时 start 刮削 400 并如实说明', JSON.stringify(st0.j));
  await api('POST', '/api/mc/settings', { token: T, body: { scrape_on: ['netease', 'qq', 'itunes'] } });

  // ---------- v1.17.1 渠道地址表：保存往返 / 两处「粘贴推荐地址」归一 / 先验后写 ----------
  const chOf = (j, id) => ((j.scrape || {}).channels || []).find((c) => c.id === id) || {};
  const cfg_now_on = (r) => ((r.j.scrape || {}).on || []).join(',');
  const u1 = await api('POST', '/api/mc/settings', { token: T, body: { scrape_urls: {
    netease: `http://127.0.0.1:${neteaseSrv.address().port}/api/cloudsearch/pc`,
    qq: 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp',
    kuwo: 'https://kuwo.cn',
    kugou: '',
  } } });
  ok(u1.j.applied?.includes('scrape_urls')
    && chOf(u1.j, 'netease').url === `http://127.0.0.1:${neteaseSrv.address().port}/api/cloudsearch/pc`
    && chOf(u1.j, 'netease').effective === `http://127.0.0.1:${neteaseSrv.address().port}/api/cloudsearch/pc`,
    'B4 自定义地址原样保存并在 effective 生效（带回包）', JSON.stringify(chOf(u1.j, 'netease')));
  ok(chOf(u1.j, 'qq').effective === 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp',
    'B5 QQ 推荐地址带完整路径，不做归一直接用', JSON.stringify(chOf(u1.j, 'qq')));
  ok(chOf(u1.j, 'kuwo').effective === 'http://search.kuwo.cn/r.s',
    'B6 酷我站点根归一到 search 子域并补 /r.s（粘贴推荐地址即用）', JSON.stringify(chOf(u1.j, 'kuwo')));
  ok(chOf(u1.j, 'kugou').url === '' && (chOf(u1.j, 'kugou').effective || '') === `http://127.0.0.1:${kugouSrv.address().port}/song_search_v2`,
    'B7 空串=用默认链（env 光杆主机补 legacyPath /song_search_v2）', JSON.stringify(chOf(u1.j, 'kugou')));
  const u2 = await api('POST', '/api/mc/settings', { token: T, body: { scrape_urls: { netease: 'https://interface.music.163.com/eapi/api/cloudsearch/pc', qq: '', kuwo: '', kugou: '' } } });
  ok(chOf(u2.j, 'netease').effective === 'https://interface.music.163.com/api/cloudsearch/pc',
    'B8 网易 eapi 地址归一到同主机 /api/ 路径（GET 直通，粘贴推荐地址即用）', JSON.stringify(chOf(u2.j, 'netease')));
  // 先验后写：scrape_urls 不合法时连同一起发的 scrape_on 也不落库（不能落半套）
  const before_on = cfg_now_on(await api('GET', '/api/mc/config', { token: T }));
  const bad = await api('POST', '/api/mc/settings', { token: T, body: { scrape_on: ['qq'], scrape_urls: { netease: 'ftp://不合法', qq: '', kuwo: '', kugou: '' } } });
  ok(bad.status === 400 && (bad.j.error || '').includes('http'), 'B9 非 http(s) 地址整体 400 并说明原因', JSON.stringify(bad.j));
  const after_bad_cfg = await api('GET', '/api/mc/config', { token: T });
  ok(cfg_now_on(after_bad_cfg) === before_on
    && chOf(after_bad_cfg.j, 'netease').url === 'https://interface.music.163.com/eapi/api/cloudsearch/pc',
    'B10 校验失败时一起发的 scrape_on 也没写入（先验后写，不落半套）',
    `before=${before_on} after=${cfg_now_on(after_bad_cfg)} netease.url=${chOf(after_bad_cfg.j, 'netease').url}`);
  // 还原：全空串回落 env/默认（C 段的测连通全走本机假上游）
  await api('POST', '/api/mc/settings', { token: T, body: { scrape_urls: { netease: '', qq: '', kuwo: '', kugou: '' } } });
  // 酷我全链（真下载 img1.kuwo.cn）不在假上游里测——封面 CDN 域名写死在 searchChannel 里，
  // 本机假图床拦不下来；其解析分支 2026-10-14 已对真实 API 探针核过（Logs/probe-scrape-kuwo2.mjs）。

  // ---------- C. 渠道测连通（真搜 + 真下图，不落盘） ----------
  const c1 = await api('POST', '/api/mc/scrape/test', { token: T, body: { channel: 'netease' } });
  ok(c1.j.ok === true && c1.j.bytes >= 100 && (c1.j.url || '').includes('/netease-pic.jpg'), 'C1 网易：通，拿到图字节数与地址', JSON.stringify(c1.j));
  ok((c1.j.endpoint || '') === `http://127.0.0.1:${neteaseSrv.address().port}/api/search/get`,
    'C1b 测连通回包带 endpoint（实际请求端点亮给用户看）', JSON.stringify(c1.j.endpoint));
  const c7 = await api('POST', '/api/mc/scrape/test', { token: T, body: { channel: 'kugou' } });
  ok(c7.j.ok === true && (c7.j.url || '').includes('/imge.kugou.com/stdmusic/240/480.jpg') && !(c7.j.url || '').includes('singerimg'),
    'C7 酷狗：跳过歌手头像（singerimg）、{size}→480，只下 imge 专辑封面', JSON.stringify(c7.j));
  const before = picHits.length;
  const c2 = await api('POST', '/api/mc/scrape/test', { token: T, body: { channel: 'itunes' } });
  ok(c2.j.ok === true && picHits.slice(before).includes('/itunes/cover600x600bb.jpg'), 'C2 iTunes：100x100 缩略图地址被改写成 600x600 再下载', JSON.stringify(c2.j));
  const c3 = await api('POST', '/api/mc/scrape/test', { token: T, body: { channel: 'qq' } });
  ok(c3.j.ok === true && (c3.j.url || '').includes('/music/photo_new/T002R300x300M000ABCD123.jpg'), 'C3 QQ：albumMid 拼出 CDN 封面地址', JSON.stringify(c3.j));
  const c4 = await api('POST', '/api/mc/scrape/test', { token: T, body: { channel: 'xxx' } });
  ok(c4.j.ok === false && (c4.j.error || '').includes('未知渠道'), 'C4 未知渠道如实报错');
  neteaseFail = true;
  const c5 = await api('POST', '/api/mc/scrape/test', { token: T, body: { channel: 'netease' } });
  ok(c5.j.ok === false && (c5.j.error || '') !== '', 'C5 上游 500 时测连通回 ok:false 带原因', JSON.stringify(c5.j));
  neteaseFail = false;
  const c9 = await api('POST', '/api/mc/scrape/stop', { token: T, body: {} });
  ok(c9.status === 400 && (c9.j.error || '').includes('没有正在进行的刮削'), 'C6 空闲时 stop 刮削 400（刮削尚未开始）', JSON.stringify(c9.j));

  // ---------- D. 后台刮削全链：写盘 + has_cover=3 + cover 出图 + 统计归零 ----------
  const st1 = await api('POST', '/api/mc/scrape/start', { token: T, body: {} });
  ok(st1.j.ok === true && st1.j.total === 2, 'D1 刮削启动（2 首待补）', JSON.stringify(st1.j));
  let job = null;
  for (let i = 0; i < 40; i++) { // 2 首 × 300ms 间隔 + 本地假上游，5s 绰绰有余
    await sleep(500);
    const s = await api('GET', '/api/mc/scrape/status', { token: T });
    job = s.j;
    if (!job.running) break;
  }
  ok(job && !job.running && job.found === 2 && job.failed === 0, 'D2 刮削完成：2/2 张刮到、0 失败', JSON.stringify(job && { found: job.found, failed: job.failed, running: job.running }));
  const lib = await api('GET', '/api/mc/library?dir=' + encodeURIComponent('专辑A'), { token: T });
  const tracks = lib.j.tracks || [];
  ok(tracks.length === 2 && tracks.every((t) => t.has_cover === 3), 'D3 曲库里两首 has_cover=3（刮削来源）', JSON.stringify(tracks.map((t) => [t.title, t.has_cover])));
  const idA1 = (tracks.find((t) => t.title === '夜曲') || {}).id;
  const cov = await fetch(B + '/api/mc/cover/' + idA1, { headers: { Authorization: 'Bearer ' + T } });
  ok(cov.status === 200 && (cov.headers.get('content-type') || '').includes('image/jpeg'), 'D4 /mc/cover/:id 出图（image/jpeg）');
  const covFile = path.join(DATA, 'mc', 'covers', idA1 + '.jpg');
  let covOk = false;
  try { covOk = fs.statSync(covFile).size >= 100; } catch { /* 没落盘 */ }
  ok(covOk, 'D5 封面文件真写到 data/mc/covers/<id>.jpg', covFile);
  const cfg2 = await api('GET', '/api/mc/config', { token: T });
  ok(cfg2.j.stats?.nocover === 0 && cfg2.j.scrape?.scraped === 2, 'D6 统计归零：nocover=0 / scraped=2', JSON.stringify(cfg2.j.stats));

  // ---------- E. 悬浮歌词：安装包解剖 + poll 全回合 ----------
  ok(cfg2.j.desk?.font_included === true, 'E0 服务器字体在位（安装包将带字体）', JSON.stringify(cfg2.j.desk));
  ok((await api('GET', '/api/mc/agents', {})).status === 401, 'E1 /mc/agents 未登录 401');
  ok((await api('GET', '/api/mc/agent/package', {})).status === 401, 'E2 安装包未登录 401');
  ok((await api('POST', '/api/mc/nowplaying', { body: { id: 1, pos: 0, playing: true } })).status === 401, 'E3 nowplaying 未登录 401');
  ok((await pollQ({ key: '', id: 'PC-test12345678' })).status === 403, 'E4 poll 无 key 403');
  ok((await pollQ({ key: '0123456789abcdef0123456789abcdef', id: 'PC-test12345678' })).status === 403, 'E5 poll 坏 key 403');

  // 下载安装包：带 Origin 头控制 baseUrl 探测（包里嵌的回连地址=从哪儿下载就嵌哪儿）
  const pkgRes = await fetch(B + '/api/mc/agent/package', { headers: { Authorization: 'Bearer ' + T, Origin: B } });
  const pkgBuf = Buffer.from(await pkgRes.arrayBuffer());
  ok(pkgRes.status === 200 && pkgBuf.slice(0, 2).toString('latin1') === 'PK', 'E6 安装包下载（管理员，ZIP 魔数）', `status=${pkgRes.status} bytes=${pkgBuf.length}`);
  const zipMod = await import('../server/services/zipService.js');
  const extractZip = zipMod.extractZip || zipMod.default?.extractZip;
  const entries = extractZip(pkgBuf);
  const by = Object.fromEntries(entries.map((e) => [e.name, e.data]));
  ok(new Set(['setup.ps1', 'font.otf', '安装.cmd', '卸载.cmd', '使用说明.txt']).size === 5
    && ['setup.ps1', 'font.otf', '安装.cmd', '卸载.cmd', '使用说明.txt'].every((n) => by[n]), 'E7 包内五条目齐（含字体）', entries.map((e) => e.name).join('|'));
  // v1.17.1：卸载包（轻量）——卸载逻辑在 setup.ps1 -Cmd uninstall，故脚本必须带；不带 8.4MB 字体与安装.cmd
  const unRes = await fetch(B + '/api/mc/agent/package?mode=uninstall', { headers: { Authorization: 'Bearer ' + T, Origin: B } });
  const unBuf = Buffer.from(await unRes.arrayBuffer());
  ok(unRes.status === 200 && unBuf.slice(0, 2).toString('latin1') === 'PK', 'E6b 卸载包下载（ZIP 魔数）', `status=${unRes.status}`);
  ok((unRes.headers.get('content-disposition') || '').includes(encodeURIComponent('悬浮歌词卸载包.zip')), 'E6c 卸载包文件名 RFC5987 中文名');
  const unBy = Object.fromEntries(extractZip(unBuf).map((e) => [e.name, e.data]));
  ok(['setup.ps1', '卸载.cmd', '使用说明.txt'].every((n) => unBy[n]) && !unBy['font.otf'] && !unBy['安装.cmd'],
    'E6d 卸载包三件套（无字体/无安装.cmd）', Object.keys(unBy).join('|'));
  ok(unBuf.length < 100_000, 'E6e 卸载包 <100KB（轻量）', String(unBuf.length));
  const ps = by['setup.ps1'];
  const psText = ps.toString('utf8');
  // v1.17.1 回归（生产「安装成功但 0 台设备」根因）：PS5.1/.NET Framework 的 ServicePointManager
  // 没有 DefaultWebProxy 静态属性，模板里那行裸赋值在 ErrorActionPreference=Stop 下直接炸死常驻进程
  ok(psText.includes('[System.Net.WebRequest]::DefaultWebProxy = $null') && !psText.includes('ServicePointManager]::DefaultWebProxy'),
    'E15a 代理绕过走 WebRequest.DefaultWebProxy（PS5.1 实测可赋值）；ServicePointManager 杀手行已除');
  ok(psText.includes('trap {') && psText.includes('致命错误，代理退出'), 'E15b 常驻段 trap 兜底（未捕获异常写 agent.log 再退，不再静默死亡）');
  ok(psText.includes('poll 失败 x') && psText.includes('poll 恢复'), 'E15c poll 失败/恢复都留痕（不再空 catch 吞掉连不上）');
  ok(ps[0] === 0xef && ps[1] === 0xbb && ps[2] === 0xbf, 'E8 setup.ps1 带 UTF-8 BOM（PowerShell 5.1 才不把中文读成乱码）');
  ok(psText.includes(`'${B}'`) && !psText.includes('__SERVER__') && !psText.includes('__KEY__') && !psText.includes('__FONT_FAMILY__'),
    'E9 占位符全替换（回连地址=下载来源）', B);
  const km = /\$aKey\s*=\s*'([0-9a-f]{32})'/.exec(psText);
  ok(!!km, 'E10 包内嵌 32 位设备密钥（$aKey）');
  ok(psText.includes('Source Han Sans CN'), 'E11 字体家族嵌成思源黑体（bundledFont 在位时）');
  ok((by['font.otf'] || Buffer.alloc(0)).length >= 8_000_000, 'E12 font.otf ≥8MB（真字体而非残文件）', String((by['font.otf'] || []).length));
  for (const n of ['安装.cmd', '卸载.cmd']) {
    const d = by[n];
    ok(d.includes(Buffer.from('\r\n')) && !(d[0] === 0xef) && d.toString('utf8').includes('setup.ps1'), `E13 ${n}：CRLF、无 BOM、引用 setup.ps1`);
  }
  ok(by['使用说明.txt'][0] === 0xef && by['使用说明.txt'][1] === 0xbb && by['使用说明.txt'][2] === 0xbf, 'E14 使用说明.txt 带 BOM');
  // PowerShell 语法级校验：只 ParseFile 绝不执行（安装分支会写注册表/装服务，本机绝不跑）
  const psPath = path.join(DATA, 'setup-syntax-check.ps1');
  fs.writeFileSync(psPath, ps);
  const psChk = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${psPath.replace(/'/g, "''")}', [ref]$null, [ref]$e) | Out-Null; if ($e -and $e.Count) { $e | ForEach-Object { Write-Output ('ERR:' + $_.Message) }; exit 1 } else { Write-Output 'SYNTAX-OK'; exit 0 }`],
    { encoding: 'utf8', timeout: 60000 });
  ok(psChk.status === 0 && (psChk.stdout || '').includes('SYNTAX-OK'), 'E15 setup.ps1 PowerShell 语法检查通过（Parser::ParseFile，不执行）',
    ((psChk.stdout || '') + (psChk.stderr || '')).slice(0, 300));

  // poll 全回合（用包里的 key）
  const KEY = km[1];
  const DEVID = 'PC-test12345678';
  ok((await pollQ({ key: KEY, id: 'ab' })).status === 400, 'E16 设备号太短 400（6-64 位约束）');
  const p1 = await pollQ({ key: KEY, id: DEVID, computer: '测试机', v: '1' });
  ok(p1.status === 200 && p1.j.ok === true && p1.j.device?.id === DEVID && p1.j.device?.name === '测试机'
    && p1.j.device?.show === true && p1.j.global_on === true && p1.j.font?.family === '' && p1.j.font?.size === 36 && p1.j.now === null,
    'E17 首次 poll 注册设备：名字/显示开关/总开关/默认字体/无播放', JSON.stringify(p1.j).slice(0, 200));
  let ag = await api('GET', '/api/mc/agents', { token: T });
  ok(ag.j.agents?.length === 1 && ag.j.agents[0].computer === '测试机' && ag.j.agents[0].online === true && ag.j.agents[0].polls >= 1,
    'E18 设备清单：1 台在线、computer=测试机', JSON.stringify(ag.j.agents));
  const r1 = await api('PUT', '/api/mc/agents/' + DEVID, { token: T, body: { name: '客厅电脑' } });
  ok(r1.j.ok === true && r1.j.agents[0].name === '客厅电脑', 'E19 改名生效');
  await api('PUT', '/api/mc/agents/' + DEVID, { token: T, body: { show: false } });
  ok((await pollQ({ key: KEY, id: DEVID })).j.device?.show === false, 'E20 单设备「显示」关闭后 poll 回传 show:false');
  await api('PUT', '/api/mc/agents/' + DEVID, { token: T, body: { show: true } });

  // 正在播放 → 两拍歌词（首拍踢异步补拉、次拍同步两行）
  const np = await api('POST', '/api/mc/nowplaying', { token: T, body: { id: idA1, pos: 3.2, playing: true } });
  ok(np.j.ok === true, 'E21 nowplaying 上报 ok');
  ok((await api('POST', '/api/mc/nowplaying', { token: T, body: { id: 0 } })).status === 400, 'E22 nowplaying 非法 id 400');
  const p2 = await pollQ({ key: KEY, id: DEVID });
  ok(p2.j.now?.playing === true && p2.j.now?.title === '夜曲' && Math.abs((p2.j.now?.pos || 0) - 3.2) < 1.5
    && Array.isArray(p2.j.now?.lines) && p2.j.now.lines.length === 0, 'E23 poll 首拍：正在播放夜曲但歌词还在补拉（lines 空）', JSON.stringify(p2.j.now).slice(0, 200));
  await sleep(2200);
  const p3 = await pollQ({ key: KEY, id: DEVID });
  ok(p3.j.now?.synced === true && p3.j.now?.lines?.length === 2 && p3.j.now.lines[0]?.text === '夜曲第一行' && Math.abs((p3.j.now.lines[0]?.t || 0) - 0.6) < 0.05,
    'E24 poll 次拍：同步歌词两行、时间戳解析正确', JSON.stringify(p3.j.now?.lines));

  // 总开关 / 字体字号（99 钳到 96）
  await api('POST', '/api/mc/settings', { token: T, body: { desk_on: false } });
  ok((await pollQ({ key: KEY, id: DEVID })).j.global_on === false, 'E25 系统端总开关关 → poll global_on:false');
  await api('POST', '/api/mc/settings', { token: T, body: { desk_on: true } });
  await api('POST', '/api/mc/settings', { token: T, body: { font_family: '微软雅黑', font_size: 99 } });
  const p4 = await pollQ({ key: KEY, id: DEVID });
  ok(p4.j.font?.family === '微软雅黑' && p4.j.font?.size === 96, 'E26 字体可设、字号钳到上限 96', JSON.stringify(p4.j.font));
  await api('POST', '/api/mc/settings', { token: T, body: { font_family: '', font_size: 36 } });

  // 轮换 key：旧 key 立即失联、新 key 接着用
  const rot = await api('POST', '/api/mc/agent/rotate-key', { token: T, body: {} });
  const KEY2 = rot.j.key;
  ok(/^[0-9a-f]{32}$/.test(String(KEY2)) && KEY2 !== KEY, 'E27 轮换出新的 32 位密钥');
  ok((await pollQ({ key: KEY, id: DEVID })).status === 403, 'E28 旧 key 立即 403');
  ok((await pollQ({ key: KEY2, id: DEVID })).status === 200, 'E29 新 key 继续可用（设备行还在，polls 递增）');
  // 删除设备 → 清单空；电脑再 poll 又自动登记
  const del = await api('DELETE', '/api/mc/agents/' + DEVID, { token: T });
  ok(del.j.ok === true && del.j.agents.length === 0, 'E30 删除设备后清单为空');
  ok((await pollQ({ key: KEY2, id: DEVID })).status === 200, 'E31 设备删除后再 poll 自动重新登记（与界面提示一致）');
  ag = await api('GET', '/api/mc/agents', { token: T });
  ok(ag.j.agents?.length === 1, 'E32 清单重新出现该设备');
} catch (e) {
  failed++;
  console.error('  ✗ 异常：', e.message);
} finally {
  try { server.kill(); } catch { /* 忽略 */ }
  for (const s of [picServer, neteaseSrv, qqSrv, itunesSrv, lrclib]) { try { s.close(); } catch { /* 忽略 */ } }
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄迟滞 */ }
  try { fs.rmSync(MUSIC, { recursive: true, force: true }); } catch { /* 同上 */ }
}

console.log(`\n${failed === 0 ? '全绿' : '有失败'}：${passed} 通过 / ${failed} 失败`);
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 50).unref();
