<template>
  <div class="mc">
    <!-- ============ 根目录未配置：引导（管理员可去设置页配置） ============ -->
    <div v-if="!cfg.root_ok" class="card mc-empty">
      <div class="ph">
        <span class="material-icons big-ic">music_note</span> 音乐<br>
        <b>{{ cfg.root ? '音乐目录不可访问：' + cfg.root : '尚未配置音乐路径' }}</b>
        <div style="font-size:12px">
          {{ isAdmin ? '到「设置 → 音乐路径」填写 NAS 目录后点「重新扫描」即可听歌' : '请联系管理员在「设置」页的「音乐路径」配置音乐目录' }}
        </div>
      </div>
    </div>

    <!-- ============ 主界面：左（统计卡 + 目录树）+ 右（歌曲多列卡片） ============ -->
    <div v-else class="mc-body">
      <div class="mc-head">
        <span class="cur"><span class="material-icons">music_note</span> 音乐</span>
        <!-- 视图切换（v1.16.1）：音乐库 / 我的收藏（收藏夹独立入口，里面的曲子可加可删） -->
        <button class="small vtab" :class="{ pri: view === 'lib' }" @click="view = 'lib'">音乐库</button>
        <button class="small vtab" :class="{ pri: view === 'fav' }" @click="openFavView">
          <span class="material-icons ic-sm">favorite</span> 我的收藏（{{ favTracks.length }}）
        </button>
        <span class="muted" style="font-size:12px">共 {{ stats.total }} 首 · 点击歌曲即播</span>
        <span class="grow"></span>
        <button v-if="isAdmin" class="small" :disabled="scanning" @click="rescan">
          <span class="material-icons ic-sm">refresh</span> {{ scanning ? '扫描中…' : '重新扫描' }}
        </button>
      </div>
      <div class="mc-main">
        <!-- 左栏：四张统计卡 + 目录树（照视频中心的展开结构） -->
        <div class="mc-left">
          <div class="mc-stats">
            <div class="mc-stat"><b>{{ stats.total }}</b><span>歌曲数量</span></div>
            <div class="mc-stat"><b>{{ stats.covers }}</b><span>已有封面</span></div>
            <div class="mc-stat warn"><b>{{ stats.nocover }}</b><span>未匹配封面</span></div>
            <div class="mc-stat warn"><b>{{ stats.pending }}</b><span>待处理</span></div>
          </div>
          <!-- 浏览方式切换（v1.16.7）：目录（默认，照视频中心）/ 歌手（左歌手 · 右专辑） -->
          <div class="mc-modes">
            <button class="small vtab" :class="{ pri: mode === 'dir' }" @click="setMode('dir')">
              <span class="material-icons ic-sm">folder</span> 目录
            </button>
            <button class="small vtab" :class="{ pri: mode === 'artist' }" @click="setMode('artist')">
              <span class="material-icons ic-sm">person</span> 歌手
            </button>
          </div>
          <!-- 目录模式：目录树（照视频中心的展开结构） -->
          <div v-if="mode === 'dir'" class="tree card grow">
            <div class="tree-root" :class="{ sel: curDir === '' }" @click="openDir('')"><span class="material-icons ic-sm">library_music</span> 全部音乐</div>
            <div class="tree-children">
              <McTreeNode v-for="e in rootEntries" :key="e.name" :entry="e" parent="" :selected="curDir" @select="openDir" />
              <div v-if="!rootEntries.length && !treeLoading" class="muted ld">（目录为空）</div>
            </div>
          </div>
          <!-- 歌手模式：歌手清单（点歌手 → 右侧出他的专辑；再点专辑 → 出歌） -->
          <div v-else class="tree card grow mc-artists">
            <div v-if="artLoading" class="muted ld">加载中…</div>
            <template v-else>
              <div class="tree-root" :class="{ sel: curArtist === null }" @click="openArtist(null)">
                <span class="material-icons ic-sm">queue_music</span> 全部歌手（{{ artists.length }}）
              </div>
              <div class="ar-row" v-for="a in artists" :key="a.name" :class="{ sel: curArtist === a.name }"
                   :title="a.name || '未知歌手'" @click="openArtist(a.name)">
                <span class="ar-name">{{ a.name || '未知歌手' }}</span>
                <span class="ar-num">{{ a.tracks }} 首 · {{ a.albums.length }} 张</span>
              </div>
              <div v-if="!artists.length" class="muted ld">（曲库里还没有歌手信息，点右上角「重新扫描」试试）</div>
            </template>
          </div>
        </div>

        <!-- 右栏：音乐库（当前目录歌曲卡片）/ 我的收藏（v1.16.1 收藏夹独立入口） -->
        <div class="card zone">
          <div class="zone-head">
            <span class="muted" style="font-size:12px">
              <span class="material-icons ic-sm">{{ zoneIcon }}</span>
              {{ zoneTitle }}
            </span>
            <span class="muted" style="font-size:12px">{{ zoneCount }}</span>
            <span v-if="msg" class="muted" style="font-size:12px">{{ msg }}</span>
            <span class="grow"></span>
            <button v-if="curList.length" class="small" @click="playAll"><span class="material-icons ic-sm">play_arrow</span> 全部播放</button>
            <button v-if="view === 'fav'" class="small" @click="view = 'lib'"><span class="material-icons ic-sm">queue_music</span> 回音乐库</button>
            <button v-else-if="albumOpen || (mode === 'artist' && curArtist !== null)" class="small" @click="backFromArtist">
              <span class="material-icons ic-sm">arrow_upward</span> {{ albumOpen ? '返回专辑' : '全部专辑' }}
            </button>
            <button v-else-if="curDir" class="small" @click="openDir('')"><span class="material-icons ic-sm">arrow_upward</span> 返回根目录</button>
          </div>

          <!-- 我的收藏：列表行（播放 / 加入待播 / 从收藏移除） -->
          <template v-if="view === 'fav'">
            <div v-if="favTracks.length" class="mc-favlist">
              <div v-for="(t, i) in favTracks" :key="t.id" class="fav-row" :class="{ playing: curId === t.id }" @click="playFavTrack(i)">
                <span class="fav-no">{{ i + 1 }}</span>
                <span class="fav-name" :title="t.title">{{ t.title }}</span>
                <span class="fav-art" :title="t.artist">{{ t.artist || '未知歌手' }}</span>
                <span class="fav-alb" :title="t.album">{{ t.album || '' }}</span>
                <span class="fav-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
                <button class="fav-act" title="加入待播（排到当前曲之后）" @click.stop="addQueue(t)">
                  <span class="material-icons ic-sm">playlist_add</span>
                </button>
                <button class="fav-act danger" title="从我的收藏移除" @click.stop="unfav(t)">
                  <span class="material-icons ic-sm">delete</span>
                </button>
              </div>
            </div>
            <div v-else class="ph">
              还没有收藏<br>
              <span style="font-size:12px">在音乐库里点歌曲卡片右下角的心形，或播放时点播放条上的心形，就会出现在这里</span>
            </div>
          </template>

          <!-- 歌手模式·专辑层（v1.16.7）：还没点进某张专辑时，右栏放专辑卡片；点卡片进歌单 -->
          <template v-else-if="mode === 'artist' && !albumOpen">
            <div v-if="curAlbums.length" class="mc-grid">
              <div v-for="al in curAlbums" :key="al.artist + '\u0000' + al.name" class="mc-card" @click="openAlbum(al.artist, al.name)">
                <div class="mc-cover">
                  <img v-if="al.cover_id" :src="coverUrl(al.cover_id)" loading="lazy" alt="" />
                  <span v-else class="mc-noimg material-icons">album</span>
                  <button class="mc-add mc-add-queue" title="整张专辑加入待播" @click.stop="queueAlbum(al)">
                    <span class="material-icons">playlist_add</span>
                  </button>
                  <button class="mc-add" title="播放整张专辑" @click.stop="playAlbum(al)">
                    <span class="material-icons">play_arrow</span>
                  </button>
                </div>
                <div class="mc-title" :title="al.name">{{ al.name || '未知专辑' }}</div>
                <div class="mc-meta">
                  <span class="mc-dur">{{ al.tracks }} 首</span>
                  <span class="mc-artist" :title="al.artist">{{ al.artist || '未知歌手' }}</span>
                </div>
                <div class="mc-album">{{ fmtTime(al.duration_ms / 1000) }}</div>
              </div>
            </div>
            <div v-else class="ph">
              <span class="material-icons big-ic">album</span>
              {{ curArtist === null ? '曲库里还没有专辑信息' : '这位歌手没有别的信息了' }}<br>
              <span style="font-size:12px">专辑信息来自歌曲文件的内嵌标签（mp3/flac/m4a 都能读）；没有标签时会退到文件名与所在目录</span>
            </div>
          </template>

          <!-- 音乐库：当前目录歌曲多列卡片（歌手模式下点进专辑后复用同一套卡片） -->
          <template v-else>
            <div v-if="libLoading" class="muted ld">加载中…</div>
            <div v-else-if="libError" class="muted ld err">{{ libError }}</div>
            <template v-else>
              <!-- 子目录快捷（点击即切过去，与左侧树等价） -->
              <div v-if="lib.subdirs.length" class="mc-subdirs">
                <button v-for="d in lib.subdirs" :key="d.path" class="small" @click="openDir(d.path)">
                  <span class="material-icons ic-sm">folder</span> {{ d.name }}
                </button>
              </div>
              <div v-if="lib.tracks.length" class="mc-grid">
                <div v-for="(t, i) in lib.tracks" :key="t.id" class="mc-card" :class="{ playing: curId === t.id }" @click="playTrack(i)">
                  <div class="mc-cover">
                    <img v-if="t.has_cover" :src="coverUrl(t.id)" loading="lazy" alt="" @error="t.has_cover = 0" />
                    <span v-else class="mc-noimg material-icons">music_note</span>
                    <span v-if="curId === t.id && music.playing" class="mc-eq"><i></i><i></i><i></i></span>
                    <button class="mc-add" :class="{ on: isFav(t.id) }" :title="isFav(t.id) ? '取消收藏' : '加入我的收藏'" @click.stop="favCard(t)">
                      <span class="material-icons">{{ isFav(t.id) ? 'favorite' : 'favorite_border' }}</span>
                    </button>
                    <button class="mc-add mc-add-queue" title="加入播放列表待播" @click.stop="addQueue(t)">
                      <span class="material-icons">playlist_add</span>
                    </button>
                  </div>
                  <div class="mc-title" :title="t.title">{{ t.title }}</div>
                  <div class="mc-meta" :title="(t.artist || '未知歌手') + ' · ' + fmtTime(t.duration_ms / 1000)">
                    <span class="mc-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
                    <span class="mc-artist">{{ t.artist || '未知歌手' }}</span>
                  </div>
                  <div class="mc-album" :title="t.album">{{ t.album || ' ' }}</div>
                </div>
              </div>
              <div v-else class="ph">
                <span class="material-icons big-ic">folder_off</span> 这个目录里没有歌曲<br>
                <span style="font-size:12px">试试左侧的其它目录，或点「重新扫描」拉取新增文件</span>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 音乐中心面板（v1.16.0，v1.16.1 打磨）：人工智能页「音乐」tab。左 = 四张统计卡 + 目录树（McTreeNode 懒加载），
