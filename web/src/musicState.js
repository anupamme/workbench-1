// 音乐中心播放器全局状态（v1.16.0）：单例 reactive——MusicPanel / MusicBar / MusicFull
// 与 App.vue 的「音乐」悬浮按钮共享同一份队列与 <audio>，切页面不断播。
// <audio> 惰性创建（首次播歌才 new），src/封面走 rawUrl（?token= 查询参数，Range 206 流播）。
import { reactive, computed } from 'vue';
import { api, rawUrl } from './api';

const LS_VOL = 'mc_volume';
const LS_RATE = 'mc_rate';
const LS_LOOP = 'mc_loop';

export const musicState = reactive({
  queue: [],          // 待播队列（track 对象：id/path/title/artist/album/duration_ms/has_cover/fav）
  index: -1,          // 当前播放下标；-1 = 空
  playing: false,
  pos: 0,             // 已播秒数（timeupdate 更新）
  dur: 0,             // 总秒数（loadedmetadata；0 = 未知）
  volume: (() => { const v = parseFloat(localStorage.getItem(LS_VOL)); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.9; })(),
  rate: (() => { const r = parseFloat(localStorage.getItem(LS_RATE)); return [0.75, 1, 1.25, 1.5, 2].includes(r) ? r : 1; })(),
  loop: ['off', 'one', 'all'].includes(localStorage.getItem(LS_LOOP)) ? localStorage.getItem(LS_LOOP) : 'off',
  barOpen: false,     // 底部悬浮播放条
  fullOpen: false,    // 全屏播放
  lyricsOpen: false,  // 播放条上的歌词弹框
  lyrics: null,       // { ok, synced, text, error, loading } 当前曲歌词
  favIds: [],         // 已收藏的曲目 id（面板加载时全量拉一次 + toggle 即时改）
  sleepAt: 0,         // 延时停止的时间戳（ms）；0 = 未设
  sleepTip: '',       // 剩余提示
  cfg: null,          // 最近一次 GET /mc/config（海报封面优先级、全屏背景、歌词 API 来源…）
});

// ---------- <audio> 惰性单例 ----------
let audioEl = null;
function el() {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.volume = musicState.volume;
  audioEl.playbackRate = musicState.rate;
  audioEl.addEventListener('timeupdate', () => { musicState.pos = audioEl.currentTime; checkSleep(); });
  audioEl.addEventListener('loadedmetadata', () => { musicState.dur = Number.isFinite(audioEl.duration) ? audioEl.duration : 0; });
  audioEl.addEventListener('play', () => { musicState.playing = true; });
  audioEl.addEventListener('pause', () => { musicState.playing = false; });
  audioEl.addEventListener('ended', () => onEnded());
  audioEl.addEventListener('error', () => { musicState.playing = false; });
  return audioEl;
}

export const current = computed(() => (musicState.index >= 0 ? musicState.queue[musicState.index] : null));
export const fileUrl = (id) => rawUrl(`/api/mc/file?id=${id}`);
export const coverUrl = (id) => rawUrl(`/api/mc/cover/${id}`);

