// 音乐中心服务（v1.16.0，人工智能页「音乐」tab）：曲库扫描 / 元数据解析 / 封面抽取 / LRCLIB 歌词。
// 铁律：零新 npm 依赖（升级链不跑 npm install）——ID3v2.2/2.3/2.4、MP4 ilst、FLAC VorbisComment
// 全部手写字节级解析；时长复用 lib/audioMeta.js（本版已扩展 m4a/flac）。
// 数据：主库 mc_tracks / mc_favorites（家庭共享曲库，与租户无关）；封面落 data/mc/covers/<id>.jpg。
// 根目录：设置页只存「短路径」（如 /音乐），服务端解析时自动试 /vol2/1000 与 /vol1/1000 前缀——
// 用户 NAS 上音乐在 /vol2/1000/音乐，但界面上只想填 /音乐（2026-10-13 需求原话）。
const fs = require('fs');
const path = require('path');
const { db, getSetting, dataDir } = require('../db');
const { audioDuration } = require('../lib/audioMeta');

const AUDIO_EXTS = ['mp3', 'flac', 'm4a', 'mp4', 'wav', 'ogg', 'opus', 'aac'];
// 目录封面兜底：文件夹里常见的手工封面名（v1.16.1 起可在设置页「音乐海报」卡里改）
const DEFAULT_COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.png', 'album.jpg', 'Cover.jpg', 'Cover.PNG'];
const DEFAULT_LYRICS_API = 'https://lrclib.net';
// NAS 容器挂载约定：宿主 /volN/1000/xxx 与容器内同路径直通（§6.6 的「宿主同路径」挂载）
const NAS_PREFIXES = ['', '/vol2/1000', '/vol1/1000'];
const COVER_DIR = path.join(dataDir, 'mc', 'covers');
const HEAD_BYTES = 512 * 1024;   // 头部读取量：装得下 ID3 全部文本帧 + 常见内嵌封面（专辑图几十~几百 KB）
const TAIL_BYTES = 1024 * 1024;  // m4a 兜底：moov 可能在文件尾（流式封装）
const SCAN_FILE_CAP = 20000;     // 单次扫描文件数上限（防误指到超大目录把请求拖死）

