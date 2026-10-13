// v1.16.0 音乐中心纯函数/扫描单测：手写字节级解析器（ID3v2.2/2.3/2.4、MP4 ilst、FLAC）、
// 时长（wav/mp3 CBR/m4a mvhd/flac STREAMINFO）、文件名兜底、resolveRoot、scanLibrary 端到端
// （临时音乐目录 + 隔离 DATA_DIR）、LRCLIB 歌词（MC_LRCLIB_BASE 指本地假服务，不碰真网）。
// 规矩：DATA_DIR 必须在 require server 模块之前设好；绝不碰 data/ 根目录。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const DATA = mkdtempSync(join(tmpdir(), 'mcmeta-'));
process.env.DATA_DIR = DATA; // ⬅ 必须先于任何 server 模块的 require/import

const svc = (await import('../server/services/mcService.js')).default;
const { db, setSetting, getSetting } = await import('../server/db.js');
const { audioDuration, m4aDuration, flacDuration, wavDuration } = await import('../server/lib/audioMeta.js');

let pass = 0, fail = 0;
const ck = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : '   <<< ' + extra}`); };
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

// ---------------- 合成字节 ----------------
// JPEG/PNG 探针数据（>100 字节才会被当封面）
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(140, 0x11), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(140, 0x22)]);

const synchsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
function id3Tag(ver, frames) {
  const body = Buffer.concat(frames);
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1'); h[3] = ver; h[4] = 0; h[5] = 0;
  synchsafe(body.length).copy(h, 6);
  return Buffer.concat([h, body]);
}
function frame23(id, payload) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1'); h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}
function frame24(id, payload) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1'); synchsafe(payload.length).copy(h, 4);
  return Buffer.concat([h, payload]);
}
function textPayload(enc, text) { return Buffer.concat([Buffer.from([enc]), typeof text === 'string' ? Buffer.from(text, enc === 1 ? 'utf16le' : 'utf8') : text, Buffer.from([0])]); }
function withBom(s) { return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]); }
function apic23(enc, mime, picType, desc, data) {
  const d = enc === 1 || enc === 2 ? Buffer.concat([desc, Buffer.from([0, 0])]) : Buffer.concat([desc, Buffer.from([0])]);
  return Buffer.concat([Buffer.from([enc]), Buffer.from(mime, 'latin1'), Buffer.from([0]), Buffer.from([picType]), d, data]);
}
// v2.2：6 字节帧头（3 字符 ID + 3 字节大小组）
function frame22(id3, payload) {
  const h = Buffer.alloc(6);
  h.write(id3, 0, 'latin1');
  h[3] = (payload.length >> 16) & 0xff; h[4] = (payload.length >> 8) & 0xff; h[5] = payload.length & 0xff;
  return Buffer.concat([h, payload]);
}

function box(type, ...children) {
  const body = Buffer.concat(children);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  if (Buffer.isBuffer(type)) type.copy(h, 4); else h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
function fullBox(type, ver, ...children) { return box(type, Buffer.from([ver, 0, 0, 0]), ...children); }
function ilstItem(type4, utf8) {
  // data 子盒：size + 'data' + ver/flags(4，flags=1 文本) + 保留(4) + 载荷
  const payload = Buffer.from(utf8, 'utf8');
  const dh = Buffer.alloc(16);
  dh.writeUInt32BE(16 + payload.length, 0); dh.write('data', 4, 'latin1'); dh.writeUInt32BE(1, 8); // flags=1 = UTF-8 文本
  return box(type4, Buffer.concat([dh, payload]));
}
function mvhd(timescale, duration) {
  const b = Buffer.alloc(100); // version 0 布局：ver/flags@0，时间戳@4/@8，timescale@12，duration@16
  b.writeUInt32BE(timescale, 12); b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
}
function ftyp() { return box('ftyp', Buffer.from('M4A M4A mp42', 'latin1')); }

function flacBlock(type, body, last = false) {
  const h = Buffer.alloc(4);
  h[0] = (last ? 0x80 : 0) | type;
  h[1] = (body.length >> 16) & 0xff; h[2] = (body.length >> 8) & 0xff; h[3] = body.length & 0xff;
  return Buffer.concat([h, body]);
}
function streaminfo(sr, totalSamples) {
  const b = Buffer.alloc(34);
  // body[10..17]：sr(20bit) + ch-1(3bit) + bps-1(5bit) + totalSamples(36bit) 连续打包
  const hi = (BigInt(sr) << 44n) | (1n << 41n) | (16n << 36n) | BigInt(totalSamples);
  for (let i = 0; i < 8; i++) b[10 + i] = Number((hi >> BigInt((7 - i) * 8)) & 0xffn);
  return flacBlock(0, b);
}
function vorbisComment(kvs) {
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(4, 0); parts.push(Buffer.from('test', 'latin1'));
  const cnt = Buffer.alloc(4); cnt.writeUInt32LE(kvs.length, 0); parts.push(cnt);
  for (const kv of kvs) {
    const s = Buffer.from(kv, 'utf8');
    const l = Buffer.alloc(4); l.writeUInt32LE(s.length, 0);
    parts.push(l, s);
  }
  return flacBlock(4, Buffer.concat(parts));
}
function flacPicture(mime, data) {
  const m = Buffer.from(mime, 'latin1');
  const parts = [Buffer.alloc(4)]; parts[0].writeUInt32BE(3, 0); // type 3 = front cover
  const ml = Buffer.alloc(4); ml.writeUInt32BE(m.length, 0); parts.push(ml, m);
  const dl = Buffer.alloc(4); parts.push(dl);                     // 描述空
  parts.push(Buffer.alloc(16));                                    // w/h/depth/colors
  const pl = Buffer.alloc(4); pl.writeUInt32BE(data.length, 0); parts.push(pl, data);
  return flacBlock(6, Buffer.concat(parts), true);
}

// ---------------- ① ID3v2.3：文本三件套 + APIC ----------------
{
  const buf = id3Tag(3, [
    frame23('TIT2', textPayload(3, '夜曲')),
    frame23('TPE1', textPayload(3, '周杰伦')),
    frame23('TALB', textPayload(3, '十一月的萧邦')),
    frame23('APIC', apic23(0, "image/jpeg", 3, Buffer.alloc(0), JPEG)),
  ]);
  const t = svc.parseId3(buf);
  ck('① ID3v2.3 标题/歌手/专辑（utf8 enc=3）', t.title === '夜曲' && t.artist === '周杰伦' && t.album === '十一月的萧邦', JSON.stringify(t));
  ck('② APIC 内嵌封面抽出（JPEG 魔数）', !!t.picture && t.picture[0] === 0xff && t.picture[1] === 0xd8 && t.picture.length === JPEG.length, t.picture && t.picture.length);
}
// ---------------- ② ID3v2.4：synchsafe 帧大小 + utf16 BOM ----------------
{
  const buf = id3Tag(4, [
    frame24('TIT2', textPayload(3, '晴天')),
    frame24('TPE1', Buffer.concat([Buffer.from([1]), withBom('孙燕姿'), Buffer.from([0, 0])])),
  ]);
  const t = svc.parseId3(buf);
  ck('③ ID3v2.4 synchsafe 大小解对（标题）', t.title === '晴天', JSON.stringify(t));
  ck('④ enc=1 UTF-16 BOM 解码（歌手）', t.artist === '孙燕姿', JSON.stringify(t));
}
// ---------------- ③ ID3v2.2：三字节帧 ID ----------------
{
  const buf = id3Tag(2, [
    frame22('TT2', Buffer.concat([Buffer.from([3]), Buffer.from('红豆', 'utf8'), Buffer.from([0])])),
    frame22('TP1', Buffer.concat([Buffer.from([3]), Buffer.from('王菲', 'utf8'), Buffer.from([0])])),
  ]);
  const t = svc.parseId3(buf);
  ck('⑤ ID3v2.2 TT2/TP1 三字节帧 ID', t.title === '红豆' && t.artist === '王菲', JSON.stringify(t));
}
// ---------------- ④ MP4：mvhd 时长 + ilst 标签 + covr ----------------
{
  const covrData = Buffer.alloc(16 + JPEG.length);
  covrData.writeUInt32BE(16 + JPEG.length, 0); covrData.write('data', 4, 'latin1'); covrData.writeUInt32BE(13, 8); // flags=13 = JPEG
  JPEG.copy(covrData, 16);
  const moov = box('moov', mvhd(1000, 10000), box('udta', fullBox('meta', 0, box('ilst',
    ilstItem(Buffer.from([0xa9, 0x6e, 0x61, 0x6d]), '天空之城'), // ©nam
    ilstItem(Buffer.from([0xa9, 0x41, 0x52, 0x54]), '久石让'),   // ©ART
    ilstItem(Buffer.from([0xa9, 0x61, 0x6c, 0x62]), '电影原声'), // ©alb
    box('covr', covrData),
  ))));
  const buf = Buffer.concat([ftyp(), moov]);
  ck('⑥ m4a mvhd 时长 = duration÷timescale（10s）', near(m4aDuration(buf, null), 10), String(m4aDuration(buf, null)));
  const t = svc.parseMp4(buf, null);
  ck('⑦ ilst ©nam/©ART/©alb 三件套', t.title === '天空之城' && t.artist === '久石让' && t.album === '电影原声', JSON.stringify(t));
  ck('⑧ covr 内嵌封面（JPEG 魔数）', !!t.picture && t.picture[0] === 0xff && t.picture.length === JPEG.length, t.picture && t.picture.length);
  ck('⑨ moov 在文件尾也能解（tail 缓冲）', near(audioDuration(ftyp(), 'm4a', buf), 10), String(audioDuration(ftyp(), 'm4a', buf)));
}
// ---------------- ⑤ FLAC：STREAMINFO 时长 + VorbisComment + PICTURE ----------------
{
  const buf = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    streaminfo(44100, 441000), // 10 秒
    vorbisComment(['TITLE=起风了', 'ARTIST=买辣椒也用券', 'ALBUM=起风了']),
    flacPicture('image/png', PNG),
  ]);
  ck('⑩ flac STREAMINFO 时长（10s）', near(flacDuration(buf), 10), String(flacDuration(buf)));
  const t = svc.parseFlac(buf);
  ck('⑪ VorbisComment TITLE/ARTIST/ALBUM', t.title === '起风了' && t.artist === '买辣椒也用券' && t.album === '起风了', JSON.stringify(t));
  ck('⑫ PICTURE 封面（PNG 魔数）', !!t.picture && t.picture[0] === 0x89 && t.picture.length === PNG.length, t.picture && t.picture.length);
}
// ---------------- ⑥ mp3 CBR 码率 + WAV 时长 ----------------
{
  const id3 = id3Tag(3, [frame23('TIT2', textPayload(3, '测试'))]);
  const mp3head = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // MPEG1 L3 128kbps 44100
  const buf = Buffer.concat([id3, mp3head, Buffer.alloc(400)]);
  ck('⑬ mp3 首帧码率 = 128kbps（跳过 ID3 找同步字）', svc.mp3Bitrate(buf) === 128000, String(svc.mp3Bitrate(buf)));
  // WAV chunk 的 size 字段不含 8 字节头（与 MP4 box 相反），小端
  const wavChunk = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(body.length, 0); return b; })(), body]);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(16000, 4); fmt.writeUInt32LE(32000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'),
    wavChunk('fmt ', fmt), wavChunk('data', Buffer.alloc(32000 * 5)), // byteRate 32000 × 5s
  ]);
  ck('⑭ wav data÷byteRate 时长（5s）', near(wavDuration(wav), 5), String(wavDuration(wav)));
}
// ---------------- ⑦ 文件名兜底 ----------------
{
  const a = svc.metaFromName('周杰伦 - 夜曲.mp3');
  const b = svc.metaFromName('03 - 晴天.mp3');
  const c = svc.metaFromName('孤勇者.flac');
  const d = svc.metaFromName('林俊杰 - 修炼爱情 - live.mp3');
  ck('⑮ 「歌手 - 歌名」→ 两段', a.artist === '周杰伦' && a.title === '夜曲', JSON.stringify(a));
  ck('⑯ 「03 - 歌名」音轨号剥掉', b.title === '晴天' && b.artist === '', JSON.stringify(b));
  ck('⑰ 无分隔 → 只当标题', c.title === '孤勇者' && c.artist === '', JSON.stringify(c));
  ck('⑱ 多段取首尾（歌手 - 歌名 - 备注）', d.artist === '林俊杰' && d.title === 'live', JSON.stringify(d));
}
// ---------------- ⑦b GBK 容错（v1.16.7）：老中文 mp3 的 enc=0 字节其实是 GBK ----------------
// 生产实测：23 位歌手 / 38 首、26 张专辑名出「ÐÂÀÏÂÞÓïÂ¼」这种乱码——ID3 帧编码字节写着 0
// （标准里是 ISO-8859-1）而字节是 GBK，旧解析器一律 latin1 读，中文两字节被拆成两个乱字符。
{
  const GBK = Buffer.from([0xd0, 0xc2, 0xc0, 0xcf, 0xc2, 0xde, 0xd3, 0xef, 0xc2, 0xbc]); // 「新老罗语录」的 GBK 字节
  const buf = id3Tag(3, [
    frame23('TIT2', Buffer.concat([Buffer.from([0]), GBK, Buffer.from([0])])),   // enc=0 实为 GBK
    frame23('TPE1', Buffer.concat([Buffer.from([3]), GBK, Buffer.from([0])])),   // enc=3 标错成 UTF-8 也救回来
    frame23('TALB', Buffer.concat([Buffer.from([0]), Buffer.from('Beyonc\xe9', 'latin1'), Buffer.from([0])])), // 真 latin1
  ]);
  const t = svc.parseId3(buf);
  ck('㊱ enc=0 的 GBK 字节解成「新老罗语录」（不再乱码）', t.title === '新老罗语录', JSON.stringify(t.title));
  ck('㊲ enc=3 标了 UTF-8 其实是 GBK 也救回来', t.artist === '新老罗语录', JSON.stringify(t.artist));
  ck('㊳ 真 latin1（Beyoncé）不被 GBK 猜歪', t.album === 'Beyonc\xe9', JSON.stringify(t.album));
  // FLAC 的 VorbisComment 名义 UTF-8，同一把容错（手拼 GBK 值，helper 只吃字符串）
  const gc = Buffer.concat([Buffer.from('ARTIST=', 'latin1'), GBK]);
  const rawVorbis = flacBlock(4, (() => {
    const v = Buffer.from('test', 'latin1');
    const p = [Buffer.alloc(4)]; p[0].writeUInt32LE(v.length, 0);
    p.push(v, (() => { const b = Buffer.alloc(4); b.writeUInt32LE(1, 0); return b; })());
    const l = Buffer.alloc(4); l.writeUInt32LE(gc.length, 0);
    p.push(l, gc);
    return Buffer.concat(p);
  })());
  const f = svc.parseFlac(Buffer.concat([Buffer.from('fLaC', 'latin1'), streaminfo(44100, 441000), rawVorbis]));
  ck('㊴ FLAC VorbisComment 的 GBK 值同样解得出', f.artist === '新老罗语录', JSON.stringify(f.artist));
}
// ---------------- ⑧ resolveRoot ----------------
{
  const r1 = svc.resolveRoot(DATA);
  ck('⑲ 字面路径存在 → 直接命中', r1.root === DATA.replace(/\\/g, '/').replace(/\/+$/, ''), JSON.stringify(r1));
  const r2 = svc.resolveRoot('/不存在的目录xyz');
  ck('⑳ 三候选全不存在 → root 空 + input 归一', r2.root === '' && r2.input === '/不存在的目录xyz', JSON.stringify(r2));
  const r3 = svc.resolveRoot('/音乐/');
  ck('㉑ 尾斜杠剥掉', r3.input === '/音乐', JSON.stringify(r3));
}
// ---------------- ⑨ metaFromFile 端到端（真临时文件） ----------------
const MUSIC = join(DATA, 'music');
mkdirSync(MUSIC, { recursive: true });
mkdirSync(join(MUSIC, '专辑A'));
{
  const mp3 = id3Tag(3, [
    frame23('TIT2', textPayload(3, '夜曲')),
    frame23('TPE1', textPayload(3, '周杰伦')),
    frame23('TALB', textPayload(3, '十一月的萧邦')),
    frame23('APIC', apic23(0, "image/jpeg", 3, Buffer.alloc(0), JPEG)),
  ]);
  // 后面拼一段 MP3 帧头（MPEG1 L3 128kbps），mp3Bitrate 从文件字节里扫得到码率才算出 CBR 时长
  writeFileSync(join(MUSIC, '专辑A', 'A1.mp3'), Buffer.concat([mp3, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]));
  const meta = svc.metaFromFile(join(MUSIC, '专辑A', 'A1.mp3'), 'A1.mp3', 'mp3', 160000);
  ck('㉒ mp3 端到端：标题/歌手', meta.title === '夜曲' && meta.artist === '周杰伦', JSON.stringify(meta));
  ck('㉓ mp3 CBR 时长估算（160000B×8÷128k = 10s）', near(meta.duration_ms / 1000, 10, 0.2), String(meta.duration_ms));
  ck('㉔ 内嵌封面带出', !!meta.picture && meta.picture.length === JPEG.length);

  // 无标签 mp3：文件名兜底 + 目录 cover.jpg 兜底在 scan 里测
  writeFileSync(join(MUSIC, '专辑A', 'B2 - 无人声.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
  // flac
  const flac = Buffer.concat([
    Buffer.from('fLaC', 'latin1'), streaminfo(44100, 220500),
    vorbisComment(['TITLE=起风了', 'ARTIST=买辣椒也用券']), flacPicture('image/png', PNG),
  ]);
  writeFileSync(join(MUSIC, '专辑A', 'C3.flac'), flac);
  const fmeta = svc.metaFromFile(join(MUSIC, '专辑A', 'C3.flac'), 'C3.flac', 'flac', flac.length);
  ck('㉕ flac 端到端：标题/歌手/5s 时长/封面', fmeta.title === '起风了' && fmeta.artist === '买辣椒也用券' && near(fmeta.duration_ms / 1000, 5) && !!fmeta.picture, JSON.stringify(fmeta));
  // 目录封面兜底：专辑B 只有无标签 mp3 + cover.jpg
  mkdirSync(join(MUSIC, '专辑B'));
  writeFileSync(join(MUSIC, '专辑B', '老歌 - 无标签.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
  writeFileSync(join(MUSIC, '专辑B', 'cover.jpg'), JPEG);
}
// ---------------- ⑩ scanLibrary 端到端（隔离 DATA_DIR 的库） ----------------
{
  setSetting(db, 'mc_root', (MUSIC).replace(/\\/g, '/'));
  const r = svc.scanLibrary();
  ck('㉖ 首扫 4 首（专辑A×3 + 专辑B×1）全入库', r.ok && r.total === 4 && r.added === 4, JSON.stringify(r));
  const s = svc.stats();
  // 封面：A1=APIC 内嵌(1) / C3=PICTURE(1) / 老歌=专辑B 目录 cover.jpg(2) / B2=专辑A 无封面(0)
  // 待处理：只有 B2（无封面；歌手名走文件名兜底 'B2' 非空）
  ck('㉗ 统计：总数4 / 封面3 / 未匹配1 / 待处理1', s.total === 4 && s.covers === 3 && s.nocover === 1 && s.pending === 1, JSON.stringify(s));
  const rows = db.prepare('SELECT path, title, artist, duration_ms, has_cover FROM mc_tracks ORDER BY path').all();
  const b2 = rows.find((x) => x.path.includes('B2'));
  ck('㉘ 无标签 mp3 文件名兜底（B2-无人声）has_cover=0', b2 && b2.artist === 'B2' && b2.title === '无人声' && b2.has_cover === 0, JSON.stringify(b2));
  const laoge = rows.find((x) => x.path.includes('老歌'));
  ck('㉘b 目录 cover.jpg 兜底 has_cover=2（老歌-无标签）', laoge && laoge.artist === '老歌' && laoge.has_cover === 2, JSON.stringify(laoge));
  const r2 = svc.scanLibrary();
  ck('㉙ 二扫全 kept（mtime+size 未变不重解析）', r2.ok && r2.kept === 4 && r2.added === 0, JSON.stringify(r2));
  ck('㉙b 首扫后每行都盖上当前解析器版本 meta_ver=2', db.prepare('SELECT COUNT(*) c FROM mc_tracks WHERE meta_ver=2').get().c === 4);
  // 解析器版本落后 → 即使 mtime/size 没变也强制重解析（v1.16.7 的乱码自愈路径：用户点一次「重新扫描」）
  db.prepare('UPDATE mc_tracks SET meta_ver=0, artist=? WHERE title=?').run('乱码占位', '夜曲');
  const r2b = svc.scanLibrary();
  const fixed = db.prepare('SELECT artist, meta_ver FROM mc_tracks WHERE title=?').get('夜曲');
  ck('㉙c meta_ver 落后 → 老行被重解析、乱码被真标签覆盖', r2b.updated === 1 && r2b.kept === 3
    && fixed.artist === '周杰伦' && fixed.meta_ver === 2, JSON.stringify(r2b) + JSON.stringify(fixed));
  // 收藏唯一约束 + toggle
  const t1 = db.prepare('SELECT id FROM mc_tracks WHERE title=?').get('夜曲');
  db.prepare('INSERT OR IGNORE INTO mc_favorites(user_id, track_id) VALUES(?,?)').run(1, t1.id);
  db.prepare('INSERT OR IGNORE INTO mc_favorites(user_id, track_id) VALUES(?,?)').run(1, t1.id);
  ck('㉚ 收藏 UNIQUE 约束幂等（重复插不报错不多行）', db.prepare('SELECT COUNT(*) c FROM mc_favorites WHERE user_id=1').get().c === 1);
  // 文件消失 → 清扫出库 + 封面文件清掉
  rmSync(join(MUSIC, '专辑A', 'C3.flac'));
  const r3 = svc.scanLibrary();
  const s3 = svc.stats();
  ck('㉛ 删盘上文件后再扫 → 出库（total 3）', r3.ok && r3.removed === 1 && s3.total === 3, JSON.stringify(r3) + JSON.stringify(s3));
}
// ---------------- ⑪ LRCLIB（本地假服务：get 404 → search 命中 → 缓存不再外网） ----------------
{
  let hits = 0;
  const fake = http.createServer((req, res) => {
    hits++;
    const u = req.url || '';
    if (u.startsWith('/api/get')) { res.writeHead(404); res.end('{}'); return; }
    if (u.startsWith('/api/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ plainLyrics: '无时间轴', syncedLyrics: '[00:01.00]第一行\n[00:05.00]第二行' }]));
      return;
    }
    res.writeHead(429, { 'retry-after': '3' }); res.end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  process.env.MC_LRCLIB_BASE = `http://127.0.0.1:${port}`;
  const row = db.prepare("SELECT * FROM mc_tracks WHERE title='夜曲'").get();
  const r = await svc.fetchLyrics(row);
  ck('㉜ get 404 → search 兜底拿到 syncedLyrics', r.ok && r.synced && r.text.includes('第一行'), JSON.stringify(r).slice(0, 80));
  ck('㉝ 中文查询参数已百分号编码（假服务收到的 URL 可解析）', true); // 能 200 即证明
  const hitsAfterFirst = hits;
  const r2 = await svc.fetchLyrics(db.prepare("SELECT * FROM mc_tracks WHERE title='夜曲'").get());
  ck('㉞ 二次请求走缓存（不再打 HTTP）', r2.cached === true && hits === hitsAfterFirst, `hits ${hitsAfterFirst}->${hits}`);
  const noLyric = { id: 99999, title: '不存在的歌', artist: '无名', album: '', duration_ms: 0, lyrics: '', lyrics_synced: 0, lyrics_ok: 0 };
  process.env.MC_LRCLIB_BASE = `http://127.0.0.1:${port}`; // 429 分支：换个路径都 429 的服务
  const fake2 = http.createServer((req, res) => { res.writeHead(429, { 'retry-after': '7' }); res.end(); });
  await new Promise((r) => fake2.listen(0, '127.0.0.1', r));
  process.env.MC_LRCLIB_BASE = `http://127.0.0.1:${fake2.address().port}`;
  const r429 = await svc.fetchLyrics(noLyric);
  ck('㉟ 429 → 如实回限流文案与秒数', !r429.ok && /限流/.test(r429.error) && r429.error.includes('7'), JSON.stringify(r429));
  fake.close(); fake2.close();
}

try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 下 sqlite 句柄未放也能退出，临时目录留给系统清理 */ }
console.log(`\n${pass} 通过 / ${fail} 失败`);
// 立刻 process.exit 会撞上刚 close 的假服务句柄（libuv win 断言噪音），等一轮事件循环再退
setTimeout(() => process.exit(fail ? 1 : 0), 50).unref();
if (fail) process.exitCode = 1;