// 右 = 当前目录歌曲多列卡片（封面/歌名/时长/歌手/专辑 + 收藏心形 + 加入待播）。点歌即播 → 底部浮出 MusicBar。
// 整页不限宽（wbMainFull，GeoPanel/AiChat 先例）——大屏多列铺开。
// v1.16.1：① 顶部「音乐库 / 我的收藏（N）」视图切换——收藏夹有了独立入口，行内能播/加待播/删
//          ② 卡片右上角心形即时收藏 ③ 全部图标改 Material Icons 单色字体（原彩色 emoji 太跳）。
// v1.16.7：左栏加「目录 / 歌手」切换——歌手模式左栏列歌手、右栏列该歌手的专辑、点专辑出歌单
//          （数据全来自 mc_tracks 的 artist/album 列，服务端 GROUP BY，没有新表）。
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import McTreeNode from './McTreeNode.vue';
import {
  musicState as music, playList, enqueue, coverUrl, fmtTime, loadFavs, isFav, toggleFav, loadMcCfg,
} from '../musicState';

const mainFull = inject('wbMainFull', null);
const isAdmin = (() => { try { return (JSON.parse(localStorage.getItem('wb_user') || '{}') || {}).role === 'admin'; } catch { return false; } })();

const cfg = ref({ root: '', root_ok: false, stats: { total: 0, covers: 0, nocover: 0, pending: 0 } });
const stats = computed(() => cfg.value.stats || { total: 0, covers: 0, nocover: 0, pending: 0 });
const rootEntries = ref([]);
const treeLoading = ref(false);
const scanning = ref(false);

