<template>
  <div class="vstudy">
    <!-- ============ 第一步：开始学习 ============ -->
    <div v-if="stage === 'idle'" class="card idle">
      <button class="big-start" :disabled="!cfg.root_ok" @click="stage = 'year'">▶ 开始学习</button>
      <div class="muted" style="margin-top:12px">选择学年与学科后，浏览 NAS 学习目录中的视频和文档</div>
      <div v-if="!cfg.root_ok" class="warnbox">
        {{ cfg.root ? '学习目录不可访问：' + cfg.root : '尚未配置 NAS 学习目录' }}，
        请到 <router-link to="/learning?tab=vsettings">视频教学设置</router-link> 填写
      </div>
    </div>

    <!-- ============ 历史学习列表（本人过往每次学习的会话明细） ============ -->
    <div v-if="stage === 'idle'" class="card hist">
      <h3>历史学习列表 <span class="muted" style="font-size:12px; font-weight:400">点击条目回到学习页，直接打开该文件继续学</span></h3>
      <div class="hist-wrap">
        <table class="hist-tbl">
          <thead>
            <tr>
              <th>序号</th><th>日期时间</th><th>学年</th><th>科目</th><th>学习时长</th>
              <th>开始时间</th><th>关闭时间</th><th>文件路径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in hist.sessions" :key="s.id" class="hist-row" title="点击继续学习该文件" @click="resumeSession(s)">
              <td>{{ (hist.page - 1) * hist.pageSize + i + 1 }}</td>
              <td>{{ dPart(s.started_at) }}</td>
              <td>{{ s.school_year || '—' }}</td>
              <td>{{ s.subject || '—' }}</td>
              <td>{{ fmtDur(s.watched_sec) }}</td>
              <td>{{ tPart(s.started_at) }}</td>
              <td>{{ s.ended_at ? tPart(s.ended_at) : '进行中' }}</td>
              <td class="hist-path" :title="s.path">{{ s.path }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!hist.sessions.length && !histLoading" class="empty">暂无学习记录，点上方「开始学习」开始第一次学习</div>
      </div>
      <div class="row hist-foot">
        <span class="muted" style="font-size:12px">共 {{ hist.total }} 条</span>
        <span class="grow"></span>
        <button class="small" :disabled="hist.page <= 1" @click="loadHist(hist.page - 1)">‹ 上一页</button>
        <span class="muted" style="font-size:12px">{{ hist.page }} / {{ Math.max(1, Math.ceil(hist.total / hist.pageSize)) }}</span>
        <button class="small" :disabled="hist.page >= Math.ceil(hist.total / hist.pageSize)" @click="loadHist(hist.page + 1)">下一页 ›</button>
      </div>
    </div>

    <!-- ============ 第二步：选学年（大按钮，预留扩展空间） ============ -->
    <div v-else-if="stage === 'year'" class="card pick">
      <h3>选择学年</h3>
      <div class="big-grid">
        <button v-for="y in cfg.years" :key="y" class="big-btn" @click="pickYear(y)">{{ y }}</button>
      </div>
      <div v-if="!cfg.years.length" class="empty">暂无学年，请到「视频教学设置」添加</div>
      <div class="pick-foot">
        <button class="small" @click="stage = 'idle'">← 返回</button>
        <span class="muted">学年/学科可在「视频教学设置」中增删</span>
      </div>
    </div>

    <!-- ============ 第三步：选学科 ============ -->
    <div v-else-if="stage === 'subject'" class="card pick">
      <h3>{{ year }} · 选择学科</h3>
      <div class="big-grid">
        <button v-for="s in cfg.subjects" :key="s" class="big-btn" @click="pickSubject(s)">{{ s }}</button>
      </div>
      <div class="pick-foot">
        <button class="small" @click="stage = 'year'">← 重选学年</button>
      </div>
    </div>

    <!-- ============ 学习界面：左 1/4 目录树 + 右上媒体播放 + 右下文档预览 ============ -->
    <div v-else class="vs">
      <div class="vs-head">
        <span class="cur">📖 {{ year }} · {{ subject }}</span>
        <!-- 通道指示：配置了本地直连才显示，让「现在走哪条路」一眼可见 -->
        <span v-if="channel === 'local'" class="lb ok" title="视频/文档正从局域网直连读取（更快）">⚡ 本地直连</span>
        <span v-else-if="channel === 'net'" class="lb" title="本地地址不可达，已回落当前公网地址">公网通道</span>
        <button class="small" @click="restart">重新选择</button>
      </div>
      <div class="vs-body">
        <div class="tree card">
          <div class="tree-root" @click="toggleRoot">{{ rootOpen ? '📂' : '📁' }} 学习目录</div>
          <div v-if="rootOpen" class="tree-children">
            <div v-if="treeLoading" class="muted ld">加载中…</div>
            <div v-else-if="treeError" class="muted ld err">{{ treeError }}</div>
            <template v-else>
              <VsTreeNode v-for="e in rootEntries" :key="e.name" :entry="e" parent="" />
              <div v-if="!rootEntries.length" class="muted ld">（目录为空）</div>
            </template>
          </div>
        </div>

        <div class="vs-main">
          <!-- 右上：视频 / 音频播放器 + 右侧「学习监控状态」小窗 -->
          <div class="card zone player-zone">
            <div v-if="curMedia" class="zone-head">
              🎬 {{ curMedia.name }}
              <span class="muted" style="font-size:12px">{{ curMedia.ext.toUpperCase() }}</span>
              <span class="grow"></span>
              <button class="small" @click="closeMedia">✕ 关闭</button>
            </div>
            <div class="zone-body">
              <div class="player-col">
                <video v-show="curMedia && !mediaIssue" ref="videoEl" controls controlslist="nodownload" preload="auto" @timeupdate="onTimeUpdate" @play="onPlayStart" @pause="flushMedia" @ended="onEnded" @error="onVideoError"></video>
                <!-- 播不了时如实说清原因（真实容器 / 编码），按钮行仍在，可直接转外部播放器 -->
                <div v-if="mediaIssue" class="media-issue">
                  <b>⚠️ 这个文件浏览器播不了</b>
                  <span>{{ mediaIssue }}</span>
                  <span class="muted">下面是外部播放器按钮，PotPlayer / VLC 能原样打开服务器上的这个文件。</span>
                </div>
                <!-- 外部播放器调起（v1.8.7）：浏览器 <video> 解不动 HEVC 10bit/4K，交给本地播放器硬解 -->
                <div v-if="curMedia" class="ext-row">
                  <button class="small" @click="openExternal('potplayer')">▶ PotPlayer 播放</button>
                  <button class="small" @click="openExternal('vlc')">▶ VLC 播放</button>
                  <button class="small" @click="copyMediaUrl">🔗 复制直链</button>
                  <span class="muted ext-tip">HEVC / 10bit / 4K 请用外部播放器（浏览器解不动）；首次使用先<a href="#" @click.prevent="dlExtSetup">⬇ 安装联动脚本</a>（自动识别已装的播放器，免管理员）</span>
                </div>
                <div v-if="!curMedia" class="ph">🎞 视频播放区（mp4 · flv · mkv）／ 🎵 音频（mp3）<br><span style="font-size:12px">在左侧目录点击媒体文件开始播放（按文件真实容器选播放方式，扩展名写错也能播）</span></div>
              </div>

              <!-- 学习监控状态（v1.13.8）：视频一开播就打开本机摄像头（320×240），定时截图存服务器 -->
              <div class="monitor">
                <div class="mon-title">📹 学习监控状态</div>
                <div class="cam-box">
                  <video ref="camEl" class="cam" :class="{ hide: camState !== 'on' }" autoplay muted playsinline></video>
                  <div v-if="camState !== 'on'" class="cam-cover">
                    <div class="cam-ph">{{ camState === 'starting' ? '摄像头启动中…' : '摄像头未开启' }}</div>
                    <div v-if="camMsg" class="cam-msg">{{ camMsg }}</div>
                  </div>
                </div>
                <div class="cam-hint">
                  <template v-if="!checkEnabled">「视频学习检查」已关闭：不弹注意力检测，也不开摄像头、不截图（可在 设置 → 常规设置 → 视频学习检查 打开）。</template>
                  <template v-else-if="camState === 'on'">本机摄像头已开启（320×240，仅本地预览）。视频播放中每 <b>{{ camIntervalMin }}</b> 分钟自动截一张图存到服务器（暂停时不截），文件名 = 日期时间 + 播放的视频名称。</template>
                  <template v-else>点左侧媒体文件播放时，会自动打开本机摄像头并按每 {{ camIntervalMin }} 分钟截一张图（需在浏览器弹窗里允许使用摄像头）。</template>
                </div>
              </div>
            </div>

            <!-- 截图流水（v1.13.8）：历史截图路径，默认每页 10 行，管理员可多选删除 -->
            <div class="shots">
              <div class="shots-head">
                <b>截图流水</b>
                <select v-if="isAdmin" v-model="shotUid" class="mini" @change="loadShots(1)">
                  <option value="all">全部用户</option>
                  <option value="me">仅我自己</option>
                  <option v-for="u in shots.users" :key="u.id" :value="String(u.id)">{{ u.name }}</option>
                </select>
                <span class="grow"></span>
                <button v-if="isAdmin" class="small del" :disabled="!shotSel.length" @click="delShots()">🗑 删除选中（{{ shotSel.length }}）</button>
                <span class="muted">每页</span>
                <select v-model.number="shotSize" class="mini" @change="loadShots(1)">
                  <option v-for="n in SHOT_SIZES" :key="n" :value="n">{{ n }}</option>
                </select>
                <span class="muted">行</span>
              </div>
              <div class="shots-wrap">
                <table class="shot-tbl">
                  <thead>
                    <tr>
                      <th v-if="isAdmin" class="ck"><input type="checkbox" :checked="allSel" @change="toggleAll($event)" /></th>
                      <th>截图时间</th>
                      <th v-if="isAdmin">用户</th>
                      <th>播放的视频</th>
                      <th>保存路径</th>
                      <th class="op">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in shots.rows" :key="r.id">
                      <td v-if="isAdmin" class="ck"><input v-model="shotSel" type="checkbox" :value="r.id" /></td>
                      <td>{{ r.created_at }}</td>
                      <td v-if="isAdmin">{{ r.user_name }}</td>
                      <td class="el" :title="r.video">{{ r.video }}</td>
                      <td class="el" :title="r.path">{{ r.path }}</td>
                      <td class="op"><a href="#" @click.prevent="viewShot(r)">查看</a></td>
                    </tr>
                    <tr v-if="!shots.rows.length">
                      <td :colspan="isAdmin ? 6 : 4" class="none">{{ shotsLoading ? '加载中…' : '暂无截图——视频播放中每 ' + camIntervalMin + ' 分钟会自动截一张' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="shots-foot">
                <span class="muted">共 {{ shots.total }} 条 · 第 {{ shots.page }} / {{ shotPages }} 页</span>
                <button class="small" :disabled="shots.page <= 1" @click="loadShots(shots.page - 1)">← 上一页</button>
                <button class="small" :disabled="shots.page >= shotPages" @click="loadShots(shots.page + 1)">下一页 →</button>
              </div>
            </div>
          </div>

          <!-- 右下：文档预览 -->
          <div class="card zone doc-zone">
            <div v-if="curDoc" class="zone-head">
              📄 {{ curDoc.name }}
              <span class="grow"></span>
              <a class="small dl" :href="fileUrl(curDoc.rel, true)" target="_blank" :download="curDoc.name">下载</a>
              <button class="small" @click="closeDoc">✕ 关闭</button>
            </div>
            <template v-if="curDoc">
              <div v-if="docLoading" class="ph">文档解析中…</div>
              <!-- A4 比例纸张视口：默认高度=宽度×297/210，保证一整页完整可见（不满足时至少 560px） -->
              <div v-else class="doc-page">
                <iframe v-if="curDoc.ext === 'pdf'" class="doc-frame" :src="fileUrl(curDoc.rel)"></iframe>
                <img v-else-if="isImage(curDoc.ext)" class="doc-img" :src="fileUrl(curDoc.rel)" :alt="curDoc.name">
                <pre v-else-if="docText" class="doc-text">{{ docText }}</pre>
                <div v-else-if="docHtml" class="doc-html" v-html="docHtml"></div>
                <div v-else-if="docError" class="doc-err">{{ docError }}</div>
              </div>
            </template>
            <div v-else class="ph">📄 文档预览区（PDF · Word · Excel · 图片 · TXT）<br><span style="font-size:12px">在左侧目录点击文档文件在此打开</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 注意力检测：播放中每隔 3-5 分钟在页面随机位置弹出 5 秒倒计时图标，点击确认消失；
         超时未点按规则扣减学时（首次扣一半、持续未点扣光本会话），扣减明细进「学时记账」流水 -->
    <div v-if="attnShow" class="attn" :style="{ left: attnX + 'px', top: attnY + 'px' }" @click="attnClick" title="点我确认还在学习">
      <span class="attn-eye">👀</span>
      <span class="attn-num">{{ attnLeft }}</span>
    </div>
  </div>
</template>

<script setup>
// 视频教学主面板：开始学习 → 大按钮选学年/学科 → 左目录树 + 右上媒体播放 + 右下文档预览。
// 进度口径：position=历史最大播放位置（算完成%）；watched=实际观看增量（算学时），15 秒一批上报。
// 学习会话：每打开一个文件 = 一次会话（/vstudy/session/*），开始页下方「历史学习列表」按会话展示明细。
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { api, rawUrl } from '../api';
import { localState, probeLocalBase, sameOriginBase } from '../utils/localBase';
import VsTreeNode from './VsTreeNode.vue';

const getToken = () => localStorage.getItem('wb_token') || '';
// 管理员（截图流水里才有「多选删除」与「全部用户」切换）——与 VideoCenterPanel 同一判据
const isAdmin = (() => { try { return (JSON.parse(localStorage.getItem('wb_user') || '{}') || {}).role === 'admin'; } catch { return false; } })();
const stage = ref('idle');            // idle → year → subject → browse
const cfg = ref({ root: '', root_ok: false, years: [], subjects: [] });
const year = ref('');
const subject = ref('');

// 历史学习列表（本人会话明细，分页）
const hist = ref({ page: 1, pageSize: 10, total: 0, sessions: [] });
const histLoading = ref(false);

const rootOpen = ref(false);
const rootEntries = ref([]);
const treeLoading = ref(false);
const treeError = ref('');

const videoEl = ref(null);
const curMedia = ref(null);          // { rel, name, ext }
const curDoc = ref(null);            // { rel, name, ext }
const docHtml = ref('');
const docText = ref('');
const docError = ref('');
const docLoading = ref(false);

let flvPlayer = null;
let flushTimer = null;
const mediaIssue = ref('');          // 播不了时的原因（真实容器/编码），空 = 正常
let docTimer = null;
let docWatched = 0;
let track = null;                    // { last, watched, maxPos, dur }
let beaconHandler = null;
let mediaSessionId = 0;              // 当前媒体文件的学习会话 id（进度累进 + 关闭时间盖章）
let docSessionId = 0;                // 当前文档的学习会话 id

const IMG_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp'];
const isImage = (e) => IMG_EXTS.includes(e);

// 视频学习检查开关 / 摄像头截图频率（来自 /vstudy/config）——检查关掉时摄像头也不开、不截图
const checkEnabled = computed(() => cfg.value.check_enabled !== false);
const camIntervalMin = computed(() => Math.max(1, Number(cfg.value.cam_interval_min) || 3));

// ---------- 本地直连（大文件走局域网） ----------
// 探测逻辑收拢到 utils/localBase.js：App 启动时已后台测过一遍（无论域名/IP 登录），
// 这里直接取共享结果，并跟随 wb-local-base 事件更新；缓存过期时补测也由模块统一去重。
const channel = ref('');            // 'local' | 'net' | ''（未配置本地地址）
let mediaBase = '';                 // 可达时的本地源前缀（如 http://192.168.1.50:21716）
function applyLocal() {
  const s = localState();
  mediaBase = s.base;
  channel.value = s.lan || s.ok ? 'local' : s.configured ? 'net' : '';
}
const onLocalEvt = () => applyLocal();

// mediaBase 为空（本就在内网）时兜底同源绝对前缀——外部播放器协议调起与「复制直链」必须拿到完整 URL
const fileUrl = (rel, download = false) =>
  `${mediaBase || sameOriginBase()}/api/vstudy/file?path=${encodeURIComponent(rel)}${download ? '&download=1' : ''}&token=${encodeURIComponent(getToken())}`;

provide('vstudySelectFile', (rel, entry) => {
  if (entry.kind === 'media') playMedia(rel, entry);
  else if (entry.kind === 'doc') openDoc(rel, entry);
});

async function loadCfg() {
  try { cfg.value = await api.get('/vstudy/config'); } catch { /* 设置读取失败不阻塞，开始按钮会被 root_ok 拦 */ }
}
function pickYear(y) { year.value = y; stage.value = 'subject'; }
function pickSubject(s) { subject.value = s; stage.value = 'browse'; startBrowse(); }
function restart() {
  stopAll();
  year.value = ''; subject.value = '';
  stage.value = 'year';
}

// ---------- 历史学习列表 ----------
async function loadHist(page = 1) {
  histLoading.value = true;
  try {
    hist.value = { ...hist.value, page, ...(await api.get(`/vstudy/sessions?page=${page}&pageSize=${hist.value.pageSize}`)) };
  } catch { hist.value = { ...hist.value, page, sessions: [], total: 0 }; }
  histLoading.value = false;
}
const dPart = (t) => String(t || '').slice(0, 10);   // 日期时间列：YYYY-MM-DD
const tPart = (t) => String(t || '').slice(11, 19);  // 开始/关闭时间列：HH:MM:SS
function fmtDur(s) {
  const v = Math.round(Number(s) || 0);
  if (v < 60) return `${v} 秒`;
  if (v < 3600) return `${Math.floor(v / 60)} 分 ${v % 60} 秒`;
  return `${(v / 3600).toFixed(1)} 小时`;
}
// 记录里的完整路径 → 相对当前学习目录的相对路径（根目录改过/对不上返回 null）
function relFromDisplay(full) {
  const root = (cfg.value.root || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  if (!root) return null;
  const f = String(full || '').replace(/\\/g, '/');
  if (f.toLowerCase() === root.toLowerCase()) return '';
  if (!f.toLowerCase().startsWith(root.toLowerCase() + '/')) return null;
  return f.slice(root.length + 1);
}
// 点击历史条目：回到学习页并自动打开该文件（学年/科目也按当时的记录带出）
function resumeSession(row) {
  const rel = relFromDisplay(row.path);
  if (rel === null) { alert('该记录的路径与当前学习目录对不上（目录可能已修改），请从目录树手动打开'); return; }
  year.value = row.school_year || cfg.value.years[0] || '';
  subject.value = row.subject || cfg.value.subjects[0] || '';
  stage.value = 'browse';
  startBrowse();
  nextTick(() => { // 等 browse 视图渲染出 video 元素再打开
    const name = rel.split('/').pop() || rel;
    const entry = { name, ext: row.ext || (name.split('.').pop() || '').toLowerCase(), kind: row.kind === 'doc' ? 'doc' : 'media' };
    if (entry.kind === 'doc') openDoc(rel, entry);
    else playMedia(rel, entry);
  });
}
// 回到开始页时刷新历史列表（新会话刚结账）
watch(stage, (s) => { if (s === 'idle') loadHist(1); });

// ---------- 学习会话 ----------
async function openSession(pathDisp, kind, ext) {
  try { return Number((await api.post('/vstudy/session/open', { path: pathDisp, kind, ext, school_year: year.value, subject: subject.value })).id) || 0; }
  catch { return 0; } // 会话建档失败不影响播放，只是这条不出现在历史列表
}
function closeSession(id) {
  if (!id) return;
  try { api.post('/vstudy/session/close', { id }); } catch { /* 尽力而为 */ }
}

// ---------- 目录树 ----------
async function toggleRoot() {
  rootOpen.value = !rootOpen.value;
  if (rootOpen.value && !rootEntries.value.length && !treeError.value) {
    treeLoading.value = true;
    try { rootEntries.value = (await api.get('/vstudy/tree')).entries || []; }
    catch (e) { treeError.value = e.message; }
    treeLoading.value = false;
  }
}
function startBrowse() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => { flushMedia(); flushDoc(); }, 15000);
  if (!rootOpen.value) toggleRoot();
  loadShots(1);   // 进浏览页即拉一次截图流水（管理员默认「全部用户」）
}

// ---------- 媒体播放（按**真实容器**选播放器，v1.13.7） ----------
// 扩展名不可信：生产实测「学习」目录里 46 个 .flv 全是 MP4（ftyp/isom/avc1）——交给 flv.js 必卡在「一直加载」，
// 因为 flv.js 只在字节流里找 'FLV\x01' 头，读到的却是 ftyp box。规则：
//   ① 服务器目录树带 box（真实容器魔数）→ 直接信它；
//   ② mp4/webm/mp3/ogg/wav/aac → <video>/<audio> 原生播；
//   ③ flv → 先探编码（H.265 / AV1 / High10 浏览器解不了）→ 能播才交 flv.js，否则明说请用外部播放器；
//   ④ mkv/avi/wmv/ts 等 → 浏览器一概解不了，直接提示外部播放器，不给用户留一个转圈的播放器。
const EXT_BOX_FE = { mp4: 'mp4', m4v: 'mp4', mov: 'mp4', flv: 'flv', webm: 'webm', mkv: 'mkv', mp3: 'mp3', m4a: 'mp4', wav: 'wav', aac: 'aac', ogg: 'ogg' };
const NATIVE_BOX = ['mp4', 'webm', 'mp3', 'ogg', 'wav', 'aac'];
const BOX_LABEL = { mkv: 'Matroska(MKV)', avi: 'AVI', wmv: 'WMV', ts: 'TS', mpeg: 'MPEG', mpg: 'MPEG', flac: 'FLAC', other: '未知格式' };
function boxOfEntry(entry) { return entry.box || EXT_BOX_FE[entry.ext] || String(entry.ext || '').toLowerCase(); }
// 探测真实容器 + 编码（找不到/出错时返回 null = 不拦，按扩展名继续）
async function boxProbe(rel) {
  try { return await api.get('/vstudy/probe?path=' + encodeURIComponent(rel)); } catch { return null; }
}
function issueText(info) {
  const c = (info && info.codec) || '';
  if (c === 'hevc') return '这个 FLV 里是 H.265（HEVC）编码，浏览器（含 flv.js 的 MSE 通道）解不了，请用下面的外部播放器。';
  if (c === 'av1') return '这个 FLV 里是 AV1 编码，浏览器 MSE 解不了，请用下面的外部播放器。';
  if (c === 'vp9') return '这个 FLV 里是 VP9 编码，flv.js 转不出来，请用下面的外部播放器。';
  if (info && info.profile > 100) return `这个 FLV 是 H.264，但档次是 High 10 / 4:2:2 / 4:4:4（profile ${info.profile}），浏览器解不了，请用下面的外部播放器。`;
  if (c === 'h263' || c === 'screen' || c === 'vp6') return `这个 FLV 用的是老编码（${c}），浏览器解不了，请用下面的外部播放器。`;
  return '浏览器解不了这个文件（编码不受支持），请用下面的外部播放器。';
}
function displayPath(rel) {
  const root = (cfg.value.root || '').replace(/[\\/]+$/, '');
  return root ? root + '\\' + rel : rel;
}
async function playMedia(rel, entry) {
  flushMedia(); // 结算上一个文件的进度
  destroyFlv();
  mediaIssue.value = '';
  let box = boxOfEntry(entry);
  curMedia.value = { rel, name: entry.name, ext: entry.ext, box };
  const url = fileUrl(rel);
  track = { last: 0, watched: 0, maxPos: 0, dur: 0 };
  mediaSessionId = 0;
  attnCancel();        // 换文件重置注意力检测（新文件播放开始会重新弹第一个）
  attnArmed = false;
  attnMissStreak = 0;
  attnNextAt = 0;
  openSession(displayPath(rel), 'media', entry.ext).then((id) => { mediaSessionId = id; }); // 新会话建档
  // 不是原生可播的容器（flv / mkv / avi…）先问服务端真实身份：树里带的 box 可信，
  // 但历史记录点进来没有 box，且扩展名可能说谎——不一致时以探测为准
  if (!NATIVE_BOX.includes(box)) {
    const info = await boxProbe(rel);
    if (info && info.box) { box = info.box; curMedia.value.box = box; }
    if (box === 'flv') {
      if (info && info.playable === false) { mediaIssue.value = issueText(info); return; }
    } else if (!NATIVE_BOX.includes(box)) {
      mediaIssue.value = `这个文件的真实容器是 ${BOX_LABEL[box] || box || '未知'}，浏览器不能直接播放，请用下面的外部播放器打开。`;
      return;
    }
  }
  if (box === 'flv') {
    try {
      const flvjs = (await import('flv.js')).default;
      if (!flvjs.isSupported()) throw new Error('当前浏览器不支持 FLV 播放，请用 Chrome/Edge，或用下面的外部播放器');
      // enableStashBuffer:false —— 关掉起播前置缓冲池，收到即喂给解码器，点开就播；
      // seekType:'range' 走 206 分段按需取，拖进度条不用等整段
      flvPlayer = flvjs.createPlayer({ type: 'flv', isLive: false, url },
        { enableStashBuffer: false, stashInitialSize: 128, seekType: 'range', lazyLoad: true });
      // flv.js 出错（编码不支持 / 网络中断）不再静默转圈，如实写到播放区
      flvPlayer.on(flvjs.Events.ERROR, (type, detail) => {
        if (!mediaIssue.value && curMedia.value) {
          mediaIssue.value = `FLV 播放失败（${type}${detail ? '：' + detail : ''}）。若是编码不受支持，请用下面的外部播放器。`;
        }
      });
      flvPlayer.attachMediaElement(videoEl.value);
      flvPlayer.load();
      videoEl.value.play().catch(() => {});
    } catch (e) { mediaIssue.value = e.message; }
  } else {
    videoEl.value.src = url;
    videoEl.value.play().catch(() => {});
  }
}
// <video> 原生报错（网络/解码/格式）：同样如实写出，别让用户对着转圈猜
function onVideoError() {
  const v = videoEl.value;
  if (!curMedia.value || mediaIssue.value || !v || !v.getAttribute('src')) return; // closeMedia 清 src 也会触发一次，忽略
  const c = v.error && v.error.code;
  mediaIssue.value = c === 2 ? '播放中读取中断（网络抖动或文件被移动）。'
    : c === 4 ? '浏览器不认这个文件的容器/编码，请用下面的外部播放器。'
      : '播放失败（解码错误），请用下面的外部播放器。';
}
function destroyFlv() {
  if (flvPlayer) { try { flvPlayer.destroy(); } catch { /* 已销毁 */ } flvPlayer = null; }
}
function closeMedia() {
  flushMedia();
  closeSession(mediaSessionId); // 会话盖章关闭时间
  mediaSessionId = 0;
  destroyFlv();
  stopCam();                    // 关闭视频 = 监控结束，摄像头一并关掉（v1.13.8）
  // videoEl 只在「浏览」分支渲染（v-else），从没进过浏览页就被卸载时它是 null：
  // 无条件解引用会抛 TypeError: Cannot read properties of null (reading 'removeAttribute')
  // （2026-10-02 生产 #/learning 切 tab 报错，栈顶 pn=closeMedia ← stopAll ← onBeforeUnmount）
  if (videoEl.value) {
    videoEl.value.removeAttribute('src');
    videoEl.value.load();
  }
  curMedia.value = null;
  mediaIssue.value = '';
  track = null;
  attnCancel();
  attnArmed = false;
}
// 外部播放器调起（v1.8.7）：浏览器 <video> 解不动 HEVC 10bit/4K，potplayer:// vlc:// 协议交给本地播放器硬解
function openExternal(proto) {
  if (!curMedia.value) return;
  try { flushMedia(); if (videoEl.value) videoEl.value.pause(); } catch { /* 忽略暂停失败 */ }
  window.location.href = proto + ':' + fileUrl(curMedia.value.rel);
}
async function copyMediaUrl() {
  if (!curMedia.value) return;
  const url = fileUrl(curMedia.value.rel);
  try { await navigator.clipboard.writeText(url); alert('直链已复制，可在 PotPlayer/VLC「打开网络串流」中粘贴'); }
  catch { prompt('复制以下直链：', url); }
}
function dlExtSetup() { api.download('/vstudy/extplayer', 'register-external-player.cmd').catch(() => {}); }
function onTimeUpdate() {
  const v = videoEl.value;
  if (!v || !track || !curMedia.value) return;
  const t = v.currentTime;
  if (!v.seeking && !v.paused) {
    const d = t - track.last;
    if (d > 0 && d <= 2.5) track.watched += d; // 跳进度/拖动条产生的巨大间隔不计入学时
  }
  track.last = t;
  track.maxPos = Math.max(track.maxPos, t);
  if (v.duration && isFinite(v.duration)) track.dur = v.duration;
  if (!v.paused && camState.value === 'off') startCam(); // 已在播但摄像头还没起（如自动播放未触发 play 事件）
  attnMaybeShow(); // 到达阈值（观看 3-5 分钟）弹出注意力检测
}

// ---------- 注意力检测 ----------
// 播放开始立即弹第一个；之后每观看 3-5 分钟（随机）在页面随机位置弹一个 5 秒倒计时图标。
// 点击确认 → 消失；5 秒未点 → 扣已进行学时的一半；连续未点 → 扣光本会话学时（ratio 0.5 / 1）。
const attnShow = ref(false);
const attnLeft = ref(5);
const attnX = ref(40);
const attnY = ref(40);
let attnTimer = null;      // 倒计时 interval
let attnNextAt = 0;        // track.watched 达到该阈值时弹下一个
let attnArmed = false;     // 本次播放是否已弹过「第一个」
let attnMissStreak = 0;    // 连续未点次数（点了就清零）

function attnSchedule() {
  // 下一个弹出点：再观看 3-5 分钟（随机）后的位置
  attnNextAt = (track ? track.watched : 0) + 180 + Math.random() * 120;
}
function onPlayStart() {
  startCam();            // 视频一开始播，本机摄像头同步开启（学习监控状态，v1.13.8）
  if (attnArmed || !track) return;
  attnArmed = true;      // 视频点击播放开始就弹出第一个提示
  attnMissStreak = 0;
  showAttn();
}
function attnMaybeShow() {
  if (!curMedia.value || !track || attnShow.value) return;
  if (track.watched >= attnNextAt) showAttn();
}
function showAttn() {
  // 设置页「视频学习检查」关闭时整个检测停用（不弹、不扣）——服务端 /vstudy/attention 同样兜底
  if (cfg.value.check_enabled === false) return;
  attnLeft.value = 5;
  // 随机位置：整个页面视口范围内（fixed 定位），避开边缘
  attnX.value = Math.round(12 + Math.random() * Math.max(20, window.innerWidth - 110));
  attnY.value = Math.round(12 + Math.random() * Math.max(20, window.innerHeight - 110));
  attnShow.value = true;
  if (attnTimer) clearInterval(attnTimer);
  attnTimer = setInterval(() => {
    attnLeft.value -= 1;
    if (attnLeft.value <= 0) { clearInterval(attnTimer); attnTimer = null; attnMiss(); }
  }, 1000);
}
function attnClick() {
  if (attnTimer) { clearInterval(attnTimer); attnTimer = null; }
  attnShow.value = false;
  attnMissStreak = 0;
  attnSchedule();
}
async function attnMiss() {
  attnShow.value = false;
  attnMissStreak += 1;
  const ratio = attnMissStreak >= 2 ? 1 : 0.5; // 首次未点扣一半；持续未点扣光本会话
  try { await api.post('/vstudy/attention', { session_id: mediaSessionId, ratio }); }
  catch { /* 网络失败本笔丢掉，流水由结算兜底 */ }
  attnSchedule();
}
function attnCancel() {
  if (attnTimer) { clearInterval(attnTimer); attnTimer = null; }
  attnShow.value = false;
}
function onEnded() { if (track && videoEl.value) { track.maxPos = Math.max(track.maxPos, videoEl.value.duration || track.maxPos); } flushMedia(); }

async function flushMedia() {
  if (!curMedia.value || !track) return;
  const body = {
    path: displayPath(curMedia.value.rel), kind: 'media', ext: curMedia.value.ext,
    school_year: year.value, subject: subject.value,
    duration_sec: Math.round(track.dur), position_sec: Math.round(track.maxPos),
    watched_sec: Math.round(track.watched), session_id: mediaSessionId,
  };
  track.watched = 0;
  if (body.watched_sec <= 0 && body.position_sec <= 0) return; // 无增量不写库
  try { await api.post('/vstudy/progress', body); } catch { /* 上报失败丢本批，下一批再补 */ }
}

// ---------- 文档预览 ----------
async function openDoc(rel, entry) {
  closeDoc(false);
  curDoc.value = { rel, name: entry.name, ext: entry.ext };
  docHtml.value = ''; docText.value = ''; docError.value = '';
  docWatched = 0;
  docSessionId = 0;
  openSession(displayPath(rel), 'doc', entry.ext).then((id) => { docSessionId = id; }); // 新会话建档
  docTimer = setInterval(() => { if (document.visibilityState === 'visible') docWatched += 30; }, 30000);
  // 打开即建档：文档类记录以「打开时间」为准，不等 30 秒心跳
  api.post('/vstudy/progress', { path: displayPath(rel), kind: 'doc', ext: entry.ext, school_year: year.value, subject: subject.value, watched_sec: 1 }).catch(() => {});
  const ext = entry.ext;
  if (!(['pdf'].includes(ext) || IMG_EXTS.includes(ext))) {
    docLoading.value = true;
    try {
      const buf = await (await fetch(fileUrl(rel), { headers: { Authorization: 'Bearer ' + getToken() } })).arrayBuffer();
      if (ext === 'txt' || ext === 'md' || ext === 'csv') {
        docText.value = new TextDecoder('utf-8').decode(buf);
      } else if (ext === 'docx') {
        const mammoth = (await import('mammoth')).default;
        docHtml.value = (await mammoth.convertToHtml({ arrayBuffer: buf })).value;
      } else if (ext === 'xls' || ext === 'xlsx') {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf);
        docHtml.value = XLSX.utils.sheet_to_html(wb.Sheets[wb.SheetNames[0]]);
      } else if (ext === 'doc') {
        docError.value = '老版 .doc 格式暂不支持在线预览，请下载后查看，或另存为 .docx';
      }
    } catch (e) { docError.value = '文档打开失败：' + e.message; }
    docLoading.value = false;
  }
}
function closeDoc(flush = true) {
  if (flush) flushDoc();
  closeSession(docSessionId); // 会话盖章关闭时间
  docSessionId = 0;
  if (docTimer) { clearInterval(docTimer); docTimer = null; }
  curDoc.value = null; docHtml.value = ''; docText.value = ''; docError.value = '';
}
async function flushDoc() {
  if (!curDoc.value || docWatched <= 0) return;
  const body = {
    path: displayPath(curDoc.value.rel), kind: 'doc', ext: curDoc.value.ext,
    school_year: year.value, subject: subject.value,
    watched_sec: docWatched, session_id: docSessionId,
  };
  docWatched = 0;
  try { await api.post('/vstudy/progress', body); } catch { /* 失败丢本批 */ }
}

// ---------- 学习监控状态（v1.13.8） ----------
// 用户需求（2026-10-11）：视频播放画面右侧开一个小窗，视频一开播本机摄像头同步开启（320 分辨率、约主画面 1/4）；
// 窗下是「截图流水」表：每 N 分钟（设置页可改，默认 3）截一张本机画面存到服务器，显示历史截图路径；
// 管理员可多选删除；流水表默认 10 行/页（可选 5/10/15/30/50/100）带前后翻页。
const camEl = ref(null);
const camState = ref('off');        // off | starting | on | denied | error
const camMsg = ref('');
let camStream = null;
let camTimer = null;                // 下一次截图（setTimeout 链，每次按最新频率重排）

const SHOT_SIZES = [5, 10, 15, 30, 50, 100];
const shotSize = ref(10);
const shotUid = ref(isAdmin ? 'all' : 'me');   // 管理员默认看全部用户（家长看孩子的学习监控）
const shotSel = ref([]);
const shots = ref({ page: 1, pageSize: 10, total: 0, rows: [], users: [], scope: isAdmin ? 'all' : 'me' });
const shotsLoading = ref(false);
const shotPages = computed(() => Math.max(1, Math.ceil((shots.value.total || 0) / (shots.value.pageSize || 10))));
const allSel = computed(() => shots.value.rows.length > 0 && shotSel.value.length === shots.value.rows.length);

// 截图周期：默认按设置里的分钟数；`?cam_sec=N` 可临时改成 N 秒（自动化验证「截图→落盘→流水表」整条链路用）
function camPeriodMs() {
  const s = Number(new URLSearchParams(location.search).get('cam_sec'));
  if (Number.isFinite(s) && s > 0) return s * 1000;
  return camIntervalMin.value * 60000;
}
async function startCam() {
  if (camState.value === 'on' || camState.value === 'starting') return;
  if (!checkEnabled.value) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    camState.value = 'error';
    camMsg.value = '当前浏览器不支持摄像头（需 Chrome/Edge 等现代浏览器，且页面必须是 https 或 localhost）。';
    return;
  }
  camState.value = 'starting'; camMsg.value = '';
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 } }, audio: false });
    if (camEl.value) { camEl.value.srcObject = camStream; camEl.value.play().catch(() => {}); }
    camState.value = 'on';
    scheduleShot();
  } catch (e) {
    const n = (e && e.name) || '';
    camState.value = n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : 'error';
    camMsg.value = camState.value === 'denied'
      ? '浏览器未授权使用摄像头：点地址栏的摄像头图标允许访问，再点一次播放即可开启。'
      : `摄像头开启失败（${n || (e && e.message) || '未知原因'}）：可能被其它程序占用或本机没有摄像头。`;
  }
}
function stopCam() {
  if (camTimer) { clearTimeout(camTimer); camTimer = null; }
  if (camStream) { try { camStream.getTracks().forEach((t) => t.stop()); } catch { /* 尽力 */ } camStream = null; }
  if (camEl.value) { try { camEl.value.srcObject = null; } catch { /* 尽力 */ } }
  camState.value = 'off';
}
function scheduleShot() {
  if (camTimer) clearTimeout(camTimer);
  camTimer = setTimeout(camTick, camPeriodMs());
}
async function camTick() {
  camTimer = null;
  try { await shotOnce(); } catch { /* 单次截图失败不打断播放，下一周期再试 */ }
  if (camState.value === 'on') scheduleShot();
}
// 抓一帧本机摄像头画面 → JPEG → POST 给服务端落盘（文件名由服务端按「日期时间_视频名」生成）
async function shotOnce() {
  const v = videoEl.value, c = camEl.value;
  if (!checkEnabled.value || !curMedia.value || !c || !c.videoWidth) return;
  if (!v || v.paused) return;      // 视频没在播就不截（暂停期间不产生无效画面）
  const cv = document.createElement('canvas');
  cv.width = 320; cv.height = 240;   // 分辨率只要 320
  cv.getContext('2d').drawImage(c, 0, 0, 320, 240);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.72));
  if (!blob) return;
  // 走 rawUrl：自动补 fnOS 网关前缀 + ?token=（这条通道不发 Authorization 头，与其它二进制上传一致）
  const res = await fetch(rawUrl(`/api/vstudy/cam?video=${encodeURIComponent(curMedia.value.name)}`), {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob,
  });
  if (!res.ok) throw new Error('截图上传失败：HTTP ' + res.status);
  loadShots(1);                    // 新截图立刻出现在流水表最上面
}
function camUrl(file) {
  return `${sameOriginBase()}/api/vstudy/cam/file/${encodeURIComponent(file)}?token=${encodeURIComponent(getToken())}`;
}
function viewShot(row) { window.open(camUrl(row.file), '_blank'); }
function toggleAll(e) { shotSel.value = e.target.checked ? shots.value.rows.map((r) => r.id) : []; }
async function loadShots(page = shots.value.page) {
  shotsLoading.value = true;
  try {
    const uid = isAdmin ? shotUid.value : 'me';
    const d = await api.get(`/vstudy/cam/list?page=${page}&pageSize=${shotSize.value}&uid=${encodeURIComponent(uid)}`);
    shots.value = { ...shots.value, ...d };
    shotSel.value = [];
  } catch {
    shots.value = { ...shots.value, page, total: 0, rows: [] };  // 读不到就清空，别留旧数据误导
    shotSel.value = [];
  }
  shotsLoading.value = false;
}
async function delShots() {
  const ids = [...shotSel.value];
  if (!ids.length) return;
  if (!window.confirm(`确定删除选中的 ${ids.length} 张监控截图吗？服务器上的图片文件会一并删除，且不可恢复。`)) return;
  try {
    const r = await api.post('/vstudy/cam/delete', { ids });
    loadShots(shots.value.total - ids.length <= (shots.value.page - 1) * shotSize.value ? Math.max(1, shots.value.page - 1) : shots.value.page);
    return r;
  } catch (e) { alert('删除失败：' + e.message); }
}

