<template>
  <div class="mcard">
    <!-- 播放列表来源（v1.18.6 需求：默认收藏夹，可切全部曲库） -->
    <div class="mhead">
      <button class="pill" :class="{ on: srcKind === 'fav' }" title="用「我的收藏」当播放列表" @click="switchSrc('fav')">
        <span class="material-icons ic-sm">favorite</span> 收藏夹{{ favTracks.length ? '（' + favTracks.length + '）' : '' }}
      </button>
      <button class="pill" :class="{ on: srcKind === 'all' }" title="用整个曲库当播放列表" @click="switchSrc('all')">
        <span class="material-icons ic-sm">library_music</span> {{ srcLoading ? '载入中…' : '全部曲库' }}
      </button>
      <span class="grow"></span>
      <button class="icbtn" :title="cur ? '全屏播放：' + cur.title : '全屏播放'" @click="music.fullOpen = true">
        <span class="material-icons">open_in_full</span>
      </button>
    </div>

    <div class="mrow">
      <!-- 左：圆形唱片，播放时随歌旋转；转速与底部悬浮播放条完全一致（30s/圈） -->
      <div class="disc" :class="{ mspin: music.playing }" :title="cur ? '点击进入全屏：' + cur.title : '唱片'" @click="music.fullOpen = true">
        <img v-if="cur && cur.has_cover" :src="coverUrl(cur.id)" alt="" @error="cur.has_cover = 0" />
        <span v-else class="noimg material-icons">music_note</span>
        <i class="hole"></i>
      </div>

      <!-- 右：歌名 → 进度（已播 / 剩余） → 按钮组 → 两行歌词 -->
      <div class="rside">
        <div class="line">
          <span class="t" :title="cur?.title">{{ cur?.title || '未在播放' }}</span>
          <span class="a" :title="subLine">{{ subLine }}</span>
        </div>

        <div class="prow">
          <span class="tm">{{ fmtTime(music.pos) }}</span>
          <div class="pbar" ref="barEl" draggable="false" @dragstart.prevent
               @pointerdown="onSeek" @pointermove="onSeekMove" @pointerup="seeking = false" @pointercancel="seeking = false">
            <div class="fill" :style="{ width: pct + '%' }"></div>
          </div>
          <span class="tm">-{{ fmtTime(remain) }}</span>
        </div>

        <div class="ctrl">
          <button class="cbtn" title="上一曲" @click="onPrev"><span class="material-icons">skip_previous</span></button>
          <button class="cbtn big" :title="music.playing ? '暂停' : '播放'" @click="onPlay"><span class="material-icons">{{ music.playing ? 'pause' : 'play_arrow' }}</span></button>
          <button class="cbtn" title="下一曲" @click="onNext"><span class="material-icons">skip_next</span></button>
          <button class="cbtn" :title="music.volume === 0 ? '取消静音' : '静音'" @click="toggleMute">
            <span class="material-icons">{{ music.volume === 0 ? 'volume_off' : 'volume_up' }}</span>
          </button>
          <input type="range" min="0" max="1" step="0.01" :value="music.volume" title="音量" draggable="false" @dragstart.prevent
                 @input="setVolume(parseFloat($event.target.value))" />
        </div>

        <!-- 两行歌词（v1.18.6 需求：上一行 + 当前行） -->
        <div class="lyr">
          <template v-if="lyMode === 'synced'">
            <div class="ll top">{{ lyTop || ' ' }}</div>
            <div class="ll bot" :class="curLine >= 0 ? 'cur' : 'pre'">{{ lyBot || ' ' }}</div>
          </template>
          <template v-else-if="lyMode === 'plain'">
            <div class="ll top">{{ lyPlain[0] || ' ' }}</div>
            <div class="ll bot pre">{{ lyPlain[1] || ' ' }}</div>
          </template>
          <div v-else-if="lyMode === 'loading'" class="ll dim">歌词加载中…</div>
          <div v-else-if="lyMode === 'none'" class="ll dim">{{ music.lyrics?.error || '暂无歌词' }}</div>
          <div v-else class="ll dim">{{ emptyHint }}</div>
        </div>

        <div v-if="hint" class="hint">{{ hint }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 首页看板「音乐播放器」卡片（v1.18.6）。
// 需求原话：「左侧显示旋转的唱片的封面图，旋转效果与下方悬浮栏位的唱片旋转转速一样。右边显示播放进度条带有
// 播放时长、未播放时长。右侧下方是一组按钮：播放暂停键、前一曲后一曲、音量大小。音乐播放列表默认使用收藏夹内
// 的歌曲。按钮下方显示2行歌词随着音乐播放显示。」
//
// 与音乐页/底部悬浮条共用同一个播放器：musicState 是模块级单例、<audio> 永不卸载，这里直接 import 就读到同一份
// queue/index/playing/pos/dur/volume/lyrics——卡片上的操作与悬浮条双向同步，不需要任何额外同步代码。
//
// 图标一律用 Material Icons 单色字体（web/public/material-icons/，随 color 渲染），**不许用彩色 emoji**
// ——沿用 v1.16.1 起的项目口径。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import {
  musicState as music, coverUrl, fmtTime, toggle, next, prev, seek, setVolume, parseLrc, loadFavs, playList,
} from '../musicState';