const curDir = ref('');
const lib = ref({ tracks: [], subdirs: [] });
const libLoading = ref(false);
const libError = ref('');
const msg = ref(''); // 扫描结果等一句话提示（6 秒自动消失）
const curId = computed(() => (music.index >= 0 ? music.queue[music.index]?.id : 0));

// 视图（v1.16.1）：lib = 音乐库（目录歌曲卡片）/ fav = 我的收藏（收藏夹，行内可加待播可删）
const view = ref('lib');
const favTracks = ref([]);
const curList = computed(() => (view.value === 'fav' ? favTracks.value : lib.value.tracks)); // 「全部播放」按当前视图取表

// 浏览方式（v1.16.7）：dir = 目录树（默认，照视频中心）/ artist = 歌手 → 专辑 → 歌曲（需求原话见 mcRoutes.js）
// 三级状态：curArtist（null = 全部歌手）/ curAlbum（null = 专辑层；'' 是「未知专辑」那一档，故意与 null 区分）
// / albumOpen 一算，整块右栏与返回按钮全靠它分叉
const mode = ref('dir');
const artists = ref([]);
const artLoading = ref(false);
const curArtist = ref(null);
const curAlbum = ref(null);
const albumOpen = computed(() => curAlbum.value !== null);
// 右栏专辑层要显示的那一批：全部歌手 = 各歌手的专辑摊平（卡片上带歌手名便于区分）
const curAlbums = computed(() => {
  if (curArtist.value === null) return artists.value.flatMap((a) => a.albums.map((al) => ({ ...al, artist: a.name })));
  const box = artists.value.find((x) => x.name === curArtist.value);
  return (box ? box.albums : []).map((al) => ({ ...al, artist: curArtist.value }));
});
const zoneIcon = computed(() => (view.value === 'fav' ? 'favorite' : mode.value === 'artist' ? (albumOpen.value ? 'album' : 'person') : 'folder'));
const zoneTitle = computed(() => {
  if (view.value === 'fav') return '我的收藏';
  if (mode.value === 'artist') {
    const who = curArtist.value === null ? '全部歌手' : (curArtist.value || '未知歌手');
    return albumOpen.value ? `${who} · ${curAlbum.value || '未知专辑'}` : `${who} 的专辑`;
  }
  return curDir.value || '根目录';
});
const zoneCount = computed(() => {
  if (view.value === 'fav') return `${favTracks.value.length} 首`;
  if (mode.value === 'artist') return albumOpen.value ? `${lib.value.tracks.length} 首` : `${curAlbums.value.length} 张专辑`;
  return `${lib.value.tracks.length} 首`;
});

