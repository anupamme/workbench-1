<template>
  <transition name="mcbar">
    <div v-if="music.barOpen" class="mcbar">
      <!-- 唱片：圆形，随播放滚动；点它进全屏（需求第 7 点） -->
      <div class="disc" :class="{ mspin: music.playing }" :title="'点击展开全屏播放：' + (cur?.title || '')" @click="music.fullOpen = true">
        <img v-if="cur && cur.has_cover" :src="coverUrl(cur.id)" alt="" @error="cur.has_cover = 0" />
        <span v-else class="noimg material-icons">music_note</span>
        <i class="hole"></i>
      </div>

      <!-- 歌名/歌手 + 进度条 -->
      <div class="mid">
        <div class="line">
          <span class="t" :title="cur?.title">{{ cur?.title || '未在播放' }}</span>
          <span class="a" :title="(cur?.artist || '') + (cur?.album ? ' · ' + cur.album : '')">{{ cur?.artist || '' }}{{ cur?.album ? ' · ' + cur.album : '' }}</span>
        </div>
        <div class="prow">
          <span class="tm">{{ fmtTime(music.pos) }}</span>
          <div class="pbar" ref="barEl" @pointerdown="onSeek" @pointermove="onSeekMove" @pointerup="seeking = false">
            <div class="fill" :style="{ width: pct + '%' }"></div>
          </div>
          <span class="tm">{{ music.dur ? fmtTime(music.dur) : fmtTime((cur?.duration_ms || 0) / 1000) }}</span>
        </div>
      </div>

      <!-- 控制：上一曲/播放暂停/下一曲 -->
      <div class="ctrl">
        <button class="cbtn" title="上一曲" @click="prev()"><span class="material-icons">skip_previous</span></button>
        <button class="cbtn big" :title="music.playing ? '暂停' : '播放'" @click="toggle()"><span class="material-icons">{{ music.playing ? 'pause' : 'play_arrow' }}</span></button>
        <button class="cbtn" title="下一曲" @click="next(true)"><span class="material-icons">skip_next</span></button>
      </div>

      <!-- 右侧功能键 -->
      <div class="fx">
        <button class="cbtn" :class="{ on: music.loop !== 'off' }" :title="loopTitle" @click="cycleLoop()"><span class="material-icons">{{ loopIcon }}</span></button>
        <button class="cbtn" :class="{ on: cur && isFav(cur.id) }" title="收藏（点此进我的收藏）" @click="onFav"><span class="material-icons">{{ cur && isFav(cur.id) ? 'favorite' : 'favorite_border' }}</span></button>
        <span class="vol">
          <button class="cbtn" :title="music.volume === 0 ? '取消静音' : '静音'" @click="toggleMute"><span class="material-icons">{{ music.volume === 0 ? 'volume_off' : 'volume_up' }}</span></button>
          <input type="range" min="0" max="1" step="0.01" :value="music.volume" title="音量" @input="setVolume(parseFloat($event.target.value))" />
        </span>
        <button class="cbtn" :class="{ on: listOpen }" title="播放列表 / 我的收藏" @click="listOpen = !listOpen"><span class="material-icons">queue_music</span></button>
        <button class="cbtn" :class="{ on: music.lyricsOpen }" title="歌词" @click="music.lyricsOpen = !music.lyricsOpen"><span class="material-icons">lyrics</span></button>
        <button class="cbtn" title="收起播放条（右下角「音乐」按钮再打开）" @click="music.barOpen = false"><span class="material-icons">close</span></button>
      </div>

      <!-- 歌词弹框（需求：点开单独弹出、随播放内容行向下走） -->
      <div v-if="music.lyricsOpen" class="lyrics card">
        <div class="ly-head">
          <b>歌词</b>
          <span class="muted" style="font-size:12px">{{ cur?.title }}{{ cur?.artist ? ' - ' + cur.artist : '' }}</span>
          <span class="grow"></span>
          <button class="small" @click="music.lyricsOpen = false"><span class="material-icons ic-sm">close</span> 关闭</button>
        </div>
        <div class="ly-body" ref="lyEl">
          <div v-if="music.lyrics?.loading" class="muted ld">歌词加载中…</div>
          <div v-else-if="!music.lyrics?.ok" class="muted ld">{{ music.lyrics?.error || '暂无歌词' }}</div>
          <!-- 三态（v1.16.1）：已唱过 = 最浅、当前行 = 最亮加粗、还没唱 = 中间档 -->
          <div v-else-if="music.lyrics?.synced && lines.length" class="ly-lines">
            <p v-for="(l, i) in lines" :key="i" :class="{ cur: i === curLine, past: i < curLine }">{{ l.line || '♪' }}</p>
          </div>
          <pre v-else class="ly-plain">{{ music.lyrics?.text || '暂无歌词' }}</pre>
        </div>
      </div>

      <!-- 播放列表弹框：两个视图（播放列表 / 我的收藏）——两边的行内都能收藏/移除 -->
      <div v-if="listOpen" class="plist card">
        <div class="ly-head">
          <button class="small" :class="{ pri: listView === 'queue' }" @click="listView = 'queue'">播放列表（{{ music.queue.length }}）</button>
          <button class="small" :class="{ pri: listView === 'fav' }" @click="openFavs">我的收藏（{{ favTracks.length }}）</button>
          <span class="grow"></span>
          <button class="small" @click="listOpen = false"><span class="material-icons ic-sm">close</span></button>
        </div>
        <div class="pl-body">
          <template v-if="listView === 'queue'">
            <div v-for="(t, i) in music.queue" :key="t.id + '-' + i" class="pl-row" :class="{ cur: i === music.index }" @click="playAt(i)">
              <span class="pl-idx">
                <span v-if="i === music.index" class="material-icons ic-sm">play_arrow</span>
                <template v-else>{{ i + 1 }}</template>
              </span>
              <span class="pl-name" :title="t.title">{{ t.title }}</span>
              <span class="pl-art" :title="t.artist">{{ t.artist || '' }}</span>
              <span class="pl-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
              <button class="pl-act small" :class="{ on: isFav(t.id) }" :title="isFav(t.id) ? '取消收藏' : '加入我的收藏'" @click.stop="favRow(t)">
                <span class="material-icons ic-sm">{{ isFav(t.id) ? 'favorite' : 'favorite_border' }}</span>
              </button>
              <button v-if="i !== music.index" class="pl-act small" title="从队列移除" @click.stop="removeFromQueue(i)"><span class="material-icons ic-sm">close</span></button>
            </div>
            <div v-if="!music.queue.length" class="muted ld">队列为空——去音乐页点歌曲，或点卡片上的「加入待播」</div>
          </template>
          <template v-else>
            <div v-for="(t, i) in favTracks" :key="t.id" class="pl-row" :class="{ cur: cur && cur.id === t.id }" @click="playFav(i)">
              <span class="pl-idx"><span class="material-icons ic-sm ic-heart">favorite</span></span>
              <span class="pl-name" :title="t.title">{{ t.title }}</span>
              <span class="pl-art" :title="t.artist">{{ t.artist || '' }}</span>
              <span class="pl-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
              <button class="pl-act small" title="加入待播（排到当前曲之后）" @click.stop="enqueueFav(t)"><span class="material-icons ic-sm">playlist_add</span></button>
              <button class="pl-act small danger" title="从我的收藏移除" @click.stop="removeFav(t)"><span class="material-icons ic-sm">delete</span></button>
            </div>
            <div v-if="!favTracks.length" class="muted ld">还没有收藏——播放时点心形图标，或在音乐页点歌曲卡片上的心形收藏</div>
          </template>
        </div>
      </div>

    </div>
  </transition>