// ---------- 根目录解析：用户填短路径（/音乐），按前缀候选表找真实目录 ----------
// Windows 本机直跑时允许盘符路径（D:/音乐——不加前导斜杠，e2e/本地开发要用）
function resolveRoot(input) {
  const raw = String(input || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return { input: '', root: '', matched: '' };
  const isWinAbs = /^[A-Za-z]:/.test(raw);
  const norm = isWinAbs || raw.startsWith('/') ? raw : '/' + raw;
  for (const pre of NAS_PREFIXES) {
    const p = pre + norm;
    try { if (fs.statSync(p).isDirectory()) return { input: norm, root: p, matched: p }; } catch { /* 试下一个 */ }
  }
  return { input: norm, root: '', matched: '' };
}
function mcRootSetting() { return String(getSetting(db, 'mc_root', '') || '').trim(); }

// ---------- v1.16.1 三张设置卡（音乐路径已在上方 / 音乐海报 / 歌词 API）都落 settings 表 ----------
// 海报（封面）文件名清单：逗号/换行分隔，最多 30 条；每条自动补一份大小写变体（NAS 上文件名大小写常不一致）
function coverNamesSetting() {
  const raw = String(getSetting(db, 'mc_cover_names', '') || '').trim();
  if (!raw) return DEFAULT_COVER_NAMES.slice();
  const out = [];
  for (const name of raw.split(/[\s,;，、]+/)) {
    const n = name.trim().replace(/^[\\/]+/, '');
    if (!n || n.includes('..')) continue;
    if (!out.includes(n)) out.push(n);
    const alt = n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n.toLowerCase();
    if (!out.includes(alt)) out.push(alt);
    if (out.length >= 60) break;
  }
  return out.length ? out : DEFAULT_COVER_NAMES.slice();
}
// 封面优先级：embed（默认，内嵌封面优先）/ dir（目录里的 cover.jpg 优先）
function coverPrioritySetting() { return getSetting(db, 'mc_cover_priority', 'embed') === 'dir' ? 'dir' : 'embed'; }
// 全屏播放页背景：color（默认，封面主色渐变）/ dark（固定深色）
function fullBgSetting() { return getSetting(db, 'mc_full_bg', 'color') === 'dark' ? 'dark' : 'color'; }
// 歌词 API 基址：设置页 > 环境变量 MC_LRCLIB_BASE > 内置默认；去掉尾部斜杠
function lyricsApiSetting() {
  const s = String(getSetting(db, 'mc_lyrics_api', '') || '').trim();
  const e = String(process.env.MC_LRCLIB_BASE || '').trim();
  return (s || e || DEFAULT_LYRICS_API).replace(/\/+$/, '');
}
function lyricsApiSource() { // 让设置页能如实说出「这个地址是哪来的」
  if (String(getSetting(db, 'mc_lyrics_api', '') || '').trim()) return 'setting';
  if (String(process.env.MC_LRCLIB_BASE || '').trim()) return 'env';
  return 'default';
}
function lyricsCachedCount() {
  return db.prepare('SELECT COUNT(*) n FROM mc_tracks WHERE lyrics_ok=1').get().n || 0;
}
// 清空歌词缓存（已命中的也会重新联网匹配）——设置页随改地址/想重挑歌词时用
function clearLyricsCache() {
  const r = db.prepare(`UPDATE mc_tracks SET lyrics='', lyrics_synced=0, lyrics_ok=0 WHERE lyrics_ok=1 OR lyrics<>''`).run();
  return { ok: true, cleared: r.changes };
}
// 探歌词服务（服务端代探：容器里能连 ≠ 用户浏览器能连，这里要的就是「NAS 能不能连」）
async function testLyricsApi(base) {
  const b = String(base || '').trim().replace(/\/+$/, '') || lyricsApiSetting();
  if (!/^https?:\/\//i.test(b)) return { ok: false, error: '地址要以 http:// 或 https:// 开头', tried: b };
  const url = `${b}/api/search?q=test`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'WorkbenchMusic/1.0' } });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, tried: url, ms, error: `服务返回 HTTP ${res.status}（正常应为 200）` };
    const j = await res.json().catch(() => null);
    if (!Array.isArray(j)) return { ok: false, tried: url, ms, error: '返回的不是歌词检索结果（这个地址不是 LRCLIB 兼容服务？）' };
    return { ok: true, tried: url, ms, hits: j.length };
  } catch (e) {
    return { ok: false, tried: url, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? '连接超时（10 秒）' : (e.message || '连接失败') };
  }
}

// 解析器版本（v1.16.7）：写进 mc_tracks.meta_ver。mtime/size 没变但版本落后时也要重解析，
// 否则修了解码器、老行还挂着乱码（用户点一次「重新扫描」即自愈）。改解析逻辑就 +1。
const META_VER = 2;

// ---------- 文本解码（ID3 enc 0/1/2/3） ----------
// v1.16.7 修：中文老 mp3 的通病——ID3 帧的编码字节写着 0（标准里是 ISO-8859-1），字节却是 GBK。
// 一律按 latin1 读就出「ÐÂÀÏÂÞÓïÂ¼」这种乱码（生产实测 23 位歌手 / 38 首、26 张专辑名）。
// 规则：先严格 UTF-8 试（能解就用，覆盖 enc 写错但其实是 UTF-8 的情况）；不行再试 GBK；
// 两者都不行才落 latin1 原文——绝不把好数据改坏（纯 ASCII 与真 latin1 走原路）。
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbkDecoder = (() => { try { return new TextDecoder('gbk'); } catch { return null; } })(); // Node 官方包带 full-icu
function smartText(buf) {
  const b = Buffer.from(buf); // 别改原缓冲
  try { return utf8Strict.decode(b); } catch { /* 不是合法 UTF-8 */ }
  if (gbkDecoder) {
    try { const s = gbkDecoder.decode(b); if (!s.includes('�')) return s; } catch { /* 也不是 GBK */ }
  }
  return b.toString('latin1');
}
function utf16BeToStr(buf) {
  const b = Buffer.from(buf); // 别改原缓冲
  for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return b.length % 2 ? b.slice(0, b.length - 1).toString('utf16le') : b.toString('utf16le');
}
function id3Text(buf, enc) {
  try {
    if (buf.length < 1) return '';
    if (enc === 1) {
      if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
      if (buf[0] === 0xfe && buf[1] === 0xff) return utf16BeToStr(buf.slice(2));
      return buf.toString('utf16le');
    }
    if (enc === 2) return utf16BeToStr(buf);
    if (enc === 3) return smartText(buf);   // 标了 UTF-8 也可能其实是 GBK，同样过一遍
    return smartText(buf);                  // enc 0（="latin1"）：见 smartText 的注释
  } catch { return ''; }
}
// 多值文本帧（v2.4 用 \0 分隔）：只取第一段
function firstNullPart(s) { return String(s || '').split('\u0000')[0].trim(); }

