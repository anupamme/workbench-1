<template>
  <transition name="mcfull">
    <div v-if="music.fullOpen" class="mcfull" :style="{ background: bgStyle }">
      <!-- 顶部：歌名 + 关闭 -->
      <div class="top">
        <span class="tt">{{ cur?.title || '未在播放' }}</span>
        <span class="muted ar">{{ cur?.artist || '' }}{{ cur?.album ? ' · ' + cur.album : '' }}</span>
        <span class="grow"></span>
        <button class="fbtn" title="收起全屏（回到悬浮条）" @click="music.fullOpen = false"><span class="material-icons">expand_more</span></button>
      </div>

      <!-- 中部：左唱片 / 右歌词 -->
      <div class="mid">
        <div class="fdisc" :class="{ mspin: music.playing }">
          <img v-if="cur && cur.has_cover" :src="coverUrl(cur.id)" alt="" @error="cur.has_cover = 0" @load="onCoverLoad" />
          <span v-else class="noimg material-icons">music_note</span>
          <i class="hole"></i>
        </div>
        <div class="flyr" ref="flyEl">
          <div v-if="music.lyrics?.loading" class="muted">歌词加载中…</div>
          <div v-else-if="!music.lyrics?.ok" class="muted">{{ music.lyrics?.error || '暂无歌词' }}</div>
          <!-- 三态（v1.16.1）：已唱过 = 最浅、当前行 = 最亮加粗、还没唱 = 中间档 -->
          <div v-else-if="music.lyrics?.synced && lines.length" class="flines">
            <p v-for="(l, i) in lines" :key="i" :class="{ cur: i === curLine, past: i < curLine }">{{ l.line || '♪' }}</p>
          </div>
          <pre v-else class="fplain">{{ music.lyrics?.text || '暂无歌词' }}</pre>
        </div>
      </div>

      <!-- 进度条 -->
      <div class="frow">
        <span class="ftm">{{ fmtTime(music.pos) }}</span>
        <div class="fpbar" ref="fbarEl" @pointerdown="onSeek" @pointermove="onSeekMove" @pointerup="seeking = false">
          <div class="ffill" :style="{ width: pct + '%' }"></div>
        </div>
        <span class="ftm">{{ music.dur ? fmtTime(music.dur) : fmtTime((cur?.duration_ms || 0) / 1000) }}</span>
      </div>

      <!-- 底部按钮行（需求第 7 点）：大播放居中、前/后曲小一号、下一行收藏/列表/倍速/音量/延时/停止 -->
      <div class="crow">
        <button class="cbtn" title="上一曲" @click="prev()"><span class="material-icons">skip_previous</span></button>
        <button class="cbtn play" :title="music.playing ? '暂停' : '播放'" @click="toggle()"><span class="material-icons">{{ music.playing ? 'pause' : 'play_arrow' }}</span></button>
        <button class="cbtn" title="下一曲" @click="next(true)"><span class="material-icons">skip_next</span></button>
      </div>
      <div class="crow sub">
        <button class="cbtn" :class="{ on: cur && isFav(cur.id) }" title="收藏" @click="doFav"><span class="material-icons">{{ cur && isFav(cur.id) ? 'favorite' : 'favorite_border' }}</span></button>
        <button class="cbtn" :class="{ on: listOpen }" title="歌曲列表" @click="listOpen = !listOpen"><span class="material-icons">queue_music</span></button>
        <button class="cbtn txt" title="倍速（0.75 / 1 / 1.25 / 1.5 / 2 循环）" @click="onCycleRate">{{ music.rate }}x</button>
        <span class="fvol">
          <button class="cbtn" :title="music.volume === 0 ? '取消静音' : '静音'" @click="toggleMute"><span class="material-icons">{{ music.volume === 0 ? 'volume_off' : 'volume_up' }}</span></button>
          <input type="range" min="0" max="1" step="0.01" :value="music.volume" @input="setVolume(parseFloat($event.target.value))" />
        </span>
        <button class="cbtn txt" :class="{ on: music.sleepAt > 0 }" :title="sleepTitle" @click="sleepOpen = !sleepOpen"><span class="material-icons">timer</span></button>
        <button class="cbtn" title="停止播放并收起全屏" @click="stopAll"><span class="material-icons">stop</span></button>
      </div>
      <div v-if="music.sleepAt > 0" class="muted sleeptip">延时停止：还剩 {{ fmtSleepLeft() }}</div>

      <!-- 倍速/延时等小提示 -->
      <div v-if="tip" class="ftip">{{ tip }}</div>

      <!-- 歌曲列表浮层 -->
      <div v-if="listOpen" class="flist">
        <div class="ly-head">
          <b>歌曲列表（{{ music.queue.length }}）</b>
          <span class="grow"></span>
          <button class="small" title="关闭列表" @click="listOpen = false"><span class="material-icons ic-sm">close</span></button>
        </div>
        <div class="pl-body">
          <div v-for="(t, i) in music.queue" :key="t.id + '-' + i" class="pl-row" :class="{ cur: i === music.index }" @click="playAt(i); listOpen = false">
            <span class="pl-idx">
              <span v-if="i === music.index" class="material-icons ic-sm">play_arrow</span>
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span class="pl-name" :title="t.title">{{ t.title }}</span>
            <span class="pl-art" :title="t.artist">{{ t.artist || '' }}</span>
            <span class="pl-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
          </div>
          <div v-if="!music.queue.length" class="muted ld">队列为空</div>
        </div>
      </div>

      <!-- 延时停止选项 -->
      <div v-if="sleepOpen" class="fsleep card">
        <b>延时停止</b>
        <div class="sk-row">
          <button v-for="m in [15, 30, 60, 90]" :key="m" class="small" @click="doSleep(m)">{{ m }} 分钟</button>
          <button v-if="music.sleepAt > 0" class="small pri" @click="doSleep(0)">取消</button>
          <button class="small" title="关闭" @click="sleepOpen = false"><span class="material-icons ic-sm">close</span></button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