onMounted(async () => {
  if (mainFull) mainFull.value = true; // 整页不限宽
  loadFavs();
  loadMcCfg();
  await loadCfg();
  loadTree();
  openDir('');
});
onBeforeUnmount(() => { if (mainFull) mainFull.value = false; });

async function loadCfg() {
  try {
    cfg.value = await api.get('/mc/config');
  } catch (e) {
    cfg.value = { root: '', root_ok: false, stats: { total: 0, covers: 0, nocover: 0, pending: 0 } };
  }
}
async function loadTree() {
  treeLoading.value = true;
  try {
    const r = await api.get('/mc/tree');
    rootEntries.value = r.entries || [];
  } catch { rootEntries.value = []; }
  treeLoading.value = false;
}
async function openDir(dir) {
  curDir.value = dir;
  libLoading.value = true;
  libError.value = '';
  try {
    const r = await api.get('/mc/library?dir=' + encodeURIComponent(dir));
    lib.value = { tracks: r.tracks || [], subdirs: r.subdirs || [] };
  } catch (e) { libError.value = e.message; }
  libLoading.value = false;
}
function playTrack(i) {
  playList(lib.value.tracks, i);
  music.barOpen = true; // 点歌浮出底部播放条
}

// ---------- 歌手 / 专辑（v1.16.7）----------
// 数据全来自曲库已有的 artist/album 列（服务端 GROUP BY，无新表）；这一层只做「谁 → 哪张 → 哪些歌」的走位
async function loadArtists() {
  artLoading.value = true;
  try { const r = await api.get('/mc/artists'); artists.value = r.artists || []; } catch { artists.value = []; }
  artLoading.value = false;
}
async function setMode(m) {
  if (mode.value === m) return;
  mode.value = m;
  if (m === 'artist') {
    if (!artists.value.length) await loadArtists();
  } else {
    curArtist.value = null;
    curAlbum.value = null;
    await openDir(curDir.value); // 从专辑层切回目录时，右栏得重新拉回该目录的歌
  }
}
async function openArtist(name) {
  curArtist.value = name;
  curAlbum.value = null;
  if (!artists.value.length) await loadArtists();
  // 重新扫描后这个歌手可能整个消失了——别让左栏高亮停在一个不存在的名字上
  if (curArtist.value !== null && !artists.value.some((a) => a.name === curArtist.value)) curArtist.value = null;
}
async function openAlbum(artist, album) {
  curArtist.value = artist;   // 从「全部专辑」点进某张时左栏跟着选中该歌手，层级不会打架
  curAlbum.value = album;
  libLoading.value = true;
  libError.value = '';
  try {
    const r = await api.get(`/mc/album-tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
    lib.value = { tracks: r.tracks || [], subdirs: [] };
  } catch (e) { libError.value = e.message; }
  libLoading.value = false;
}
function backFromArtist() {
  if (albumOpen.value) { curAlbum.value = null; return; } // 返回该歌手的专辑层
  curArtist.value = null;                                 // 再退一层 = 全部歌手的专辑
  lib.value = { tracks: [], subdirs: [] };
}
async function playAlbum(al) {
  await openAlbum(al.artist, al.name);
  if (lib.value.tracks.length) { playList(lib.value.tracks, 0); music.barOpen = true; }
}
async function queueAlbum(al) {
  try {
    const r = await api.get(`/mc/album-tracks?artist=${encodeURIComponent(al.artist)}&album=${encodeURIComponent(al.name)}`);
    const list = r.tracks || [];
    if (!list.length) return;
    music.barOpen = true;
    if (!music.playing && music.index < 0) { playList(list, 0); return; } // 队列空时直接从头播
    for (const t of list) enqueue(t);
    flash(`已把「${al.name || '未知专辑'}」${list.length} 首加入待播`);
  } catch (e) { flash('加入待播失败：' + e.message); }
}
function playFavTrack(i) {
  playList(favTracks.value, i);
  music.barOpen = true;
}
function playAll() { if (view.value === 'fav') playFavTrack(0); else playTrack(0); }
function addQueue(t) {
  music.barOpen = true;
  if (!music.playing && music.index < 0) { playList([t], 0); return; } // 队列空时直接播这首
  enqueue(t);
  flash(`已把「${t.title}」加入待播`);
}

// ---------- 收藏（v1.16.1）：卡片心形即时收藏/取消；收藏夹视图里能播、能加待播、能删 ----------
async function loadFavList() {
  try { const r = await api.get('/mc/favorites'); favTracks.value = r.tracks || []; } catch { favTracks.value = []; }
}
async function openFavView() {
  view.value = 'fav';
  await loadFavList();
}
async function favCard(t) {
  const on = await toggleFav(t);
  loadFavs();
  flash(on ? `已收藏「${t.title}」` : `已取消收藏「${t.title}」`);
}
async function unfav(t) {
  await toggleFav(t);
  await loadFavList();
  loadFavs();
  flash(`已从收藏移除「${t.title}」`);
}
function flash(text) {
  msg.value = text;
  setTimeout(() => { if (msg.value === text) msg.value = ''; }, 2500);
}
async function rescan() {
  scanning.value = true;
  try {
    const r = await api.post('/mc/scan');
    await loadCfg();
    loadTree();
    // 扫描后当前视图要重新对齐：目录模式回该目录；歌手模式重拉歌手表（刚消失的歌手要让左栏高亮落地）
    if (mode.value === 'artist') {
      await loadArtists();
      if (curArtist.value !== null && !artists.value.some((a) => a.name === curArtist.value)) { curArtist.value = null; curAlbum.value = null; }
      if (albumOpen.value) await openAlbum(curArtist.value, curAlbum.value);
    } else await openDir(curDir.value);
    if (r.ok) {
      const parts = [];
      if (r.added) parts.push(`新增 ${r.added}`);
      if (r.updated) parts.push(`更新 ${r.updated}`);
      if (r.removed) parts.push(`移除 ${r.removed}`);
      msg.value = `扫描完成：共 ${r.total} 首` + (parts.length ? '（' + parts.join('，') + '）' : '，无变化');
    } else msg.value = r.error || '扫描失败';
  } catch (e) { msg.value = '扫描失败：' + e.message; }
  scanning.value = false;
  setTimeout(() => { if (msg.value.startsWith('扫描')) msg.value = ''; }, 6000);
}
</script>

<style scoped>
.mc { display: flex; flex-direction: column; gap: 12px; }
.mc-empty { padding: 44px; }
.mc-empty .ph { text-align: center; color: var(--muted); line-height: 2; }
.mc-empty .ph b { color: var(--text); font-size: 15px; }
.mc-head { display: flex; align-items: center; gap: 10px; }
.mc-head .cur { font-size: 15px; font-weight: 600; }
.grow { flex: 1; }
.mc-main { display: flex; gap: 12px; align-items: stretch; min-height: 420px; }
.mc-left { width: 250px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; }
/* 四张统计卡（目录树上方，两列两行） */
.mc-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mc-stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.mc-stat b { font-size: 20px; }
.mc-stat span { font-size: 11.5px; color: var(--muted); }
.mc-stat.warn b { color: #e0a23c; }
/* 目录树（照视频中心样式） */
.tree { padding: 10px; overflow: auto; }
.tree-root { font-size: 13.5px; font-weight: 600; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.tree-root:hover { background: var(--bg3); }
.tree-root.sel { background: rgba(79, 124, 247, 0.18); }
.tree-children { margin-left: 10px; border-left: 1px dashed var(--border); padding-left: 4px; }
.ld { padding: 6px; font-size: 12.5px; }
.ld.err { color: var(--red); }
/* 浏览方式切换「目录 / 歌手」（v1.16.7）：两个等宽按钮，选中态沿用 .vtab.pri */
.mc-modes { display: flex; gap: 6px; }
.mc-modes .vtab { flex: 1; justify-content: center; }
/* 歌手清单（左栏，接替目录树的位置；同样自带滚动） */
.mc-artists { display: flex; flex-direction: column; gap: 1px; padding: 8px; }
.ar-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.ar-row:hover { background: var(--bg3); }
.ar-row.sel { background: rgba(79, 124, 247, 0.18); }
.ar-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-num { font-size: 11px; color: var(--muted); flex-shrink: 0; }
/* 右侧内容框 */
.zone { flex: 1; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.zone-head { display: flex; align-items: center; gap: 10px; }
.mc-subdirs { display: flex; flex-wrap: wrap; gap: 6px; }
.ph { text-align: center; color: var(--muted); padding: 40px 0; line-height: 2; }
/* 歌曲多列卡片 */
.mc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; align-content: start; overflow-y: auto; }
.mc-card { cursor: pointer; border-radius: 10px; padding: 8px; border: 1px solid transparent; }
.mc-card:hover { background: var(--bg3); }
.mc-card.playing { border-color: rgba(79, 124, 247, 0.55); background: rgba(79, 124, 247, 0.08); }
.mc-cover { position: relative; width: 100%; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--bg3); margin-bottom: 8px; }
.mc-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mc-noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 34px; }
/* 卡片上的两个圆钮（v1.16.1）：收藏心形 + 加入待播；平时隐藏，hover/已收藏时露出 */
.mc-add { position: absolute; right: 6px; bottom: 6px; width: 26px; height: 26px; border-radius: 50%; border: none;
  background: rgba(20, 22, 28, 0.72); color: #fff; font-size: 15px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .15s;
  display: inline-flex; align-items: center; justify-content: center; }
.mc-add .material-icons { font-size: 16px; }
.mc-add-queue { right: 38px; }
.mc-add.on { opacity: 1; color: #ff6b81; }  /* 已收藏：心形常驻并点亮 */
.mc-card:hover .mc-add, .mc-add:focus-visible { opacity: 1; }
/* 我的收藏列表行 */
.mc-favlist { display: flex; flex-direction: column; overflow-y: auto; flex: 1; min-height: 0; }
.fav-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.fav-row:hover { background: var(--bg3); }
.fav-row.playing { background: rgba(79, 124, 247, 0.1); }
.fav-no { width: 22px; text-align: center; color: var(--muted); font-size: 12px; flex-shrink: 0; }
.fav-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.fav-art { width: 130px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.fav-alb { width: 150px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.fav-dur { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.fav-act { background: transparent; border: none; color: var(--muted); padding: 2px 5px; cursor: pointer; flex-shrink: 0; opacity: .6; }
.fav-act:hover { opacity: 1; background: var(--bg2); border-radius: 6px; }
.fav-act.danger:hover { color: var(--red, #e04b4b); }
/* 图标（Material Icons 单色字体，v1.16.1 全模块统一，不再用彩色 emoji） */
.ic-sm { font-size: 15px; vertical-align: -3px; }
.big-ic { font-size: 40px; display: block; margin: 0 auto 6px; color: var(--muted); }
.mc-head .cur .material-icons { font-size: 19px; vertical-align: -4px; }
.vtab { display: inline-flex; align-items: center; gap: 3px; }
.vtab.pri { color: #4f7cf7; border-color: #4f7cf7; }
.mc-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-top: 2px; }
.mc-dur { flex-shrink: 0; background: var(--bg3); border-radius: 4px; padding: 0 5px; }
.mc-artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-album { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; min-height: 15px; }
/* 正在播的小均衡器动画 */
.mc-eq { position: absolute; left: 8px; bottom: 8px; display: flex; align-items: flex-end; gap: 2px; height: 14px; }
.mc-eq i { width: 3px; background: #4f7cf7; border-radius: 1px; animation: mceq .9s ease-in-out infinite; }
.mc-eq i:nth-child(2) { animation-delay: .25s; }
.mc-eq i:nth-child(3) { animation-delay: .5s; }
@keyframes mceq { 0%, 100% { height: 4px; } 50% { height: 14px; } }
/* 窄屏：左右上下堆叠 */
@media (max-width: 860px) {
  .mc-main { flex-direction: column; }
  .mc-left { width: auto; }
  .tree { max-height: 220px; }
}
</style>