// ---------- 收尾 ----------
function stopAll() {
  flushMedia(); flushDoc();
  closeMedia();
  closeDoc(false);
  attnCancel();
  stopCam();
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}
onMounted(() => {
  loadCfg();
  loadHist(1);
  // 本地直连：App 启动已探测过，这里取共享结果；缓存过期时补测（模块内单飞去重）
  applyLocal();
  window.addEventListener('wb-local-base', onLocalEvt);
  probeLocalBase();
  // 页面被关闭/刷新时用 sendBeacon 补最后一笔（无法带 Authorization 头，走 ?token=）
  beaconHandler = () => {
    const bodies = [];
    if (curMedia.value && track && (track.watched > 0 || track.maxPos > 0)) {
      bodies.push({ path: displayPath(curMedia.value.rel), kind: 'media', ext: curMedia.value.ext, school_year: year.value, subject: subject.value, duration_sec: Math.round(track.dur), position_sec: Math.round(track.maxPos), watched_sec: Math.round(track.watched), session_id: mediaSessionId });
    }
    if (curDoc.value && docWatched > 0) {
      bodies.push({ path: displayPath(curDoc.value.rel), kind: 'doc', ext: curDoc.value.ext, school_year: year.value, subject: subject.value, watched_sec: docWatched, session_id: docSessionId });
    }
    for (const b of bodies) {
      try { navigator.sendBeacon(`/api/vstudy/progress?token=${encodeURIComponent(getToken())}`, new Blob([JSON.stringify(b)], { type: 'application/json' })); } catch { /* 尽力而为 */ }
    }
    // 未结账的会话补盖章（无增量的会话 ended_at 仍为 NULL，会一直显示「进行中」）
    for (const sid of [mediaSessionId, docSessionId]) {
      if (sid) {
        try { navigator.sendBeacon(`/api/vstudy/session/close?token=${encodeURIComponent(getToken())}`, new Blob([JSON.stringify({ id: sid })], { type: 'application/json' })); } catch { /* 尽力而为 */ }
      }
    }
  };
  window.addEventListener('beforeunload', beaconHandler);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beaconHandler);
  window.removeEventListener('wb-local-base', onLocalEvt);
  stopAll();
});
</script>