// ---------- ID3v2（mp3）：标题/歌手/专辑/年份/内嵌封面 ----------
function parseId3(head) {
  const out = { title: '', artist: '', album: '', year: '', picture: null };
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return out;
  const ver = head[3];
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const end = Math.min(10 + size, head.length);
  let p = 10;
  const idLen = ver === 2 ? 3 : 4;      // v2.2 三字节帧 ID（TT2/TP1/TAL），v2.3+ 四字节（TIT2/TPE1/TALB）
  const hdrLen = ver === 2 ? 6 : 10;
  while (p + hdrLen <= end) {
    let fid = '', fsize = 0;
    if (ver === 2) {
      fid = head.toString('latin1', p, p + 3);
      fsize = (head[p + 3] << 16) | (head[p + 4] << 8) | head[p + 5];
    } else {
      fid = head.toString('latin1', p, p + 4);
      // v2.4 帧大小是 synchsafe（每字节只用低 7 位）；v2.3 是普通 32 位大端
      fsize = ver === 4
        ? ((head[p + 4] & 0x7f) << 21) | ((head[p + 5] & 0x7f) << 14) | ((head[p + 6] & 0x7f) << 7) | (head[p + 7] & 0x7f)
        : head.readUInt32BE(p + 4);
    }
    if (!/^[A-Z0-9]+$/.test(fid) || fsize <= 0 || p + hdrLen + fsize > end) break;
    const body = head.slice(p + hdrLen, p + hdrLen + fsize);
    const set = (v) => { const t = firstNullPart(id3Text(body.slice(1), body[0])); if (t) out[v.k] = t; };
    if (fid === 'TIT2' || fid === 'TT2') set({ k: 'title' });
    else if (fid === 'TPE1' || fid === 'TP1') set({ k: 'artist' });
    else if (fid === 'TALB' || fid === 'TAL') set({ k: 'album' });
    else if (fid === 'TDRC' || fid === 'TYER' || fid === 'TYE') set({ k: 'year' });
    else if ((fid === 'APIC' || fid === 'PIC') && !out.picture && body.length > 14) {
      // APIC：enc(1) + MIME(\0 结尾) + 图类型(1) + 描述(enc 相关终结符) + 图数据
      // v2.2 PIC：enc(1) + 图格式三字节(jpg/png) + 图类型(1) + 描述 + 数据
      try {
        let dataOff = 0;
        if (fid === 'PIC') {
          const fmt = body.toString('latin1', 1, 4).toLowerCase();
          let q = 5 + 1; // enc(1)+fmt(3)+type(1) 之后找描述终结
          while (q < body.length && body[q] !== 0) q++;
          dataOff = q + 1;
          if (fmt === 'png' || body[dataOff + 1] === 0x50) out.picture = body.slice(dataOff);
          else out.picture = body.slice(dataOff);
        } else {
          let q = 1;
          while (q < body.length && body[q] !== 0) q++;       // MIME 结束
          const mime = body.toString('latin1', 1, q).toLowerCase();
          const enc = body[0];
          let d = q + 1 + 1;                                   // 过掉 \0 与图类型字节
          if (enc === 1 || enc === 2) { while (d + 1 < body.length && !(body[d] === 0 && body[d + 1] === 0)) d += 2; d += 2; }
          else { while (d < body.length && body[d] !== 0) d++; d += 1; }
          const data = body.slice(d);
          // 只收 JPEG/PNG（浏览器都能解；别的格式交给目录封面兜底）
          if (data.length > 100 && (mime.includes('jpeg') || mime.includes('jpg') || (data[0] === 0xff && data[1] === 0xd8) || mime.includes('png') || (data[0] === 0x89 && data[1] === 0x50))) out.picture = data;
        }
      } catch { /* 封面解不出来就当没有 */ }
    }
    p += hdrLen + fsize;
  }
  return out;
}