// 全屏满屏播放（v1.16.0 需求第 7 点）：点悬浮条的唱片图展开。背景 = 封面主色渐变（canvas 取主色，
// 无封面/取色失败回落暗色渐变）；左中唱片（随播放滚）、右侧同步歌词逐行下走；下方大播放键 + 小一号前后曲；
// 再下一行：收藏/歌曲列表/倍速(0.75~2)/音量/延时停止(15/30/60/90 分钟)/停止。ESC 收起。
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';
import {
  musicState as music, playAt, toggle, stop, next, prev, seek, setVolume, cycleRate,
  coverUrl, fmtTime, parseLrc, isFav, toggleFav, setSleepMin, fmtSleepLeft,
  loadMcCfg, fullBgMode,
} from '../musicState';

const fbarEl = ref(null);
const flyEl = ref(null);
const listOpen = ref(false);
const sleepOpen = ref(false);
const tip = ref('');
const seeking = ref(false);
const domColor = ref(''); // 封面主色（css color 字符串）

const cur = computed(() => (music.index >= 0 ? music.queue[music.index] : null));
const pct = computed(() => {
  const d = music.dur || (cur.value ? cur.value.duration_ms / 1000 : 0);
  return d > 0 ? Math.min(100, (music.pos / d) * 100) : 0;
});
const bgStyle = computed(() => {
  // 设置页「音乐海报 → 全屏播放页背景」选了纯深色就一律深色，不取封面主色
  if (fullBgMode() === 'dark') return 'linear-gradient(160deg, #171a22 0%, #10131a 55%, #0b0d12 100%)';
  const c = domColor.value;
  if (!c) return 'linear-gradient(160deg, #171a22 0%, #10131a 55%, #0b0d12 100%)';
  // 主色做暗化渐变背景（文字可读优先，只取 26% / 10% 两档透明度叠加深底）
  return `radial-gradient(120% 90% at 20% 12%, color-mix(in srgb, ${c} 30%, #10131a) 0%, #0d0f15 58%, #090b10 100%)`;
});
const sleepTitle = computed(() => (music.sleepAt > 0 ? '延时停止已设：' + fmtSleepLeft() : '延时停止'));

// 歌词同步（与 MusicBar 同一套解析，这里独立滚动容器）
const lines = computed(() => (music.lyrics?.synced && music.lyrics.text ? parseLrc(music.lyrics.text) : []));
const curLine = computed(() => {
  for (let i = lines.value.length - 1; i >= 0; i--) if (music.pos + 0.2 >= lines.value[i].t) return i;
  return -1;
});
watch(curLine, async () => {
  if (curLine.value < 0) return;
  await nextTick();
  const box = flyEl.value;
  if (!box) return;
  const el = box.querySelector('.flines');
  if (el) box.scrollTop = Math.max(0, curLine.value * 34 - box.clientHeight / 2 + 17);
});