<style scoped>
.idle { text-align: center; padding: 60px 20px; }
.big-start { font-size: 20px; padding: 20px 64px; border: none; border-radius: 12px; background: var(--accent); color: #fff; cursor: pointer; }
.big-start:hover { filter: brightness(1.08); }
.big-start:disabled { opacity: .5; cursor: default; }
.warnbox { margin-top: 14px; font-size: 13px; color: var(--red); }
/* 历史学习列表（开始学习按钮下方） */
.hist { margin-top: 12px; padding: 16px 18px; }
.hist h3 { margin-bottom: 10px; }
.hist-wrap { overflow-x: auto; }
.hist-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.hist-tbl th { text-align: left; font-weight: 500; color: var(--text3); padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.hist-tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.hist-row { cursor: pointer; }
.hist-row:hover td { background: var(--bg3); }
.hist-path { max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
.hist-foot { margin-top: 10px; align-items: center; gap: 8px; }
.pick { padding: 26px; }
.pick h3 { margin-bottom: 18px; }
.big-grid { display: flex; flex-wrap: wrap; gap: 14px; min-height: 120px; } /* 大按钮流式排布，学年/学科增多自动换行 */
.big-btn { min-width: 180px; padding: 26px 22px; font-size: 17px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; transition: all .15s; }
.big-btn:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-2px); }
.pick-foot { display: flex; align-items: center; gap: 12px; margin-top: 20px; }
.vs-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.vs-head .cur { font-size: 14.5px; font-weight: 600; }
.lb { margin-left: auto; font-size: 11.5px; padding: 2px 10px; border-radius: 10px; border: 1px solid var(--border); color: var(--text3); }
.lb.ok { color: var(--green); border-color: var(--green); }
.vs-body { display: flex; gap: 12px; align-items: stretch; }
.tree { width: 25%; min-width: 230px; max-height: 72vh; overflow: auto; padding: 10px; }
.tree-root { font-weight: 600; padding: 5px 6px; cursor: pointer; border-radius: 6px; }
.tree-root:hover { background: var(--bg3); }
.tree-children { margin-left: 6px; }
.vs-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.zone { display: flex; flex-direction: column; }
.zone-head { display: flex; align-items: center; gap: 10px; font-size: 13.5px; margin-bottom: 8px; }
.zone-head .grow { flex: 1; }
.zone-body { display: flex; gap: 12px; align-items: flex-start; }
.player-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.player-col video { width: 100%; max-height: 46vh; background: #000; border-radius: 8px; }
/* 学习监控状态（v1.13.8）：播放画面右侧的小窗，宽度固定 320（= 截图分辨率，约主画面 1/4） */
.monitor { flex: 0 0 320px; width: 320px; display: flex; flex-direction: column; gap: 8px; }
.mon-title { font-size: 13.5px; font-weight: 600; }
.cam-box { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #111; border-radius: 8px; overflow: hidden; }
.cam { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); } /* 镜像：像照镜子，符合直觉 */
.cam.hide { visibility: hidden; }
.cam-cover { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 10px; text-align: center; background: var(--bg3); }
.cam-ph { font-size: 13px; color: var(--text3); }
.cam-msg { font-size: 11.5px; color: var(--red); line-height: 1.6; }
.cam-hint { font-size: 11.5px; color: var(--text3); line-height: 1.7; }
.cam-hint b { color: var(--text2); }
/* 截图流水：全宽表格（在播放区下方，管理员多选删除 + 前后翻页） */
.shots { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
.shots-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.shots-head .grow { flex: 1; }
.mini { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12.5px; }
.small.del { color: var(--red); border-color: var(--red); }
.small.del:disabled { color: var(--text3); border-color: var(--border); cursor: default; }
.shots-wrap { overflow-x: auto; }
.shot-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.shot-tbl th { text-align: left; font-weight: 500; color: var(--text3); padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.shot-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.shot-tbl th.ck, .shot-tbl td.ck { width: 28px; }
.shot-tbl td.el { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.shot-tbl td.none { color: var(--text3); text-align: center; padding: 16px; white-space: normal; }
.shot-tbl th.op, .shot-tbl td.op { width: 48px; }
.shot-tbl td.op a { color: var(--accent); }
.shots-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.shots-foot button:disabled { opacity: .45; cursor: default; }
@media (max-width: 1100px) { .zone-body { flex-wrap: wrap; } .monitor { flex: 1 1 100%; width: 100%; max-width: 420px; } }
/* 外部播放器按钮行（v1.8.7）：HEVC 10bit/4K 交给本地播放器 */
.ext-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 0 2px; }
.ext-row .ext-tip { font-size: 12px; }
.ext-tip a { color: var(--accent); }
.doc-zone { flex: 1; min-height: 220px; }
.ph { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text3); font-size: 14px; min-height: 160px; text-align: center; }
.ph.err { color: var(--red); white-space: pre-wrap; }
/* 播不了时的原因块（真实容器/编码不受支持）——替代原来那个转不完的加载圈 */
.media-issue { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 160px; padding: 16px; text-align: center; background: var(--bg3); border: 1px dashed var(--border); border-radius: 10px; }
.media-issue b { color: var(--amber); font-size: 14px; }
.media-issue span { color: var(--text2); font-size: 13px; max-width: 620px; line-height: 1.7; }
.media-issue span.muted { color: var(--text3); font-size: 12px; }
/* A4 纸张视口：高度=宽度×(297/210)≈1.414，一整页默认完整可见；窄窗口时至少 560px */
.doc-page { width: 100%; aspect-ratio: 210 / 297; min-height: 560px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
.doc-frame { flex: 1; width: 100%; border: none; background: #fff; }
.doc-img { flex: 1; width: 100%; height: 100%; object-fit: contain; }
.doc-text { flex: 1; overflow: auto; margin: 0; padding: 16px 20px; white-space: pre-wrap; word-break: break-all; font-size: 13.5px; line-height: 1.8; color: #222; }
.doc-html { flex: 1; overflow: auto; padding: 16px 20px; font-size: 13.5px; line-height: 1.8; color: #222; }
.doc-err { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--red); font-size: 13.5px; text-align: center; padding: 20px; white-space: pre-wrap; }
.doc-html :deep(table) { border-collapse: collapse; }
.doc-html :deep(td), .doc-html :deep(th) { border: 1px solid var(--border); padding: 4px 8px; font-size: 12.5px; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; text-decoration: none; }
/* 注意力检测图标：fixed 定位随机出现，5 秒倒计时，点击确认 */
.attn { position: fixed; z-index: 9999; width: 86px; height: 86px; border-radius: 50%;
  background: rgba(229, 72, 77, .94); color: #fff; display: flex; flex-direction: column;
  align-items: center; justify-content: center; cursor: pointer; user-select: none;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .35); animation: attnPulse 1s infinite; }
.attn-eye { font-size: 26px; line-height: 1; }
.attn-num { font-size: 17px; font-weight: 700; margin-top: 2px; }
@keyframes attnPulse { 50% { transform: scale(1.1); } }
.dl { color: var(--accent); }
.grow { flex: 1; }
.muted { color: var(--text3); }
.ld { padding: 3px 6px; font-size: 12px; }
.ld.err { color: var(--red); }
</style>