// ---------- MP4/M4A：moov→udta→meta→ilst（©nam/©ART/©alb/covr） + mvhd 时长 ----------
function ilstItems(buf, start, end, out) {
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > end) break;
    if (type === 'moov' || type === 'udta' || type === 'ilst' || type === 'trak' || type === 'mdia') {
      ilstItems(buf, p + 8, Math.min(p + size, end), out); // 一路下钻
    } else if (type === 'meta') {
      ilstItems(buf, p + 12, Math.min(p + size, end), out); // meta 头里多 4 字节 version/flags
    } else if (type === '©nam' || type === '©ART' || type === '©alb' || type === '©day' || type === 'covr') {
      // 条目盒里找 'data' 子盒：size(4)+'data'+version/flags(4)+保留(4)+载荷
      let q = p + 8;
      while (q + 16 <= Math.min(p + size, end)) {
        const s2 = buf.readUInt32BE(q);
        const t2 = buf.toString('latin1', q + 4, q + 8);
        if (s2 >= 16 && t2 === 'data') {
          const flags = buf.readUInt32BE(q + 8) & 0xffffff;
          const data = buf.slice(q + 16, Math.min(q + s2, end));
          if (type === 'covr') { if (!out.picture && data.length > 100) out.picture = data; }
          else {
            const t = smartText(data).trim(); // ilst 名义上 UTF-8，同样容错（见 smartText）
            if (t) out[type === '©nam' ? 'title' : type === '©ART' ? 'artist' : type === '©alb' ? 'album' : 'year'] = t;
          }
          break;
        }
        if (s2 < 8) break;
        q += s2;
      }
    }
    p += size;
  }
}
function parseMp4(head, tail) {
  const out = { title: '', artist: '', album: '', year: '', picture: null };
  ilstItems(head, 0, head.length, out);
  if (!out.title && !out.picture && tail) ilstItems(tail, 0, tail.length, out); // moov 在尾的流式封装
  return out;
}

// ---------- FLAC：STREAMINFO（时长）/ VORBIS_COMMENT（标题歌手专辑）/ PICTURE（封面） ----------
function parseFlac(head) {
  const out = { title: '', artist: '', album: '', year: '', picture: null };
  if (head.toString('latin1', 0, 4) !== 'fLaC') return out;
  let p = 4;
  while (p + 4 <= head.length) {
    const bh = head[p];
    const type = bh & 0x7f;
    const len = (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3];
    const body = p + 4;
    if (body + len > head.length) break;
    if (type === 4) {
      // VorbisComment：vendor_len(LE) + vendor + count(LE) + [len(LE) + 'K=V']
      try {
        let q = body;
        const vlen = head.readUInt32LE(q); q += 4 + vlen;
        const count = head.readUInt32LE(q); q += 4;
        for (let i = 0; i < count && q + 4 <= body + len; i++) {
          const cl = head.readUInt32LE(q); q += 4;
          const kv = smartText(head.slice(q, q + cl)); q += cl; // VorbisComment 名义上 UTF-8，同样容错
          const eq = kv.indexOf('=');
          if (eq < 0) continue;
          const k = kv.slice(0, eq).toUpperCase();
          const v = kv.slice(eq + 1).trim();
          if (!v) continue;
          if (k === 'TITLE') out.title = v;
          else if (k === 'ARTIST' || k === 'ALBUMARTIST') { if (!out.artist) out.artist = v; }
          else if (k === 'ALBUM') out.album = v;
          else if (k === 'DATE' || k === 'YEAR') out.year = v;
        }
      } catch { /* 注释块坏了就跳过 */ }
    } else if (type === 6 && !out.picture) {
      // PICTURE：type(4)+mime_len(4)+mime+desc_len(4)+desc+w/h/depth/colors(16)+data_len(4)+data
      try {
        let q = body + 4;
        const mlen = head.readUInt32BE(q); q += 4 + mlen;
        const dlen = head.readUInt32BE(q); q += 4 + dlen;
        q += 16;
        const dlen2 = head.readUInt32BE(q); q += 4;
        const data = head.slice(q, q + dlen2);
        if (dlen2 > 100) out.picture = data;
      } catch { /* 同上 */ }
    }
    if (bh & 0x80) break;
    p = body + len;
  }
  return out;
}