const LS_SRC = 'mc_cardsrc'; // 来源选择记住（默认收藏夹）

const srcKind = ref(localStorage.getItem(LS_SRC) === 'all' ? 'all' : 'fav');
const allTracks = ref([]);
const srcLoading = ref(false);
const hint = ref('');
const barEl = ref(null);
const seeking = ref(false);

const favTracks = computed(() => music.favTracks);
const cur = computed(() => (music.index >= 0 ? music.queue[music.index] : null));
const subLine = computed(() => {
  if (!cur.value) return '';
  return (cur.value.artist || '') + (cur.value.album ? (cur.value.artist ? ' · ' : '') + cur.value.album : '');
});
const durSec = computed(() => music.dur || (cur.value ? (cur.value.duration_ms || 0) / 1000 : 0));
const pct = computed(() => (durSec.value > 0 ? Math.min(100, (music.pos / durSec.value) * 100) : 0));
// 未播放时长（需求要的是「剩余」而不是总长）：总长 − 已播，播放中随 timeupdate 递减
const remain = computed(() => Math.max(0, durSec.value - music.pos));

// ---------- 歌词：上一行 + 当前行 ----------
// curLine 算法与底部悬浮条（MusicBar.vue）逐字相同，保证两处高亮永远同一行。
const lines = computed(() => (music.lyrics?.synced && music.lyrics.text ? parseLrc(music.lyrics.text) : []));
const curLine = computed(() => {
  for (let i = lines.value.length - 1; i >= 0; i--) if (music.pos + 0.2 >= lines.value[i].t) return i;
  return -1;
});
const lyTop = computed(() => (curLine.value - 1 >= 0 ? lines.value[curLine.value - 1].line : ''));
// 还没唱到第一行（curLine = -1）时，下面那行先预告第一句，别让卡片空着
const lyBot = computed(() => (curLine.value >= 0 ? lines.value[curLine.value]?.line || '' : lines.value[0]?.line || ''));
// 非同步歌词（纯文本）：剥掉时间标签取前两个非空行
const lyPlain = computed(() => String(music.lyrics?.text || '')
  .split('\n').map((s) => s.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean).slice(0, 2));
const lyMode = computed(() => {
  if (!cur.value) return 'idle';
  if (music.lyrics?.loading) return 'loading';
  if (!music.lyrics?.ok) return 'none';
  if (music.lyrics.synced && lines.value.length) return 'synced';
  return 'plain';
});

// ---------- 播放列表来源 ----------
async function srcTracks() {
  if (srcKind.value === 'fav') { await loadFavs(); return music.favTracks; }
  if (!allTracks.value.length) await fetchAll();
  return allTracks.value;
}
async function fetchAll() {
  if (srcLoading.value) return;
  srcLoading.value = true;
  hint.value = '';
  try {
    const r = await api.get('/mc/library?all=1');
    allTracks.value = Array.isArray(r.tracks) ? r.tracks : [];
  } catch (e) {
    hint.value = '曲库加载失败：' + e.message; // 未配置音乐目录时后端会回这句原话
  } finally { srcLoading.value = false; }
}
// 切换来源 = 换成这个列表在放（用户主动点的切换，打断当前曲是预期行为）
async function switchSrc(k) {
  if (k === srcKind.value) return;
  srcKind.value = k;
  localStorage.setItem(LS_SRC, k);
  await playSrc(0);
}
async function playSrc(i) {
  hint.value = '';
  const list = await srcTracks();
  if (!list.length) { hint.value = emptyHint.value; return; }
  playList(list, i);
}
const emptyHint = computed(() => (srcKind.value === 'fav'
  ? (favTracks.value.length
    ? `点播放，从收藏夹第 1 首开始（共 ${favTracks.value.length} 首）`
    : '收藏夹还是空的——播放时点心形图标收藏，或切到「全部曲库」')
  : (allTracks.value.length ? '点播放，从全部曲库第 1 首开始' : '点「全部曲库」载入曲库')));

// ---------- 播控（队列空时先用选中来源起播，别按了没反应） ----------
async function onPlay() { if (music.queue.length) { toggle(); return; } await playSrc(0); }
async function onNext() { if (!music.queue.length) { await playSrc(0); return; } next(true); }
async function onPrev() { if (!music.queue.length) { await playSrc(0); return; } prev(); }
function toggleMute() { setVolume(music.volume === 0 ? 0.9 : 0); }

