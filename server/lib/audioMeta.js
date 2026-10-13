// 服务端音频元信息：从文件字节流读播放时长（无需 ffmpeg）。
// WAV：RIFF 头逐 chunk 找 fmt/data，data 字节 ÷ byteRate。
// MP3：逐帧遍历（ID3v2 跳过 + MPEG 帧头解析），Σ(每帧样本数/采样率)，CBR/VBR 都准。
// M4A/MP4（v1.16.0）：box 树找 moov/mvhd，duration÷timescale——moov 在头或在尾都支持（两段缓冲拼接探测）。
// FLAC（v1.16.0）：STREAMINFO 块的 36 位总样本数÷采样率。

// ---- WAV ----
function wavDuration(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) byteRate = buf.readUInt32LE(off + 16) || 0;
    if (id === 'data') return byteRate > 0 ? size / byteRate : 0;
    off += 8 + size + (size % 2); // chunk 按 2 字节对齐
    if (size <= 0) break;
  }
  return 0;
}

// ---- MP3 ----
const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1 Layer3 kbps
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];     // MPEG2/2.5 Layer3
const SR = [ // [MPEG1, MPEG2, MPEG2.5]
  [44100, 22050, 11025], [48000, 24000, 12000], [32000, 16000, 8000], [0, 0, 0],
];
function mp3Duration(buf) {
  let pos = 0;
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + sz;
  }
  let sec = 0;
  let frames = 0;
  while (pos + 4 <= buf.length && frames < 3_000_000) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) { pos++; continue; } // 找帧同步字
    const hdr = buf.readUInt32BE(pos);
    const verBits = (hdr >> 19) & 3;   // 0=MPEG2.5 2=MPEG2 3=MPEG1
    const layerBits = (hdr >> 17) & 3; // 1=Layer3
    if (verBits === 1 || layerBits !== 1) { pos++; continue; }
    const vi = verBits === 3 ? 0 : (verBits === 2 ? 1 : 2);
    const br = (verBits === 3 ? BR_V1_L3 : BR_V2_L3)[(hdr >> 12) & 15] * 1000;
    const sr = SR[(hdr >> 10) & 3][vi];
    if (!br || !sr) { pos++; continue; }
    const pad = (hdr >> 9) & 1;
    const samples = verBits === 3 ? 1152 : 576; // MPEG1 L3=1152, MPEG2/2.5 L3=576
    const frameBytes = Math.floor(samples / 8 * br / sr) + pad;
    if (frameBytes < 4) { pos++; continue; }
    sec += samples / sr;
    frames++;
    pos += frameBytes;
  }
  return sec;
}

// ---- M4A/MP4：moov→mvhd 的 duration÷timescale（头尾两段都扫，moov 在文件尾的流式封装也能解） ----
function mvhdDurationIn(buf) {
  let off = 0;
  // 遍历顶层 box 找 moov；box 头 = 4 字节大端 size + 4 字节 type（size=1 时真实 size 在 8 字节 largesize 里）
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size === 1) { if (off + 16 > buf.length) break; size = Number(buf.readBigUInt64BE(off + 8)); }
    if (size < 8) break;
    if (type === 'moov') {
      // moov 内逐 box 找 mvhd（version 0：timescale@12, duration@16 各 4 字节；version 1：8 字节时间戳，timescale@20, duration@24 为 8 字节）
      let p = off + 8;
      while (p + 8 <= Math.min(off + size, buf.length)) {
        const s2 = buf.readUInt32BE(p);
        const t2 = buf.toString('ascii', p + 4, p + 8);
        if (s2 < 8) break;
        if (t2 === 'mvhd' && p + 8 + 4 + 20 <= buf.length) {
          const ver = buf[p + 8];
          if (ver === 1 && p + 8 + 28 <= buf.length) {
            const ts = buf.readUInt32BE(p + 8 + 20);
            const dur = Number(buf.readBigUInt64BE(p + 8 + 24));
            if (ts > 0 && dur > 0) return dur / ts;
          } else {
            const ts = buf.readUInt32BE(p + 8 + 12);
            const dur = buf.readUInt32BE(p + 8 + 16);
            if (ts > 0 && dur > 0) return dur / ts;
          }
        }
        p += s2;
      }
      break;
    }
    off += size;
  }
  return 0;
}
function m4aDuration(headBuf, tailBuf) {
  return mvhdDurationIn(headBuf) || (tailBuf ? mvhdDurationIn(tailBuf) : 0);
}

// ---- FLAC：fLaC 魔数后第一个块（type 0 STREAMINFO）里 sample_rate(20bit)/total_samples(36bit) ----
function flacDuration(buf) {
  if (buf.length < 42 || buf.toString('ascii', 0, 4) !== 'fLaC') return 0;
  let off = 4;
  // STREAMINFO 固定 34 字节；块头 1 字节（1 位 last-flag + 7 位 type）+ 3 字节长度
  while (off + 4 <= buf.length) {
    const head = buf[off];
    const type = head & 0x7f;
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    if (type === 0 && off + 4 + 18 <= buf.length) {
      const b = buf;
      const p = off + 4;
      // 64 位打包场（body[10..17]，MSB 在前）：采样率 20 位 | 声道-1 3 位 | 位深-1 5 位 | 总样本数 36 位。
      // 采样率 = body[10..11] + body[12] 高 4 位；总样本数 = body[13] 低 4 位 <<32 | body[14..17]（32 位）
      const sr = (b[p + 10] << 12) | (b[p + 11] << 4) | (b[p + 12] >> 4);
      const total = ((b[p + 13] & 0x0f) * 4294967296) + ((b[p + 14] << 24 >>> 0) + (b[p + 15] << 16) + (b[p + 16] << 8) + b[p + 17]);
      if (sr > 0 && total > 0) return total / sr;
      return 0;
    }
    if (head & 0x80) break; // last-metadata-block
    off += 4 + len;
  }
  return 0;
}

// 按扩展名分派；未知格式返回 0（调用方回落到客户端上报时长）
// m4a 传 (headBuf, tailBuf) 两段（moov 可能在文件尾）；wav/mp3/flac 只用 headBuf
function audioDuration(buf, ext, tailBuf) {
  const e = String(ext || '').toLowerCase().replace('.', '');
  if (e === 'wav') return wavDuration(buf);
  if (e === 'mp3') return mp3Duration(buf);
  if (e === 'm4a' || e === 'mp4') return m4aDuration(buf, tailBuf);
  if (e === 'flac') return flacDuration(buf);
  return 0;
}

const AUDIO_MIME = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', aac: 'audio/aac',
};

module.exports = { audioDuration, wavDuration, mp3Duration, m4aDuration, flacDuration, AUDIO_MIME };