// 封面主色：小画布缩小采样，取饱和度加权的众数色桶（不是死取第一个像素）
function onCoverLoad(e) { extractColor(e.target); }
function extractColor(img) {
  try {
    const cv = document.createElement('canvas');
    cv.width = 24; cv.height = 24;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, 24, 24);
    const px = cx.getImageData(0, 0, 24, 24).data;
    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.18 || max < 40) continue; // 灰黑不配当主色
      const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
      const w = 0.4 + sat; // 饱和度加权
      const cur2 = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0, n: 0 };
      cur2.w += w; cur2.r += r; cur2.g += g; cur2.b += b; cur2.n++;
      buckets.set(key, cur2);
    }
    if (!buckets.size) return;
    let best = null;
    for (const v of buckets.values()) if (!best || v.w > best.w) best = v;
    domColor.value = `rgb(${Math.round(best.r / best.n)}, ${Math.round(best.g / best.n)}, ${Math.round(best.b / best.n)})`;
  } catch { /* 跨域/画布污染时保持默认渐变 */ }
}

function posFromEvent(e) {
  const r = fbarEl.value.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const d = music.dur || (cur.value ? cur.value.duration_ms / 1000 : 0);
  return ratio * d;
}
function onSeek(e) { seeking.value = true; e.target.setPointerCapture?.(e.pointerId); seek(posFromEvent(e)); }
function onSeekMove(e) { if (seeking.value) seek(posFromEvent(e)); }
function flash(t) { tip.value = t; setTimeout(() => { if (tip.value === t) tip.value = ''; }, 1800); }
function toggleMute() { setVolume(music.volume === 0 ? 0.9 : 0); }
async function doFav() { if (cur.value) { const on = await toggleFav(cur.value); flash(on ? '已收藏' : '已取消收藏'); } }
function onCycleRate() { flash('倍速 ' + cycleRate() + 'x'); }
function doSleep(m) { setSleepMin(m); sleepOpen.value = false; flash(m > 0 ? m + ' 分钟后停止播放' : '已取消延时停止'); }
function stopAll() { music.fullOpen = false; music.barOpen = false; stop(); }
function onKey(e) { if (e.key === 'Escape' && music.fullOpen) music.fullOpen = false; }
onMounted(() => { window.addEventListener('keydown', onKey); loadMcCfg(); warmColor(); });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
function warmColor() { // 已有封面但没经过 @load（全屏后切进来）时主动取一次色
  nextTick(() => {
    const img = document.querySelector('.mcfull .fdisc img');
    if (img && img.complete) extractColor(img);
  });
}
watch(() => cur.value?.id, warmColor);
</script>