// ---------- mp3 首帧码率（CBR 时长估算：字节×8÷码率；比逐帧走头部缓冲更准） ----------
const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
function mp3Bitrate(head) {
  let pos = 0;
  if (head.length > 10 && head.toString('latin1', 0, 3) === 'ID3') {
    pos = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
  }
  for (let i = pos; i + 4 < head.length; i++) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (head[i + 1] >> 3) & 3;
    const layerBits = (head[i + 1] >> 1) & 3;
    if (verBits === 1 || layerBits !== 1) continue; // 只要 MPEG Layer3
    const br = (verBits === 3 ? BR_V1 : BR_V2)[(head[i + 2] >> 4) & 15] * 1000;
    if (br) return br;
  }
  return 0;
}

// ---------- 文件名兜底：「歌手 - 歌名」是中文乐库的主流命名 ----------
function metaFromName(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}[\s.\-_—–]+/, '').trim(); // 去掉「01.」类音轨号
  const parts = stem.split(/\s+[-—–]\s+/);
  if (parts.length >= 2) return { title: parts[parts.length - 1].trim(), artist: parts[0].trim() };
  return { title: stem, artist: '' };
}

// ---------- 单文件元数据（head 为主，m4a 惰性补读 tail） ----------
function metaFromFile(abs, name, ext, size) {
  let head = Buffer.alloc(0);
  let tail = null;
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    fs.readSync(fd, head, 0, head.length, 0);
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }

  let tags = null;
  let sec = 0;
  if (ext === 'mp3') {
    tags = parseId3(head);
    const br = mp3Bitrate(head);
    if (br > 0) sec = (size * 8) / br;                       // CBR 估算（含 ID3 开销，误差可忽略）
    if (!sec || sec > 36000) sec = audioDuration(head, 'mp3'); // 兜底：头部帧走表
  } else if (ext === 'm4a' || ext === 'mp4') {
    tags = parseMp4(head, null);
    sec = audioDuration(head, 'm4a', null);
    if (!sec || !tags.title) {
      // moov 在文件尾的流式封装：读尾 1MB 再试一遍
      try {
        fd = fs.openSync(abs, 'r');
        const n = Math.min(TAIL_BYTES, size);
        tail = Buffer.alloc(n);
        fs.readSync(fd, tail, 0, n, size - n);
        fs.closeSync(fd);
      } catch { tail = null; }
      if (tail) {
        if (!sec) sec = audioDuration(head, 'm4a', tail);
        if (!tags.title) {
          const t2 = parseMp4(tail, null);
          tags.title = tags.title || t2.title;
          tags.artist = tags.artist || t2.artist;
          tags.album = tags.album || t2.album;
          tags.picture = tags.picture || t2.picture;
        }
      }
    }
  } else if (ext === 'flac') {
    tags = parseFlac(head);
    sec = audioDuration(head, 'flac');
  } else if (ext === 'wav') {
    tags = { title: '', artist: '', album: '', year: '', picture: null };
    sec = audioDuration(head, 'wav');
  } else {
    tags = { title: '', artist: '', album: '', year: '', picture: null };
  }

  const fallback = metaFromName(name);
  return {
    title: (tags.title || '').trim() || fallback.title,
    artist: (tags.artist || '').trim() || fallback.artist,
    album: (tags.album || '').trim(),
    duration_ms: Math.max(0, Math.round((sec || 0) * 1000)),
    picture: tags.picture || null,
  };
}