// ---------- 播控 ----------
export function playList(tracks, i = 0) {
  musicState.queue = tracks.slice();
  playAt(Math.max(0, Math.min(i, tracks.length - 1)));
}
export function playAt(i) {
  if (i < 0 || i >= musicState.queue.length) return;
  musicState.index = i;
  musicState.pos = 0;
  musicState.dur = (musicState.queue[i].duration_ms / 1000) || 0;
  musicState.lyrics = null; // 换曲歌词框留着（lyricsOpen 不动），新词随 loadLyrics 回来
  const a = el();
  a.src = fileUrl(musicState.queue[i].id);
  a.playbackRate = musicState.rate;
  a.play().catch(() => { musicState.playing = false; });
  loadLyrics(musicState.queue[i]);
}
export function toggle() {
  const a = el();
  if (!current.value) { if (musicState.queue.length) playAt(0); return; }
  if (a.paused) a.play().catch(() => {}); else a.pause();
}
export function stop() { // 全屏「停止」键：暂停 + 回零（队列保留，悬浮条再按播放能接着来）
  const a = el();
  a.pause();
  if (a.currentTime) a.currentTime = 0;
  musicState.pos = 0;
}
export function next(userAction = true) {
  if (!musicState.queue.length) return;
  const last = musicState.index >= musicState.queue.length - 1;
  if (!last) { playAt(musicState.index + 1); return; }
  // 末曲：循环全部 or 手动点「下一曲」→ 回开头；顺序模式自动播完 → 停
  if (musicState.loop === 'all' || userAction) playAt(0);
}
export function prev() {
  if (!musicState.queue.length) return;
  if (musicState.pos > 3) { seek(0); return; } // 播过 3 秒先回本曲开头
  if (musicState.index <= 0) { playAt(0); return; }
  playAt(musicState.index - 1);
}
export function seek(sec) {
  const a = el();
  if (current.value) a.currentTime = Math.max(0, Math.min(sec, a.duration || sec));
  musicState.pos = a.currentTime;
}
export function setVolume(v) {
  musicState.volume = Math.min(1, Math.max(0, v));
  el().volume = musicState.volume;
  localStorage.setItem(LS_VOL, String(musicState.volume));
}
export function cycleRate() {
  const RATES = [0.75, 1, 1.25, 1.5, 2];
  musicState.rate = RATES[(RATES.indexOf(musicState.rate) + 1) % RATES.length];
  el().playbackRate = musicState.rate;
  localStorage.setItem(LS_RATE, String(musicState.rate));
  return musicState.rate;
}
export function cycleLoop() {
  const modes = ['off', 'one', 'all'];
  musicState.loop = modes[(modes.indexOf(musicState.loop) + 1) % modes.length];
  localStorage.setItem(LS_LOOP, musicState.loop);
  return musicState.loop;
}
function onEnded() {
  if (musicState.loop === 'one') { playAt(musicState.index); return; }
  next(false);
}
// 加号加入待播：去重（已在队列里就挪到当前曲后面紧挨着）
export function enqueue(track) {
  const i = musicState.queue.findIndex((t) => t.id === track.id);
  if (i >= 0) {
    if (i === musicState.index) return false;
    musicState.queue.splice(i, 1);
    const at = musicState.index >= 0 ? musicState.index + 1 : 0;
    musicState.queue.splice(at, 0, track);
    if (i < musicState.index) musicState.index--; // 挪动的在当前曲前面时下标回退
    return true;
  }
  const at = musicState.index >= 0 ? musicState.index + 1 : musicState.queue.length;
  musicState.queue.splice(at, 0, track);
  return true;
}
export function removeFromQueue(i) {
  if (i === musicState.index) return; // 当前播放的曲不让从队列移除（先切歌）
  musicState.queue.splice(i, 1);
  if (i < musicState.index) musicState.index--;
}

// ---------- 歌词 ----------
export async function loadLyrics(track) {
  if (!track) return;
  musicState.lyrics = { ok: false, synced: false, text: '', error: '', loading: true };
  try {
    const r = await api.get(`/mc/lyrics/${track.id}`);
    musicState.lyrics = { ...r, loading: false };
  } catch (e) {
    musicState.lyrics = { ok: false, synced: false, text: '', error: e.message, loading: false };
  }
}
// [mm:ss.xx]行 → [{t: 秒, line}]（多时间标签行拆开；乱序容忍）
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const times = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!times.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of times) {
      const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? parseFloat('0.' + m[3]) : 0);
      out.push({ t, line });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- 收藏 ----------
export async function loadFavs() {
  try {
    const r = await api.get('/mc/favorites');
    musicState.favIds = (r.tracks || []).map((t) => t.id);
  } catch { /* 无权限/未配置时静默 */ }
}
export async function toggleFav(track) {
  const has = musicState.favIds.includes(track.id);
  try {
    const r = await api.post('/mc/favorite', { id: track.id, on: !has });
    if (r.fav) musicState.favIds.push(track.id);
    else musicState.favIds = musicState.favIds.filter((x) => x !== track.id);
    track.fav = !!r.fav;
    return !!r.fav;
  } catch { return has; }
}
export const isFav = (id) => musicState.favIds.includes(id);

// ---------- 延时停止 ----------
let sleepTimer = null;
export function setSleepMin(min) {
  musicState.sleepAt = min > 0 ? Date.now() + min * 60000 : 0;
  musicState.sleepTip = min > 0 ? `${min} 分钟后停止` : '';
}
function checkSleep() {
  if (!musicState.sleepAt) return;
  if (Date.now() >= musicState.sleepAt) {
    musicState.sleepAt = 0;
    musicState.sleepTip = '';
    el().pause();
  }
}
export function fmtSleepLeft() {
  if (!musicState.sleepAt) return '';
  const s = Math.max(0, Math.round((musicState.sleepAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- 配置（v1.16.1）----------
// 设置页改的「音乐海报 / 歌词 API」由全屏播放页与播放条读同一份缓存；任何一个入口打开时拉一次即可。
export async function loadMcCfg() {
  try { musicState.cfg = await api.get('/mc/config'); } catch { /* 未配置/无权限时保持旧值 */ }
  return musicState.cfg;
}
// 全屏播放页背景：'color' = 封面主色渐变（默认）· 'dark' = 纯深色（没封面或主色太乱时更干净）
export const fullBgMode = () => (musicState.cfg?.poster?.full_bg === 'dark' ? 'dark' : 'color');

// ---------- 工具 ----------
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
