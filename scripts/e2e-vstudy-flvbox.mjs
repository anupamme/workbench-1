// e2e：v1.13.7 「按真实容器播视频」——扩展名说谎时不再转圈
//
// 用户报障（2026-10-11）：「flv 格式的视频在 学习 → 视频教学 一直加载无法播放」。
// 生产实测根因：学习目录里 46 个 .flv **全部是 MP4**（ftyp/isom/avc1/mp41），交给 flv.js 必卡
// （它按 FLV tag 找 'FLV\x01' 头，读到 ftyp box 就永远转不出画面）。
//
// 覆盖：
//   ① 服务端魔数嗅探：目录树里每个媒体文件带 box（真实容器）+ native；.flv 实为 mp4 → box=mp4；
//   ② /vstudy/file 的 Content-Type 按真实容器给（伪装 mp4 的 .flv 回 video/mp4）；
//   ③ /vstudy/probe：真实容器 + FLV 编码（avc / hevc / profile>100 判 playable=false；mkv 判 native=false）；
//   ④ UI：伪装成 flv 的 mp4 → 走原生 <video>（src = 文件 URL，不是 blob:，不是 flv.js）；
//      真 FLV（AVC）→ 走 flv.js（src 是 blob:）；
//      HEVC 的 FLV 与 MKV → 播放区给出可读原因（.media-issue），而不是空白转圈；
//      外部播放器按钮行在任何情况下都在（用户能一键转 PotPlayer/VLC）。
// 隔离 DATA_DIR 起真实服务；Playwright 走真 UI。e2e 不真解码，只看「选了哪条播放通道」。
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3191;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-flvbox-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试素材（手搓容器头，e2e 不真解码） ----------
const ROOT = path.join(DATA, 'study');
mkdirSync(path.join(ROOT, '初一'), { recursive: true });
// ④-1 真 MP4：ISO BMFF 的 ftyp box 起手（'isom' major brand）
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'),
  Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1mp41', 'latin1'), Buffer.alloc(4000, 0x41)]);
// ④-2 **扩展名说谎**：MP4 内容 + .flv 后缀（生产 46 个文件全这样）
const FAKE_FLV = MP4;
// ④-3 真 FLV（AVC/H.264）：FLV 头 + 一个脚本 tag + 视频 tag（AVC 序列头，profile 100 High）
function realFlv(profile = 0x64) {
  const head = Buffer.concat([Buffer.from('FLV\x01', 'latin1'), Buffer.from([0x01, 0, 0, 0, 9])]);
  const avcBody = Buffer.concat([Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00]), // frametype1+codec7 / AVCPacketType0(seq) / CompositionTime
    Buffer.from([0x01, profile, 0x00, 0x1f, 0xff]),                          // configVer=1 / AVCProfileIndication / compat / level
    Buffer.alloc(60, 0x01)]);
  const tag = (type, body) => {
    // FLV TagHeader 共 11 字节：Type(1) + DataSize(3) + Timestamp(3) + TimestampExtended(1) + StreamID(3)
    const t = Buffer.concat([Buffer.from([type]),
      Buffer.from([(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]),
      Buffer.from([0, 0, 0, 0, 0, 0, 0]), body]);
    return Buffer.concat([t, Buffer.from([0, 0, 0, 0])]);   // 尾部 PreviousTagSize
  };
  return Buffer.concat([head, Buffer.alloc(4), tag(9, avcBody), Buffer.alloc(200, 0x42)]);
}
// ④-4 HEVC 的 FLV（enhanced-rtmp：CodecID=12 + fourcc 'hvc1'）——flv.js 转不出来
function hevcFlv() {
  const head = Buffer.concat([Buffer.from('FLV\x01', 'latin1'), Buffer.from([0x01, 0, 0, 0, 9])]);
  const body = Buffer.concat([Buffer.from([0x1c]), Buffer.from('hvc1', 'latin1'), Buffer.alloc(80, 0x02)]);
  const t = Buffer.concat([Buffer.from([9]), Buffer.from([0, 0, body.length]), Buffer.from([0, 0, 0, 0, 0, 0, 0]), body, Buffer.alloc(4)]);
  return Buffer.concat([head, Buffer.alloc(4), t, Buffer.alloc(200, 0x43)]);
}
// ④-5 MKV（EBML + DocType matroska）——浏览器不认这个容器
const MKV = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01]), Buffer.from('matroska', 'latin1'), Buffer.alloc(500, 0x44)]);
const TXT = Buffer.from('第一课笔记：全等三角形。', 'utf8');