</template>

<script setup>
// 底部悬浮播放条（v1.16.0 需求第 5/6 点，v1.16.1 打磨）：播放/暂停/上一曲/下一曲、圆形唱片随播放滚动
// （点它进全屏）、可拖进度条（已播/总时间）、音量、循环切换（off/one/all）、收藏（双职责：切换收藏 +
// 打开收藏夹视图）、播放列表、歌词弹框（逐行高亮自动下滚）。关闭走 close 图标，右下角「音乐」悬浮按钮再浮起。
// v1.16.1 三处改动：① 唱片 12s/圈 → 60s/圈（用户：转太快，至少慢 5 倍）② 全部图标改 Material Icons
// 单色字体（原彩色 emoji 太跳）③ 歌词三态：已唱过最浅 / 当前行最亮 / 未唱中间档，收藏夹行内可加可删。
import { computed, nextTick, ref, watch } from 'vue';
import {
  musicState as music, playAt, playList, toggle, next, prev, seek, setVolume, cycleLoop,
  coverUrl, fmtTime, parseLrc, isFav, toggleFav, loadFavs, enqueue, removeFromQueue, loadMcCfg,
} from '../musicState';

const barEl = ref(null);
const lyEl = ref(null);
const listOpen = ref(false);
const listView = ref('queue'); // queue=播放列表 / fav=我的收藏
const favTracks = computed(() => music.favTracks); // v1.17.0 起共享一份（musicState），收藏两处永远同步
const seeking = ref(false);

