// E2E（v1.16.0）：音乐中心 /mc/* —— 曲库扫描/目录树/歌曲列表/Range 流播/封面/收藏/歌词(LRCLIB 桩)/权限。
// 规矩照 _noteE2E：隔离 DATA_DIR + 临时音乐目录（合成 ID3 mp3 / 无标签 mp3 / 目录 cover.jpg），
// LRCLIB 用本地假服务（MC_LRCLIB_BASE 在 spawn 前注入子进程），绝不碰真网与 data/ 根。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, login, api, checker } from './_noteE2E.mjs';
import { pageForPath, tabForPath } from '../server/auth.js';

const { ck, done } = checker();

// ---------- 合成音频字节（与 check-mc-meta 同套路，精简版） ----------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(140, 0x11), Buffer.from([0xff, 0xd9])]);
const MP3HDR = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // MPEG1 L3 128kbps 44100
function id3(mp3) {
  const frames = [];
  const fr = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8'), Buffer.from([0])]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    frames.push(Buffer.concat([h, body]));
  };
  const apic = (() => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg', 'latin1'), Buffer.from([0]), Buffer.from([3]), Buffer.from([0]), JPEG]);
    const h = Buffer.alloc(10); h.write('APIC', 0, 'latin1'); h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  })();
  fr('TIT2', '夜曲'); fr('TPE1', '周杰伦'); fr('TALB', '十一月的萧邦');
  const body = Buffer.concat([...frames, apic]);
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1'); h[3] = 3;
  h[6] = (body.length >> 21) & 0x7f; h[7] = (body.length >> 14) & 0x7f; h[8] = (body.length >> 7) & 0x7f; h[9] = body.length & 0x7f;
  return Buffer.concat([h, body, mp3]);
}

// ---------- 假 LRCLIB（可控开关：默认 get 404 / search 命中；rateLimited=true 时全 429） ----------
let rateLimited = false;
let lrclibHits = 0;
const lrclib = http.createServer((req, res) => {
  lrclibHits++;
  if (rateLimited) { res.writeHead(429, { 'retry-after': '7' }); res.end(); return; }
  const u = req.url || '';
  if (u.startsWith('/api/get')) { res.writeHead(404); res.end('{}'); return; }
  if (u.startsWith('/api/search')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ syncedLyrics: '[00:01.00]第一行\n[00:05.00]第二行' }]));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lrclib.listen(0, '127.0.0.1', r));
process.env.MC_LRCLIB_BASE = `http://127.0.0.1:${lrclib.address().port}`; // ⬅ 必须先于 startServer（子进程 env 快照）

// ---------- 临时音乐目录（放系统临时区，别放 data/ 下——db sweep 只认 .sqlite 但保持习惯） ----------
const MUSIC = fs.mkdtempSync(path.join(tmpdir(), 'mce2e-'));
fs.mkdirSync(path.join(MUSIC, '专辑A'));
fs.mkdirSync(path.join(MUSIC, '专辑B'));
const A1 = id3(MP3HDR);
fs.writeFileSync(path.join(MUSIC, '专辑A', 'A1.mp3'), A1);
fs.writeFileSync(path.join(MUSIC, '专辑A', 'B2 - 无人声.mp3'), Buffer.concat([MP3HDR, Buffer.alloc(64)]));
fs.writeFileSync(path.join(MUSIC, '专辑B', '老歌 - 无标签.mp3'), Buffer.concat([MP3HDR, Buffer.alloc(64)]));
fs.writeFileSync(path.join(MUSIC, '专辑B', 'cover.jpg'), JPEG);
const MUSIC_NORM = MUSIC.replace(/\\/g, '/');

const srv = await startServer({ tag: 'music', port: 3989 });
const { B } = srv;

const bin = async (p, headers = {}) => {
  const r = await fetch(B + p, { headers });
  return { status: r.status, ct: r.headers.get('content-type') || '', cr: r.headers.get('content-range') || '', len: r.headers.get('content-length') || '', buf: Buffer.from(await r.arrayBuffer()), raw: r };
};