<style scoped>
/* 1160 = 盖过右下角悬浮面板（1150）但不盖消息弹窗（1200）——满屏播放时右下角按钮不能再浮在上面 */
.mcfull { position: fixed; inset: 0; z-index: 1160; display: flex; flex-direction: column;
  color: #fff; background: #10131a; overflow: hidden; }
.mcfull-enter-active, .mcfull-leave-active { transition: opacity .25s ease, transform .25s ease; }
.mcfull-enter-from, .mcfull-leave-to { opacity: 0; transform: scale(1.04); }
.muted { color: rgba(255,255,255,.55); }
.grow { flex: 1; }
.top { display: flex; align-items: center; gap: 10px; padding: 16px 22px 0; }
.top .tt { font-size: 16px; font-weight: 700; }
.top .ar { font-size: 13px; }
/* 中部 */
.mid { flex: 1; display: flex; align-items: center; gap: 5vw; padding: 0 6vw; min-height: 0; }
.fdisc { position: relative; width: min(340px, 34vw); aspect-ratio: 1; border-radius: 50%; flex-shrink: 0; overflow: hidden;
  background: radial-gradient(circle at center, #2a2d36 30%, #14161c 100%); border: 3px solid rgba(255,255,255,.16);
  box-shadow: 0 18px 60px rgba(0,0,0,.5); }
.fdisc img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fdisc .noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 64px; color: rgba(255,255,255,.4); }
.fdisc .hole { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
  background: #10131a; border: 2px solid rgba(255,255,255,.25); }
/* v1.16.4：类名 spin → mspin（同 MusicBar 的坑：全局 .spin 是 1s/圈的加载动画，
   命中容器 div 就把 70s/圈盖掉了）。只转图片，容器不许有动画。
   v1.16.7：随「唱片旋转速度可以稍微快一点」把 70s/圈 调到 35s/圈（与底部播放条的 30s 同节奏）。 */
.fdisc.mspin img, .fdisc.mspin .noimg { animation: mcspin2 35s linear infinite; }
@keyframes mcspin2 { to { transform: rotate(360deg); } }
.flyr { flex: 1; min-width: 0; height: min(52vh, 480px); overflow-y: auto; scrollbar-width: none; }
.flyr::-webkit-scrollbar { display: none; }
/* 歌词三态（v1.16.1）：还没唱 = 中间档 / .past 已唱过 = 最浅 / .cur 当前行 = 最亮加粗 */
.flines p { margin: 0; padding: 5px 10px; font-size: 16px; line-height: 34px; color: rgba(255,255,255,.46); transition: color .25s, opacity .25s; }
.flines p.past { color: rgba(255,255,255,.22); }
.flines p.cur { color: #fff; font-weight: 700; font-size: 17px; }
.fplain { margin: 0; padding: 6px 10px; white-space: pre-wrap; font-family: inherit; font-size: 14px; color: rgba(255,255,255,.75); }
/* 进度 */
.frow { display: flex; align-items: center; gap: 12px; padding: 0 6vw 6px; }
.ftm { font-size: 12px; color: rgba(255,255,255,.6); font-variant-numeric: tabular-nums; min-width: 36px; }
.fpbar { flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,.18); cursor: pointer; }
.fpbar:hover { height: 8px; }
.ffill { height: 100%; border-radius: 3px; background: #fff; opacity: .9; }
/* 按钮 */
.crow { display: flex; align-items: center; justify-content: center; gap: 26px; padding: 8px 0 4px; }
.crow.sub { gap: 18px; padding: 2px 0 12px; }
.cbtn { width: 44px; height: 44px; border-radius: 50%; border: none; background: rgba(255,255,255,.12); color: #fff;
  font-size: 19px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.cbtn:hover { background: rgba(255,255,255,.22); }
.cbtn.play { width: 72px; height: 72px; font-size: 30px; background: rgba(255,255,255,.92); color: #14161c; box-shadow: 0 10px 30px rgba(0,0,0,.4); }
.crow.sub .cbtn { width: 38px; height: 38px; font-size: 15px; }
.cbtn.txt { font-size: 13px; font-weight: 700; width: auto; min-width: 38px; padding: 0 8px; border-radius: 19px; }
.cbtn.on { background: rgba(255,255,255,.3); }
/* 图标字号（Material Icons 字体）：按钮里的小图标别用默认 24px 撑破圆钮 */
.cbtn .material-icons { font-size: 22px; }
.cbtn.play .material-icons { font-size: 34px; }
.crow.sub .cbtn .material-icons { font-size: 19px; }
.ic-sm { font-size: 15px; vertical-align: -2px; }
.fvol { display: inline-flex; align-items: center; gap: 4px; }
.fvol input[type="range"] { width: 74px; accent-color: #fff; }
.sleeptip { text-align: center; font-size: 12px; padding-bottom: 8px; }
.ftip { position: fixed; left: 50%; bottom: 118px; transform: translateX(-50%); background: rgba(0,0,0,.6);
  padding: 6px 14px; border-radius: 16px; font-size: 13px; pointer-events: none; }
/* 列表/延时浮层 */
.flist { position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); width: min(620px, 92vw); max-height: 46vh;
  background: rgba(12,14,19,.92); border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 10px 12px;
  display: flex; flex-direction: column; backdrop-filter: blur(8px); }
.ly-head { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,.14); margin-bottom: 4px; }
.pl-body { overflow-y: auto; }
.pl-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; font-size: 13.5px; }
.pl-row:hover { background: rgba(255,255,255,.1); }
.pl-row.cur .pl-name { color: #7aa2ff; font-weight: 700; }
.pl-idx { width: 20px; text-align: center; color: rgba(255,255,255,.5); font-size: 12px; flex-shrink: 0; }
.pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-art { width: 130px; color: rgba(255,255,255,.5); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.pl-dur { color: rgba(255,255,255,.5); font-size: 11.5px; flex-shrink: 0; }
.fsleep { position: absolute; right: 6vw; bottom: 96px; background: rgba(12,14,19,.92); border: 1px solid rgba(255,255,255,.14);
  border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; backdrop-filter: blur(8px); }
.sk-row { display: flex; gap: 6px; flex-wrap: wrap; }
/* 窄屏：中部改上下排、藏歌词高度 */
@media (max-width: 760px) {
  .mid { flex-direction: column; gap: 18px; padding: 0 6vw; }
  .fdisc { width: min(240px, 52vw); }
  .flyr { height: 22vh; }
  .pl-art { display: none; }
  .crow { gap: 16px; }
  .crow.sub { gap: 10px; }
}
</style>