const cur = computed(() => (music.index >= 0 ? music.queue[music.index] : null));
const pct = computed(() => {
  const d = music.dur || (cur.value ? cur.value.duration_ms / 1000 : 0);
  return d > 0 ? Math.min(100, (music.pos / d) * 100) : 0;
});
// 循环三态图标：全部循环 repeat / 单曲循环 repeat_one / 顺序播放 arrow_forward（Material Icons 名，别改回 emoji）
const loopIcon = computed(() => (music.loop === 'all' ? 'repeat' : music.loop === 'one' ? 'repeat_one' : 'arrow_forward'));
const loopTitle = computed(() => ({ off: '顺序播放', one: '单曲循环', all: '列表循环' })[music.loop] + '（点击切换）');

// 歌词：同步词逐行高亮 + 平滑下滚
const lines = computed(() => (music.lyrics?.synced && music.lyrics.text ? parseLrc(music.lyrics.text) : []));
const curLine = computed(() => {
  for (let i = lines.value.length - 1; i >= 0; i--) if (music.pos + 0.2 >= lines.value[i].t) return i;
  return -1;
});
watch(curLine, async () => {
  if (!music.lyricsOpen || curLine.value < 0) return;
  await nextTick();
  const el = lyEl.value?.querySelector('.ly-lines');
  if (el) el.parentElement.scrollTop = Math.max(0, curLine.value * 26 - el.parentElement.clientHeight / 2 + 13);
});

// 进度条拖动（pointer 三事件一套）：按下/拖动都即时预览位置，抬起才真 seek
function posFromEvent(e) {
  const r = barEl.value.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const d = music.dur || (cur.value ? cur.value.duration_ms / 1000 : 0);
  return ratio * d;
}
function onSeek(e) { seeking.value = true; e.target.setPointerCapture?.(e.pointerId); seek(posFromEvent(e)); }
function onSeekMove(e) { if (seeking.value) seek(posFromEvent(e)); }

function toggleMute() { setVolume(music.volume === 0 ? 0.9 : 0); }
async function onFav() {
  if (!cur.value) return;
  if (isFav(cur.value.id)) { openFavs(); return; } // 已收藏再点 = 进收藏夹（需求：收藏图标可进入个人收藏夹）
  await toggleFav(cur.value);
  await loadFavs(); // 共享数据：ids + 完整行一起刷新
}
async function openFavs() { listView.value = 'fav'; await loadFavs(); }
function playFav(i) { playList(favTracks.value, i); }
// 收藏夹/播放列表的行内操作（v1.16.1：收藏夹要能加能删，不必回音乐页）
async function favRow(t) { await toggleFav(t); await loadFavs(); }
async function removeFav(t) { await toggleFav(t); await loadFavs(); }
function enqueueFav(t) { enqueue(t); listView.value = 'queue'; }


// 收藏数据等条真打开再拉（组件随 App 常驻挂载，别在启动时空跑两条请求）；配置同理（海报/歌词 API）
watch(() => music.barOpen, (open) => { if (open) { loadFavs(); loadMcCfg(); } });
</script>