// ---------- 目录封面兜底 ----------
function dirCover(absDir) {
  for (const n of coverNamesSetting()) {
    const p = path.join(absDir, n);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 试下一个 */ }
  }
  return '';
}

// ---------- 扫描：mtime+size 未变的跳过，变了重解析；消失的清扫出库 ----------
let scanning = false;
function scanLibrary() {
  const { root } = resolveRoot(mcRootSetting());
  if (!root) return { ok: false, error: '音乐目录未配置或不可访问' };
  if (scanning) return { ok: false, error: '扫描已在进行中' };
  scanning = true;
  const t0 = Date.now();
  let added = 0, updated = 0, kept = 0, removed = 0, files = 0;
  try {
    fs.mkdirSync(COVER_DIR, { recursive: true });
    const existing = new Map(db.prepare('SELECT id, path, size, mtime, meta_ver FROM mc_tracks').all().map((r) => [r.path, r]));
    const seen = new Set();
    const walk = (dir, rel, depth) => {
      if (depth > 8 || files >= SCAN_FILE_CAP) return;
      let names;
      try { names = fs.readdirSync(dir); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, 'zh'));
      for (const name of names) {
        if (name.startsWith('.') || name.startsWith('~$')) continue;
        const abs = path.join(dir, name);
        const rp = rel ? rel + '/' + name : name;
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) { walk(abs, rp, depth + 1); continue; }
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (!AUDIO_EXTS.includes(ext)) continue;
        if (++files > SCAN_FILE_CAP) break;
        seen.add(rp);
        const old = existing.get(rp);
        if (old && old.size === st.size && old.mtime === Math.floor(st.mtimeMs / 1000) && old.meta_ver === META_VER) { kept++; continue; }
        const meta = metaFromFile(abs, name, ext, st.size);
        if (!meta) continue;
        const mtime = Math.floor(st.mtimeMs / 1000);
        let id = old ? old.id : 0;
        if (old) {
          db.prepare(`UPDATE mc_tracks SET title=?, artist=?, album=?, duration_ms=?, size=?, mtime=?, scanned_at=?, meta_ver=? WHERE id=?`)
            .run(meta.title, meta.artist, meta.album, meta.duration_ms, st.size, mtime, t0, META_VER, old.id);
          updated++;
        } else {
          const r = db.prepare(`INSERT INTO mc_tracks(path, title, artist, album, duration_ms, size, mtime, scanned_at, meta_ver) VALUES(?,?,?,?,?,?,?,?,?)`)
            .run(rp, meta.title, meta.artist, meta.album, meta.duration_ms, st.size, mtime, t0, META_VER);
          id = Number(r.lastInsertRowid);
          added++;
        }
        // 封面：内嵌抽出落盘（has_cover=1）或目录 cover 图（has_cover=2，播放时现读目录文件）。
        // v1.16.1 起优先级可在设置页「音乐海报」卡切换（embed 内嵌优先 / dir 目录封面优先）
        const hasEmb = !!(meta.picture && meta.picture.length > 100);
        let embOk = false;
        if (hasEmb) {
          try { fs.writeFileSync(path.join(COVER_DIR, id + '.jpg'), meta.picture); embOk = true; } catch { /* 落盘失败按无封面 */ }
        }
        const hasDir = !!dirCover(dir);
        const pick = coverPrioritySetting() === 'dir'
          ? (hasDir ? 2 : (embOk ? 1 : 0))
          : (embOk ? 1 : (hasDir ? 2 : 0));
        db.prepare('UPDATE mc_tracks SET has_cover=? WHERE id=?').run(pick, id);
      }
    };
    walk(root, '', 0);
    for (const [rp, row] of existing) {
      if (!seen.has(rp)) {
        try { fs.unlinkSync(path.join(COVER_DIR, row.id + '.jpg')); } catch { /* 文件可能不存在 */ }
        db.prepare('DELETE FROM mc_favorites WHERE track_id=?').run(row.id);
        db.prepare('DELETE FROM mc_tracks WHERE id=?').run(row.id);
        removed++;
      }
    }
    return { ok: true, total: files, added, updated, kept, removed, ms: Date.now() - t0 };
  } finally { scanning = false; }
}