try {
  const admin = await login(B, 'admin', 'test123456');
  const A = api(B, admin.H);

  // ---------- ① 配置 ----------
  let r = await A.get('/mc/config');
  ck('A1 初始 config：root 空 + stats 全零 + is_admin',
    r.status === 200 && r.body.root === '' && r.body.root_ok === false && r.body.stats.total === 0 && r.body.is_admin === true,
    `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  r = await A.post('/mc/settings', { root: '/不存在目录xyz' });
  ck('A2 目录不存在 → 400 且把 /vol2/1000 前缀映射讲出来',
    r.status === 400 && /vol2\/1000/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  r = await A.post('/mc/settings', { root: MUSIC_NORM });
  ck('A3 保存真实目录 → ok + root_ok + resolved 回填',
    r.status === 200 && r.body.ok === true && r.body.root_ok === true && r.body.resolved.replace(/\\/g, '/').toLowerCase() === MUSIC_NORM.toLowerCase(),
    JSON.stringify(r.body).slice(0, 200));
  r = await A.get('/mc/config');
  ck('A4 config 回读 root 已落库', r.body.root.replace(/\\/g, '/').toLowerCase() === MUSIC_NORM.toLowerCase() && r.body.root_ok === true, JSON.stringify(r.body).slice(0, 120));

  // ---------- ② 扫描 ----------
  r = await A.post('/mc/scan', {});
  ck('B1 手动扫描：3 首全入库', r.status === 200 && r.body.ok === true && r.body.added === 3 && r.body.total === 3, JSON.stringify(r.body).slice(0, 200));
  r = await A.get('/mc/config');
  ck('B2 统计卡片：总数3 / 封面2 / 未匹配1 / 待处理1（B2 无封面）',
    r.body.stats.total === 3 && r.body.stats.covers === 2 && r.body.stats.nocover === 1 && r.body.stats.pending === 1,
    JSON.stringify(r.body.stats));
  ck('B3 scanned_at 已落库（非零）', r.body.scanned_at > 0, String(r.body.scanned_at));

  // ---------- ③ 目录树（读磁盘，与曲库互补） ----------
  r = await A.get('/mc/tree');
  ck('C1 根树：两个专辑目录 + VsTreeNode 形状 entries', r.status === 200 && r.body.dirs.length === 2 && r.body.dirs.some((d) => d.name === '专辑A') && r.body.dirs.some((d) => d.name === '专辑B') && r.body.files.length === 0
    && r.body.entries.length === 2 && r.body.entries.every((e) => e.is_dir === true),
    JSON.stringify(r.body).slice(0, 160));
  r = await A.get('/mc/tree?dir=' + encodeURIComponent('专辑A'));
  ck('C2 专辑A 树：2 个音频文件（非音频不出现）', r.status === 200 && r.body.files.length === 2 && r.body.files.every((f) => /\.mp3$/.test(f.name)) && r.body.dirs.length === 0,
    JSON.stringify(r.body).slice(0, 160));
  r = await A.get('/mc/tree?dir=' + encodeURIComponent('../..'));
  ck('C3 路径越界 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

  // ---------- ④ 曲库列表（查库，元数据来自解析结果） ----------
  r = await A.get('/mc/library');
  ck('D1 根目录：subdirs=两个专辑，直属歌曲 0', r.status === 200 && r.body.subdirs.length === 2 && r.body.tracks.length === 0, JSON.stringify(r.body).slice(0, 160));
  r = await A.get('/mc/library?dir=' + encodeURIComponent('专辑A'));
  ck('D2 专辑A：2 首，标题/歌手/专辑/时长/封面标记齐全',
    r.status === 200 && r.body.tracks.length === 2
    && r.body.tracks.some((t) => t.title === '夜曲' && t.artist === '周杰伦' && t.album === '十一月的萧邦' && t.has_cover === 1)
    && r.body.tracks.some((t) => t.title === '无人声' && t.artist === 'B2' && t.has_cover === 0),
    JSON.stringify(r.body).slice(0, 300));
  const yq = r.body.tracks.find((t) => t.title === '夜曲');
  ck('D3 每首带 fav:false 与时长>0（CBR 估算）', yq.fav === false && yq.duration_ms > 0, JSON.stringify(yq).slice(0, 160));
  r = await A.get('/mc/library?dir=' + encodeURIComponent('专辑B'));
  ck('D4 专辑B：老歌 has_cover=2（目录 cover.jpg 兜底）', r.body.tracks.length === 1 && r.body.tracks[0].has_cover === 2, JSON.stringify(r.body).slice(0, 200));
  const laogeId = r.body.tracks[0].id;

  // ---------- ⑤ Range 流播（浏览器 <audio> 走 ?token= 查询参数，不带 Authorization 头） ----------
  const T = `token=${admin.token}`;
  let b = await bin(`/api/mc/file?id=${yq.id}&${T}`, { Range: 'bytes=0-9' });
  ck('E1 Range 0-9 → 206 + audio/mpeg + 10 字节且与源文件一致',
    b.status === 206 && b.ct === 'audio/mpeg' && b.len === '10' && b.cr === `bytes 0-9/${A1.length}` && b.buf.equals(A1.slice(0, 10)),
    `${b.status} ${b.ct} ${b.cr} ${b.buf.length}`);
  b = await bin(`/api/mc/file?id=${yq.id}&${T}`, { Range: `bytes=-4` });
  ck('E2 后缀 Range bytes=-4 → 206 最后 4 字节', b.status === 206 && b.buf.equals(A1.slice(-4)), `${b.status} ${b.cr}`);
  b = await bin(`/api/mc/file?id=${yq.id}&${T}`, { Range: 'bytes=999999-1000000' });
  ck('E3 起点越界 → 416 + Content-Range */size', b.status === 416 && b.cr === `bytes */${A1.length}`, `${b.status} ${b.cr}`);
  b = await bin(`/api/mc/file?id=${yq.id}&${T}`);
  ck('E4 无 Range → 200 全量字节一致', b.status === 200 && b.buf.equals(A1), `${b.status} ${b.buf.length}/${A1.length}`);
  b = await bin(`/api/mc/file?id=99999&${T}`);
  ck('E5 不存在的 id → 404', b.status === 404, String(b.status));

  // ---------- ⑥ 封面（<img> 同走 ?token=） ----------
  b = await bin(`/api/mc/cover/${yq.id}?${T}`);
  ck('F1 内嵌封面（A1 APIC）→ 200 image/jpeg + JPEG 魔数', b.status === 200 && b.ct === 'image/jpeg' && b.buf[0] === 0xff && b.buf[1] === 0xd8 && b.buf.length === JPEG.length, `${b.status} ${b.ct} ${b.buf.length}`);
  b = await bin(`/api/mc/cover/${laogeId}?${T}`);
  ck('F2 目录封面兜底（老歌 has_cover=2）→ 200 = cover.jpg 字节', b.status === 200 && b.buf.equals(JPEG), `${b.status} ${b.buf.length}`);
  const b2 = (await A.get('/mc/library?dir=' + encodeURIComponent('专辑A'))).body.tracks.find((t) => t.title === '无人声');
  b = await bin(`/api/mc/cover/${b2.id}?${T}`);
  ck('F3 无封面（B2）→ 404（前端回落占位图）', b.status === 404, String(b.status));

  // ---------- ⑦ 收藏 ----------
  r = await A.post('/mc/favorite', { id: yq.id, on: true });
  ck('G1 收藏 → ok', r.status === 200 && r.body.ok === true && r.body.fav === true, JSON.stringify(r.body));
  r = await A.get('/mc/favorites');
  ck('G2 收藏列表：1 首且 fav:true 带元数据', r.body.tracks.length === 1 && r.body.tracks[0].id === yq.id && r.body.tracks[0].fav === true && r.body.tracks[0].title === '夜曲', JSON.stringify(r.body).slice(0, 200));
  r = await A.get('/mc/library?dir=' + encodeURIComponent('专辑A'));
  ck('G3 曲库里该曲 fav:true', r.body.tracks.find((t) => t.id === yq.id).fav === true, '');
  r = await A.post('/mc/favorite', { id: yq.id, on: false });
  r = await A.get('/mc/favorites');
  ck('G4 取消收藏 → 列表空', r.body.tracks.length === 0, JSON.stringify(r.body).slice(0, 120));

  // ---------- ⑧ 歌词（假 LRCLIB） ----------
  r = await A.get('/mc/lyrics/' + yq.id);
  ck('H1 get 404 → search 兜底命中 syncedLyrics', r.status === 200 && r.body.ok === true && r.body.synced === true && r.body.text.includes('第一行'), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const hitsBefore = lrclibHits;
  r = await A.get('/mc/lyrics/' + yq.id);
  ck('H2 二次请求走缓存（不再打 LRCLIB）', r.body.cached === true && lrclibHits === hitsBefore, `hits ${hitsBefore}->${lrclibHits}`);
  rateLimited = true;
  r = await A.get('/mc/lyrics/' + laogeId);
  ck('H3 LRCLIB 429 → 如实回限流秒数（不是 500）', r.status === 200 && r.body.ok === false && /限流/.test(r.body.error) && r.body.error.includes('7'), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  rateLimited = false;

  // ---------- ⑨ 权限 ----------
  ck('I1 pageForPath(/mc/library) 判到 smarthome 页', pageForPath('/mc/library') === 'smarthome', String(pageForPath('/mc/library')));
  ck('I2 tabForPath 判到 music tab', tabForPath('smarthome', '/mc/settings') === 'music', String(tabForPath('smarthome', '/mc/settings')));
  const mk = (name, tabs) => fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: name, password: 'un123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: tabs } }),
  });
  await mk('uMusicHa', ['ha']);
  await mk('uMusicOk', ['music']);
  const haU = await login(B, 'uMusicHa', 'un123456');
  const okU = await login(B, 'uMusicOk', 'un123456');
  const haApi = api(B, haU.H), okApi = api(B, okU.H);
  r = await haApi.get('/mc/library');
  ck('I3 只有 ha tab：/mc/library 403', r.status === 403, String(r.status));
  r = await okApi.get('/mc/library');
  ck('I4 有 music tab：/mc/library 200', r.status === 200, String(r.status));
  r = await okApi.post('/mc/settings', { root: MUSIC_NORM });
  ck('I5 music tab 非管理员：/mc/settings 403', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await okApi.post('/mc/scan', {});
  ck('I6 music tab 非管理员：/mc/scan 403', r.status === 403, String(r.status));
  r = await okApi.get('/mc/config');
  ck('I7 非管理员 is_admin=false（面板据此藏配置）', r.body.is_admin === false, JSON.stringify(r.body).slice(0, 120));
  r = await fetch(`${B}/api/mc/library`);
  ck('I8 未登录 401', r.status === 401, String(r.status));
  r = await okApi.post('/mc/favorite', { id: yq.id, on: true });
  r = await A.get('/mc/favorites');
  ck('I9 收藏按 user_id 隔离：普通用户收的歌不进 admin 列表', r.body.tracks.length === 0, JSON.stringify(r.body).slice(0, 120));
  r = await A.post('/mc/settings', { root: '' });
  ck('I10 清空 root → ok 且 root_ok=false', r.body.ok === true && r.body.root_ok === false, JSON.stringify(r.body));
} finally {
  srv.stop();
  lrclib.close();
  try { fs.rmSync(MUSIC, { recursive: true, force: true }); } catch { /* Windows 句柄迟滞，留给系统清理 */ }
}
done() && process.exit(0);
process.exit(1);