// ---------- 进度条拖拽（pointer 三事件一套，与悬浮条同款） ----------
function posFromEvent(e) {
  const r = barEl.value.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  return ratio * durSec.value;
}
function onSeek(e) { seeking.value = true; e.target.setPointerCapture?.(e.pointerId); seek(posFromEvent(e)); }
function onSeekMove(e) { if (seeking.value) seek(posFromEvent(e)); }

// 挂载即拉收藏（默认来源），并尊重记住的全部曲库选择
onMounted(() => { loadFavs(); if (srcKind.value === 'all') fetchAll(); });
</script>

<style scoped>
/* 卡片本体是瀑布流里的普通块：外层 .dash-card 负责拖拽/边距，这里只管内容排布 */
.mcard { display: flex; flex-direction: column; gap: 10px; }

/* 来源切换药丸 */
.mhead { display: flex; align-items: center; gap: 6px; }
.grow { flex: 1; }
.pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 12px;
  background: transparent; color: var(--muted); border: 1px solid var(--border); cursor: pointer; }
.pill:hover { color: var(--text); border-color: var(--muted); }
.pill.on { color: #4f7cf7; border-color: #4f7cf7; background: rgba(79, 124, 247, .1); }
.icbtn { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 3px; border-radius: 6px;
  display: inline-flex; align-items: center; }
.icbtn:hover { color: var(--text); background: var(--bg3, #2a2d36); }
.ic-sm { font-size: 14px; }

.mrow { display: flex; align-items: flex-start; gap: 14px; }

/* 唱片：v1.16.4 的教训——类名必须叫 mspin，**绝不能用 .spin**
   （style.css 里的全局工具类 `.spin { animation: spin 1s linear infinite }` 会同时命中容器，
   于是 30s/圈 被 1s/圈 盖住，用户看到的就是「一点没慢」）。
   动画只加在 img / .noimg 上，容器 div 不许有任何 animation。 */
.disc { position: relative; width: 72px; height: 72px; border-radius: 50%; flex-shrink: 0; cursor: pointer; overflow: hidden;
  background: radial-gradient(circle at center, #2a2d36 30%, #14161c 100%); border: 2px solid rgba(255,255,255,.14); }
.disc img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
.disc .noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 30px; }
.disc .hole { position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%;
  background: var(--bg2, #1c1f27); border: 1px solid rgba(255,255,255,.2); }
/* 转速与底部悬浮播放条完全一致：30s/圈（改这里必须同步改 MusicBar.vue 的 .disc.mspin） */
.disc.mspin img, .disc.mspin .noimg { animation: mcspin 30s linear infinite; }
@keyframes mcspin { to { transform: rotate(360deg); } }

.rside { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.line .t { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line .a { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 进度条：左 = 播放时长，右 = 未播放时长（"-" 前缀） */
.prow { display: flex; align-items: center; gap: 8px; }
.prow .tm { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 34px; }
.prow .tm:last-child { text-align: right; }
.pbar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg3, #2a2d36); cursor: pointer; position: relative; }
.pbar:hover { height: 8px; }
.pbar .fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #4f7cf7, #7aa2ff); pointer-events: none; }

/* 按钮组：播放暂停 / 前后曲 / 音量 */
.ctrl { display: flex; align-items: center; gap: 4px; }
.cbtn { width: 30px; height: 30px; border-radius: 50%; border: none; background: transparent; color: var(--text);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.cbtn:hover { background: var(--bg3, #2a2d36); }
.cbtn.big { width: 36px; height: 36px; background: var(--bg3, #2a2d36); border: 1px solid var(--border); }
.cbtn .material-icons { font-size: 18px; }
.cbtn.big .material-icons { font-size: 21px; }
/* 音量条给个上限：卡片比悬浮条宽得多，让它铺满整行会喧宾夺主 */
.ctrl input[type="range"] { flex: 0 1 130px; min-width: 56px; height: 4px; accent-color: #4f7cf7; cursor: pointer; }

/* 两行歌词：上一行（浅）+ 当前行（亮/加粗） */
.lyr { min-height: 40px; display: flex; flex-direction: column; justify-content: center; }
.ll { font-size: 13px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: opacity .25s ease, color .25s ease; }
.ll.top { opacity: .32; }
.ll.bot.cur { opacity: 1; font-weight: 700; color: #7aa2ff; }
.ll.bot.pre { opacity: .58; }
.ll.dim { opacity: .5; font-size: 12.5px; white-space: normal; }
.hint { font-size: 12px; color: var(--red, #e04b4b); }

@media (max-width: 720px) {
  .disc { width: 56px; height: 56px; }
  .disc .noimg { font-size: 24px; }
  .line .a { display: none; }
  .pill { padding: 3px 8px; }
}
</style>