<style scoped>
.mcbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; align-items: center; gap: 14px;
  padding: 8px 18px; background: var(--bg2, #1c1f27); border-top: 1px solid var(--border); box-shadow: 0 -6px 24px rgba(0,0,0,.35); }
/* 浮上来/收起都从下方滑（需求第 6 点） */
.mcbar-enter-active, .mcbar-leave-active { transition: transform .28s ease, opacity .28s ease; }
.mcbar-enter-from, .mcbar-leave-to { transform: translateY(100%); opacity: 0; }
/* 唱片 */
.disc { position: relative; width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0; cursor: pointer; overflow: hidden;
  background: radial-gradient(circle at center, #2a2d36 30%, #14161c 100%); border: 2px solid rgba(255,255,255,.14); }
.disc img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
.disc .noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.disc .hole { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: var(--bg2, #1c1f27); border: 1px solid rgba(255,255,255,.2); }
/* v1.16.4：类名 spin → mspin。**别再改回 spin**——style.css 里的全局工具类
   `.spin { animation: spin 1s linear infinite }`（加载转圈用）会同时命中这个容器 div，
   于是封装层的 60s/圈被 1s/圈盖住，用户看到的就是「一点没慢」（v1.16.1 的教训）。
   只让图片/占位图标转，容器本身不许有动画。
   v1.16.7：用户说「唱片旋转速度可以稍微快一点」→ 60s/圈 调到 30s/圈（全屏那张同步 70s→35s，
   两处节奏保持一致：整圈时间减半，仍是慢转，不是加载动画那种 1s/圈）。 */
.disc.mspin img, .disc.mspin .noimg { animation: mcspin 30s linear infinite; }
@keyframes mcspin { to { transform: rotate(360deg); } }
/* 中段 */
.mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mid .line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.mid .t { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mid .a { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; }
.prow { display: flex; align-items: center; gap: 8px; }
.prow .tm { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 30px; }
.prow .tm:last-child { text-align: left; }
.pbar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg3, #2a2d36); cursor: pointer; position: relative; }
.pbar:hover { height: 8px; }
.pbar .fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #4f7cf7, #7aa2ff); pointer-events: none; }
/* 控制键 */
.ctrl { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.cbtn { width: 30px; height: 30px; border-radius: 50%; border: none; background: transparent; color: var(--text);
  font-size: 15px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.cbtn:hover { background: var(--bg3, #2a2d36); }
.cbtn.big { width: 38px; height: 38px; font-size: 17px; background: var(--bg3, #2a2d36); border: 1px solid var(--border); }
.cbtn.on { color: #4f7cf7; }
.cbtn:disabled { opacity: .4; cursor: default; }
/* 图标一律走 Material Icons 单色字体（v1.16.1；字体在 web/public/material-icons/，随 color 渲染） */
.cbtn .material-icons { font-size: 18px; }
.cbtn.big .material-icons { font-size: 22px; }
.ic-sm { font-size: 15px; vertical-align: -3px; }
/* 右侧功能 */
.fx { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.fx .vol { display: inline-flex; align-items: center; gap: 2px; }
.fx input[type="range"] { width: 66px; height: 4px; accent-color: #4f7cf7; cursor: pointer; }
.grow { flex: 1; }
/* 弹框（歌词/播放列表）：从播放条上方弹出 */
.lyrics, .plist { position: absolute; right: 14px; bottom: 74px; width: min(560px, calc(100vw - 28px));
  display: flex; flex-direction: column; max-height: min(420px, 55vh); padding: 10px 12px; }
.ly-head { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border); margin-bottom: 6px; }
.ly-head .pri { color: #4f7cf7; border-color: #4f7cf7; }
.ly-body, .pl-body { overflow-y: auto; flex: 1; }
.ld { padding: 6px; font-size: 12.5px; }
/* 歌词三态（v1.16.1）：base=还没唱（中间档）/ .past=已唱过（最浅）/ .cur=当前行（最亮加粗） */
.ly-lines p { margin: 0; padding: 4px 8px; font-size: 13.5px; color: var(--text); opacity: .58; line-height: 26px;
  border-radius: 6px; transition: opacity .25s ease, color .25s ease; }
.ly-lines p.past { opacity: .28; }
.ly-lines p.cur { opacity: 1; font-weight: 700; background: rgba(79, 124, 247, .12); }
.ly-plain { margin: 0; padding: 6px 8px; font-size: 13px; white-space: pre-wrap; font-family: inherit; color: var(--text2); }
.pl-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.pl-row:hover { background: var(--bg3, #2a2d36); }
.pl-row.cur { background: rgba(79, 124, 247, .14); }
.pl-row.cur .pl-name { color: #4f7cf7; font-weight: 600; }
.pl-idx { width: 20px; text-align: center; color: var(--muted); font-size: 12px; flex-shrink: 0; }
.pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-art { width: 110px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.pl-dur { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
/* 行内操作键（收藏/移除/加待播）：默认淡，行 hover 才实——行窄时不挤占歌名 */
.pl-act { background: transparent; border: none; color: var(--muted); padding: 2px 4px; flex-shrink: 0; opacity: .55; }
.pl-act:hover { opacity: 1; background: var(--bg2, #1c1f27); }
.pl-act.on { color: #4f7cf7; opacity: 1; }
.pl-act.danger:hover { color: var(--red, #e04b4b); }
.ic-heart { color: #4f7cf7; }
/* 窄屏：藏歌手/专辑、音量条缩短 */
@media (max-width: 720px) {
  .mcbar { gap: 8px; padding: 8px 10px; }
  .mid .a { display: none; }
  .pl-art { display: none; }
  .fx input[type="range"] { width: 44px; }
  .lyrics, .plist { right: 6px; width: calc(100vw - 12px); }
}
</style>