// ---------- 统计卡片：总数 / 已有封面 / 未匹配封面 / 待处理 ----------
function stats() {
  const r = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN has_cover>0 THEN 1 ELSE 0 END) covers,
    SUM(CASE WHEN has_cover=0 THEN 1 ELSE 0 END) nocover,
    SUM(CASE WHEN has_cover=0 OR artist='' THEN 1 ELSE 0 END) pending FROM mc_tracks`).get();
  return { total: r.total || 0, covers: r.covers || 0, nocover: r.nocover || 0, pending: r.pending || 0 };
}

// ---------- LRCLIB 歌词：优先精确 get，404 再 search 取第一条带 syncedLyrics 的 ----------
// 免费无 Key、CORS 全开；礼貌限速：串行 + 尊重 429 Retry-After。结果缓存进 mc_tracks。
async function fetchLyrics(track) {
  if (track.lyrics_ok) return { ok: true, synced: !!track.lyrics_synced, text: track.lyrics, cached: true };
  const base = lyricsApiSetting();
  const dur = track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined;
  const tryJson = async (u) => {
    const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'WorkbenchMusic/1.0' } });
    if (res.status === 429) {
      const wait = Math.min(30, parseInt(res.headers.get('retry-after') || '5', 10) || 5);
      return { retryAfter: wait };
    }
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  };
  // URL 里非 ASCII 与空格都百分号编码（& = ? 保留），中文歌手名才不会打坏查询串
  const q = (u) => u.replace(/[^!-~]/g, (c) => encodeURIComponent(c));
  let hit = null;
  // ① /api/get 精确匹配（artist+track+duration 命中即终）
  const getUrl = q(`${base}/api/get?artist_name=${track.artist || ''}&track_name=${track.title}` + (track.album ? `&album_name=${track.album}` : '') + (dur ? `&duration=${dur}` : ''));
  let r = await tryJson(getUrl);
  if (r && r.retryAfter) return { ok: false, error: `LRCLIB 限流，${r.retryAfter} 秒后再试` };
  if (r && (r.syncedLyrics || r.plainLyrics)) hit = r;
  else {
    // ② /api/search 模糊：取第一条有 syncedLyrics 的结果
    const sUrl = q(`${base}/api/search?q=${(track.artist ? track.artist + ' ' : '') + track.title}`);
    const list = await tryJson(sUrl);
    if (list && list.retryAfter) return { ok: false, error: `LRCLIB 限流，${list.retryAfter} 秒后再试` };
    if (Array.isArray(list)) hit = list.find((x) => x && x.syncedLyrics) || list.find((x) => x && x.plainLyrics) || null;
  }
  if (!hit) { db.prepare('UPDATE mc_tracks SET lyrics_ok=0 WHERE id=?').run(track.id); return { ok: false, error: 'LRCLIB 没找到这首歌的歌词' }; }
  const text = hit.syncedLyrics || hit.plainLyrics || '';
  db.prepare('UPDATE mc_tracks SET lyrics=?, lyrics_synced=?, lyrics_ok=1 WHERE id=?').run(text, hit.syncedLyrics ? 1 : 0, track.id);
  return { ok: true, synced: !!hit.syncedLyrics, text, cached: false };
}

module.exports = {
  AUDIO_EXTS, resolveRoot, mcRootSetting, scanLibrary, stats, fetchLyrics,
  COVER_DIR, dirCover, parseId3, parseMp4, parseFlac, mp3Bitrate, metaFromName, metaFromFile,
  DEFAULT_COVER_NAMES, DEFAULT_LYRICS_API,
  coverNamesSetting, coverPrioritySetting, fullBgSetting, lyricsApiSetting, lyricsApiSource,
  lyricsCachedCount, clearLyricsCache, testLyricsApi,
};