writeFileSync(path.join(ROOT, '初一', '正常.mp4'), MP4);
writeFileSync(path.join(ROOT, '初一', '伪装成flv的mp4.flv'), FAKE_FLV);
writeFileSync(path.join(ROOT, '初一', '真flv.flv'), realFlv(0x64));
writeFileSync(path.join(ROOT, '初一', '高10的flv.flv'), realFlv(0x6e));   // AVC High 10（profile 110）浏览器解不了
writeFileSync(path.join(ROOT, '初一', 'hevc的flv.flv'), hevcFlv());
writeFileSync(path.join(ROOT, '初一', '老片子.mkv'), MKV);
writeFileSync(path.join(ROOT, '初一', '笔记.txt'), TXT);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
const cleanup = () => { try { server.kill(); } catch { /* 已退 */ } };
process.on('exit', cleanup);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await sleep(500);
  }
  throw new Error('服务 30s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text(), ct };
}

let browser;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  const U = lg.j.user || lg.j.b?.user;
  ok(!!T, 'admin 登录');
  await api('POST', '/api/vstudy/settings', { token: T, body: { root: ROOT } });
  const cf = await api('GET', '/api/vstudy/config', { token: T });
  ok(cf.j.root === ROOT && cf.j.root_ok === true, '学习目录已配置并可用');

  // ---------- ① 目录树带真实容器 ----------
  console.log('— 服务端：魔数嗅探');
  const tr = await api('GET', '/api/vstudy/tree?dir=' + encodeURIComponent('初一'), { token: T });
  const by = Object.fromEntries((tr.j.entries || []).map((e) => [e.name, e]));
  ok(by['伪装成flv的mp4.flv'] && by['伪装成flv的mp4.flv'].box === 'mp4',
    '.flv 实为 MP4 → 树里 box=mp4（这就是「一直加载」的根因文件）', JSON.stringify(by['伪装成flv的mp4.flv']));
  ok(by['伪装成flv的mp4.flv'].native === true, '伪装文件标 native=true（可原生播）');
  ok(by['真flv.flv'] && by['真flv.flv'].box === 'flv' && by['真flv.flv'].native === false,
    '真 FLV → box=flv / native=false', JSON.stringify(by['真flv.flv']));
  ok(by['正常.mp4'] && by['正常.mp4'].box === 'mp4', '正常.mp4 → box=mp4');
  ok(by['老片子.mkv'] && by['老片子.mkv'].box === 'mkv' && by['老片子.mkv'].native === false,
    'MKV → box=mkv / native=false（浏览器不认这个容器）', JSON.stringify(by['老片子.mkv']));
  ok(by['hevc的flv.flv'] && by['hevc的flv.flv'].box === 'flv', 'HEVC 的 FLV → box=flv');
  ok(!by['笔记.txt'].box, '文档不带 box（不瞎嗅）');

  // ---------- ② Content-Type 按真实容器 ----------
  const f = (p) => `${B}/api/vstudy/file?path=${encodeURIComponent('初一/' + p)}&token=${encodeURIComponent(T)}`;
  const r1 = await fetch(f('伪装成flv的mp4.flv'), { headers: { Range: 'bytes=0-99' } });
  ok(r1.status === 206 && r1.headers.get('content-type') === 'video/mp4',
    '伪装文件的响应头是 video/mp4（不是 video/x-flv）', r1.headers.get('content-type'));
  const r2 = await fetch(f('真flv.flv'), { headers: { Range: 'bytes=0-99' } });
  ok(r2.headers.get('content-type') === 'video/x-flv', '真 FLV 的响应头是 video/x-flv', r2.headers.get('content-type'));

  // ---------- ③ probe ----------
  console.log('— /vstudy/probe：真实容器 + 编码');
  const p1 = (await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('初一/伪装成flv的mp4.flv'), { token: T })).j;
  ok(p1.box === 'mp4' && p1.native === true && p1.playable === true, '伪装文件：box=mp4 / playable=true', JSON.stringify(p1));
  const p2 = (await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('初一/真flv.flv'), { token: T })).j;
  ok(p2.box === 'flv' && p2.codec === 'avc' && p2.playable === true, '真 FLV：codec=avc / playable=true', JSON.stringify(p2));
  const p2b = (await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('初一/高10的flv.flv'), { token: T })).j;
  ok(p2b.box === 'flv' && p2b.codec === 'avc' && p2b.profile === 110 && p2b.playable === false,
    'AVC High 10（profile 110）的 FLV：playable=false（浏览器解不了）', JSON.stringify(p2b));
  const p3 = (await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('初一/hevc的flv.flv'), { token: T })).j;
  ok(p3.box === 'flv' && p3.codec === 'hevc' && p3.playable === false, 'HEVC 的 FLV：codec=hevc / playable=false', JSON.stringify(p3));
  const p4 = (await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('初一/老片子.mkv'), { token: T })).j;
  ok(p4.box === 'mkv' && p4.native === false && p4.playable === false, 'MKV：native=false / playable=false', JSON.stringify(p4));
  const p5 = await api('GET', '/api/vstudy/probe?path=' + encodeURIComponent('../windows/win.ini'), { token: T });
  ok(p5.status === 400, 'probe 也守目录越界（../ 被拦）', String(p5.status));

  // ---------- ④ UI：真的选了正确的播放通道 ----------
  console.log('— UI：点击文件后走哪条通道');
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(U)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
  p.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  await p.goto(`${B}/#/learning?tab=vstudy`);
  // 进浏览页：开始学习 → 学年（第一个）→ 学科（第一个）；每步等下一屏渲染出来再点（否则会重复点同一屏）
  await p.locator('.big-start').waitFor({ timeout: 15000 });
  await p.locator('.big-start').click();
  await p.locator('.pick h3', { hasText: '选择学年' }).waitFor({ timeout: 10000 });
  await p.locator('.big-btn').first().click();
  await p.locator('.pick h3', { hasText: '选择学科' }).waitFor({ timeout: 10000 });
  await p.locator('.big-btn').first().click();
  // 选完学科即进入浏览（startBrowse 已自动展开目录根）——直接点「初一」
  const n1 = p.locator('.row.dir', { hasText: '初一' }).first();
  await n1.waitFor({ timeout: 10000 });
  await n1.click();
  await p.locator('.row.media', { hasText: '伪装成flv的mp4.flv' }).first().waitFor({ timeout: 10000 });

  const srcOf = () => p.locator('.player-zone video').evaluate((v) => v.src || '');
  // ④-1 伪装成 flv 的 mp4 → 原生通道
  await p.locator('.row.media', { hasText: '伪装成flv的mp4.flv' }).first().click();
  await p.waitForFunction(() => { const v = document.querySelector('.player-zone video'); return !!(v && v.src); }, null, { timeout: 10000 }).catch(() => {});
  const s1 = decodeURIComponent(await srcOf());
  ok(s1.includes('path=初一/伪装成flv的mp4.flv') && !s1.startsWith('blob:'),
    '伪装成 flv 的 MP4 走原生 <video>（src = 文件 URL，不是 blob:）', s1.slice(-60));
  // 该断言不依赖素材真能解码（手搓 MP4 解不了也正常），只看「有没有被按扩展名/别的容器拦下」：
  // 正确行为 = 交给原生 <video>，不会出现「真实容器是 X」那种扩展名误判提示。
  ok(!/真实容器/.test(await p.locator('.media-issue').innerText().catch(() => '')),
    '伪装文件没被当成其它容器拦下（走原生通道，非 flv.js）');
  // ④-2 真 FLV → flv.js（MSE 的 blob URL）
  await p.locator('.row.media', { hasText: '真flv.flv' }).first().click();
  await p.waitForFunction(() => { const v = document.querySelector('.player-zone video'); return !!(v && v.src.startsWith('blob:')); }, null, { timeout: 10000 }).catch(() => {});
  ok((await srcOf()).startsWith('blob:'), '真 FLV 交给 flv.js（src 是 MSE 的 blob URL）', (await srcOf()).slice(0, 40));
  // ④-3 HEVC 的 FLV → 明说原因，不再空转
  await p.locator('.row.media', { hasText: 'hevc的flv.flv' }).first().click();
  await p.waitForSelector('.media-issue', { timeout: 10000 }).catch(() => {});
  const iss = await p.locator('.media-issue').innerText().catch(() => '');
  ok(/H\.265|HEVC/.test(iss), 'HEVC 的 FLV 在播放区写明「H.265(HEVC) 浏览器解不了」', iss.replace(/\s+/g, ' ').slice(0, 90));
  // ④-4 MKV → 也是明说
  await p.locator('.row.media', { hasText: '老片子.mkv' }).first().click();
  await p.waitForFunction(() => /Matroska|MKV/.test(document.querySelector('.media-issue')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
  ok(/Matroska|MKV/.test(await p.locator('.media-issue').innerText().catch(() => '')),
    'MKV 在播放区写明真实容器（浏览器不认）');
  // ④-5 播不了时外部播放器按钮行仍在（用户的退路）
  ok(await p.locator('.ext-row button', { hasText: 'PotPlayer 播放' }).count() === 1
    && await p.locator('.ext-row button', { hasText: 'VLC 播放' }).count() === 1,
    '播不了时 PotPlayer / VLC 按钮仍在（可直接转本地播放器）');
  ok(perr.length === 0, 'UI 全程无 JS 报错', perr.join(' | '));

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', (e && e.stack) || e);
} finally {
  try { if (browser) await browser.close(); } catch { /* 已关 */ }
  cleanup();
  await sleep(200);
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 句柄未释放 */ }
  process.exit(failed ? 1 : 0);
}
