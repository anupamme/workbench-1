// 音乐中心路由（v1.16.0）：/mc 前缀，全部要登录（页 smarthome · tab music，auth.js 双处已挂）。
// 模板照 vstudyRoutes（目录树/Range 流播）；差别：
//  · 根目录存「短路径」（/音乐），resolveRoot 自动试 /vol2/1000、/vol1/1000 前缀——用户 NAS 音乐在
//    /vol2/1000/音乐，但界面上只想填 /音乐（2026-10-13 需求原话）。
//  · 曲库先扫进主库 mc_tracks（家庭共享），列表/树/统计都查库不直读磁盘；首次访问库空时自动扫一遍。
//  · 收藏 mc_favorites 按 user_id+track_id；歌词走 LRCLIB（免费无 Key），结果缓存进 mc_tracks。
// v1.17.0 增量：封面刮削（渠道测试/勾选/后台任务）+ 悬浮桌面歌词（正在播放上报 / agent poll
// （EXEMPT，key 即凭证）/ 设备管理 / 安装包下载）。除 /mc/agent/poll 外全部仍走登录闸。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('../db');
const { AUDIO_MIME } = require('../lib/audioMeta');
const svc = require('../services/mcService');
const agent = require('../services/mcLyricsAgent');

const router = express.Router();
const isAdmin = (req) => !!req.user && req.user.role === 'admin';

// 相对路径安全拼进根目录（越界/未配置返回 null）——曲库行里的 path 一律是根内相对路径
function resolveInRoot(rel) {
  const { root } = svc.resolveRoot(svc.mcRootSetting());
  if (!root) return null;
  const full = path.resolve(root, '.' + path.sep + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  const normRoot = path.resolve(root) + path.sep;
  if (full !== path.resolve(root) && !full.startsWith(normRoot)) return null;
  return full;
}

// 代理安装包回连地址：Origin → Referer 根 → external_base_url 设置 → x-forwarded-proto + host
// （照桌面通知代理的探测顺序；从哪儿下载就嵌哪儿的地址——内网下载嵌内网、公网下载嵌公网）
function baseUrl(req) {
  const o = String(req.headers.origin || '').trim();
  if (/^https?:\/\//i.test(o)) return o.replace(/\/+$/, '');
  const ref = String(req.headers.referer || '').trim();
  const m = /^https?:\/\/[^\/\s]+/i.exec(ref);
  if (m) return m[0].replace(/\/+$/, '');
  const ext = String(getSetting(db, 'external_base_url', '') || '').trim();
  if (/^https?:\/\//i.test(ext)) return ext.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return (proto + '://' + (req.headers.host || 'localhost')).replace(/\/+$/, '');
}
function trackById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.prepare('SELECT * FROM mc_tracks WHERE id=?').get(n) || null;
}

// ---------- 配置：根路径（短路径）+ 海报（封面） + 歌词 API + 统计卡片数字 ----------
function configPayload(req) {
  const r = svc.resolveRoot(svc.mcRootSetting());
  return {
    root: r.input, root_ok: !!r.root, resolved: r.root || '', matched_base: r.matched || '',
    stats: svc.stats(), scanned_at: Number(getSetting(db, 'mc_scanned_at', 0)) || 0,
    // 音乐海报（v1.16.1）：封面来源与全屏海报背景
    poster: {
      cover_names: String(getSetting(db, 'mc_cover_names', '') || ''),
      cover_names_default: svc.DEFAULT_COVER_NAMES.join(', '),
      cover_priority: svc.coverPrioritySetting(),
      full_bg: svc.fullBgSetting(),
    },
    // 歌词 API（v1.16.1）：基址 + 来源（default/env/setting，如实在设置页说明）+ 已缓存条数
    lyrics: {
      api: svc.lyricsApiSetting(),
      api_custom: String(getSetting(db, 'mc_lyrics_api', '') || ''),
      api_default: svc.DEFAULT_LYRICS_API,
      api_source: svc.lyricsApiSource(),
      cached: svc.lyricsCachedCount(),
    },
    // 封面刮削（v1.17.0；v1.17.1 五渠道+地址可配）：渠道清单 + 勾选状态 + 库存计数（设置页渠道卡的原料）
    // url=用户自定义地址（空=默认）；effective=归一后实际会请求的端点；rec=推荐地址（引导粘贴）；itunes 按要求保留现有模式不出输入框
    scrape: {
      channels: svc.SCRAPE_CHANNELS.map((c) => ({
        id: c.id, name: c.name, desc: c.desc, no_url: !!c.noUrl,
        url: c.noUrl ? '' : String(svc.scrapeUrlMap()[c.id] || ''),
        effective: svc.scrapeEndpoint(c.id),
        rec: c.noUrl ? '' : c.def,
      })),
      on: svc.scrapeOnList(),
      ...svc.scrapeStatus(),
    },
    // 悬浮歌词（v1.17.0）：全局开关 + 字体设置 + 安装包字体在位 + key 是否已生成
    desk: {
      on: agent.deskOn(),
      font_family: agent.fontFamilySetting(),
      font_size: agent.fontSizeSetting(),
      font_opacity: agent.fontOpacitySetting(),
      local_sound: agent.localSoundSetting(),
      font_options: agent.FONT_OPTIONS,
      font_included: !!agent.bundledFont(),
      agent_key_set: /^[0-9a-f]{32}$/.test(String(getSetting(db, 'mc_agent_key', '') || '')),
    },
    is_admin: isAdmin(req),
  };
}
router.get('/mc/config', (req, res) => res.json(configPayload(req)));

// 保存设置（管理员）：只处理请求体里出现的键——root / cover_names / cover_priority / full_bg / lyrics_api
// root 仍走「先按候选前缀试真目录，试不到 400 并如实列出试过的路径」的老规矩
router.post('/mc/settings', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可修改' });
  const b = req.body || {};
  const applied = [];
  // v1.17.1 刮削渠道地址表：先验后写（root 等键写库在前，这里校验失败要能整体拒绝，不能落半套）
  let urlsPatch = null;
  if (Object.prototype.hasOwnProperty.call(b, 'scrape_urls')) {
    const validIds = new Set(svc.SCRAPE_CHANNELS.filter((c) => !c.noUrl).map((c) => c.id));
    const inb = (b.scrape_urls && typeof b.scrape_urls === 'object' && !Array.isArray(b.scrape_urls)) ? b.scrape_urls : {};
    const out = {};
    for (const id of validIds) {
      const v = String(inb[id] || '').trim().slice(0, 300);
      if (v && !/^https?:\/\//i.test(v)) {
        return res.status(400).json({ error: `渠道「${id}」的地址要以 http:// 或 https:// 开头（当前填的是 ${v.slice(0, 60)}）` });
      }
      out[id] = v; // 空串=用默认地址
    }
    urlsPatch = out;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'root')) {
    const raw = String(b.root || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (raw) {
      const r = svc.resolveRoot(raw);
      if (!r.root) {
        return res.status(400).json({
          error: `目录不存在或不可访问：${r.input}。已自动尝试 ${r.input}、/vol2/1000${r.input}、/vol1/1000${r.input} 都没找到。`
            + 'NAS Docker 部署时音乐目录需先映射进容器（工作台这边只需填 /音乐 这类短路径，会自动试 /vol2/1000 与 /vol1/1000 前缀）；Windows 直跑请填本机真实路径（如 D:\\音乐）。',
        });
      }
      setSetting(db, 'mc_root', r.input);
      applied.push('root');
    } else {
      setSetting(db, 'mc_root', '');
      applied.push('root');
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'cover_names')) {
    setSetting(db, 'mc_cover_names', String(b.cover_names || '').trim().slice(0, 800));
    applied.push('cover_names');
  }
  if (Object.prototype.hasOwnProperty.call(b, 'cover_priority')) {
    setSetting(db, 'mc_cover_priority', b.cover_priority === 'dir' ? 'dir' : 'embed');
    applied.push('cover_priority');
  }
  if (Object.prototype.hasOwnProperty.call(b, 'full_bg')) {
    setSetting(db, 'mc_full_bg', b.full_bg === 'dark' ? 'dark' : 'color');
    applied.push('full_bg');
  }
  if (Object.prototype.hasOwnProperty.call(b, 'lyrics_api')) {
    const api = String(b.lyrics_api || '').trim().replace(/\/+$/, '');
    if (api && !/^https?:\/\//i.test(api)) {
      return res.status(400).json({ error: '歌词 API 地址要以 http:// 或 https:// 开头' });
    }
    setSetting(db, 'mc_lyrics_api', api.slice(0, 300));
    applied.push('lyrics_api');
  }
  // v1.17.0 四个新键：刮削渠道勾选（数组，勾选顺序=刮削优先级）+ 悬浮歌词开关/字体/字号
  if (Object.prototype.hasOwnProperty.call(b, 'scrape_on')) {
    const valid = new Set(svc.SCRAPE_CHANNELS.map((c) => c.id));
    setSetting(db, 'mc_scrape_on', Array.isArray(b.scrape_on) ? b.scrape_on.filter((x) => valid.has(x)) : []);
    applied.push('scrape_on');
  }
  if (urlsPatch) {
    setSetting(db, 'mc_scrape_urls', { ...svc.scrapeUrlMap(), ...urlsPatch });
    applied.push('scrape_urls');
  }
  if (Object.prototype.hasOwnProperty.call(b, 'desk_on')) { agent.setDeskOn(!!b.desk_on); applied.push('desk_on'); }
  if (Object.prototype.hasOwnProperty.call(b, 'font_family')) { agent.setFontFamily(b.font_family); applied.push('font_family'); }
  if (Object.prototype.hasOwnProperty.call(b, 'font_size')) { agent.setFontSize(b.font_size); applied.push('font_size'); }
  if (Object.prototype.hasOwnProperty.call(b, 'font_opacity')) { agent.setFontOpacity(b.font_opacity); applied.push('font_opacity'); }
  // v1.18.7：本机声音门控（默认开）——关掉即退回「服务端说有播放就显示」的老行为
  if (Object.prototype.hasOwnProperty.call(b, 'local_sound')) { agent.setLocalSound(!!b.local_sound); applied.push('local_sound'); }
  res.json({ ok: true, applied, ...configPayload(req) });
});

// 探歌词服务（管理员）：设置页「测连通」按钮用。服务端代探——容器连不上，浏览器连得上也没用
router.post('/mc/lyrics/test', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可测试' });
  const api = String((req.body || {}).api || '').trim();
  res.json(await svc.testLyricsApi(api));
});

// 清空歌词缓存（管理员）：改了地址或想重挑歌词时用；下次播到那首会重新联网匹配
router.post('/mc/lyrics/clear', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可操作' });
  const r = svc.clearLyricsCache();
  res.json({ ...r, cached: svc.lyricsCachedCount() });
});

// ---------- 扫描（管理员手动触发；库空时 GET 也会自动扫一遍） ----------
router.post('/mc/scan', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可扫描' });
  const r = svc.scanLibrary();
  if (r.ok) setSetting(db, 'mc_scanned_at', String(Date.now()));
  res.status(r.ok ? 200 : 400).json(r);
});
function ensureScanned() {
  // 惰性首扫：根目录配好 + 从没扫过 → 扫一遍（管理员没点按钮也能直接看到歌）
  if (!svc.resolveRoot(svc.mcRootSetting()).root) return;
  if (Number(getSetting(db, 'mc_scanned_at', 0)) || 0) return;
  const r = svc.scanLibrary();
  if (r.ok) setSetting(db, 'mc_scanned_at', String(Date.now()));
}

// ---------- 目录树（懒加载一层，照视频中心；回目录 + 音频文件 + VsTreeNode 可直接吃的 entries） ----------
router.get('/mc/tree', (req, res) => {
  const rel = String(req.query.dir || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = resolveInRoot(rel);
  if (!full) return res.status(400).json({ error: svc.mcRootSetting() ? '路径越界' : '尚未配置音乐目录，请先点音乐页右上角「设置」填写音乐路径' });
  let names;
  try { names = fs.readdirSync(full); } catch { return res.status(400).json({ error: '读取目录失败（目录不存在或无权限）' }); }
  const dirs = [], files = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, 'zh'))) {
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    const abs = path.join(full, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const rp = rel ? rel + '/' + name : name;
    if (st.isDirectory()) dirs.push({ name, path: rp });
    else {
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (svc.AUDIO_EXTS.includes(ext)) files.push({ name, path: rp });
    }
  }
  // entries = 前端目录树组件（VsTreeNode）直接可用的形状：音乐面板的树只列目录（歌曲走右侧 /mc/library）
  const entries = dirs.map((d) => ({ name: d.name, is_dir: true, kind: 'dir' }));
  res.json({ dir: rel, dirs, files, entries });
});

// ---------- 曲库：某目录内的歌曲（不递归，元数据来自 mc_tracks；带当前用户收藏标记） ----------
router.get('/mc/library', (req, res) => {
  ensureScanned();
  const rel = String(req.query.dir || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const root = svc.resolveRoot(svc.mcRootSetting()).root;
  if (!root) return res.status(400).json({ error: '尚未配置音乐目录，请先点音乐页右上角「设置」填写音乐路径' });
  // v1.18.6：?all=1 = 整个曲库一次给全（首页看板音乐卡片的「全部曲库」播放列表用）。
  // 几千首时这条回 ~150KB——前端只在用户真切到「全部曲库」时懒拉一次，不进启动路径。
  if (req.query.all === '1') {
    const all = db.prepare(`SELECT t.id, t.path, t.title, t.artist, t.album, t.duration_ms, t.has_cover,
        (SELECT COUNT(*) FROM mc_favorites f WHERE f.track_id=t.id) AS fav_count
      FROM mc_tracks t ORDER BY t.path COLLATE NOCASE`).all().map((r) => ({
      ...r,
      fav: !!db.prepare('SELECT 1 FROM mc_favorites WHERE user_id=? AND track_id=?').get(req.user.id, r.id),
    }));
    return res.json({ dir: '', tracks: all, subdirs: [] });
  }
  const esc = rel.replace(/\\/g, '/');
  const dirPrefix = esc ? esc + '/' : '';
  // 「该目录直属的歌曲」= path 的最后一段不带斜杠（用 length 一次性算好，别在 SQL 里做字符串运算）
  const rows = db.prepare(`SELECT t.id, t.path, t.title, t.artist, t.album, t.duration_ms, t.has_cover,
      (SELECT COUNT(*) FROM mc_favorites f WHERE f.track_id=t.id) AS fav_count
    FROM mc_tracks t WHERE substr(t.path, 1, ?) = ? AND instr(substr(t.path, ? + 1), '/') = 0
    ORDER BY t.path COLLATE NOCASE`).all(dirPrefix.length, dirPrefix, dirPrefix.length).map((r) => ({
    ...r,
    fav: !!db.prepare('SELECT 1 FROM mc_favorites WHERE user_id=? AND track_id=?').get(req.user.id, r.id),
  }));
  const subdirs = db.prepare(`SELECT substr(path, ? + 1, instr(substr(path, ? + 1) || '/', '/') - 1) AS d
    FROM mc_tracks WHERE substr(path, 1, ?) = ? AND instr(substr(path, ? + 1), '/') > 0
    GROUP BY d ORDER BY d COLLATE NOCASE`).all(dirPrefix.length, dirPrefix.length, dirPrefix.length, dirPrefix, dirPrefix.length)
    .map((r) => ({ name: r.d, path: rel ? rel + '/' + r.d : r.d }));
  res.json({ dir: rel, tracks: rows, subdirs });
});

// ---------- 歌手 / 专辑视图（v1.16.7）----------
// 需求原话：「左侧全部音乐的目录，再加一个切换按钮，切换为歌手显示。左侧根据歌手显示右侧的专辑」。
// **不建新表**：扫描时 mc_tracks 就落了 artist/album（ID3/VorbisComment/ilst + 文件名兜底），
// 聚合直接 GROUP BY 即可——另立一张歌手/专辑表反而要在每次「重新扫描」后同步，多一处会对不上的真相。
// 分类口径与「未匹配封面」那条统计一致：artist='' 的归「未知歌手」，album='' 的归「未知专辑」。
// 一首歌的展示字段（列表/收藏/专辑内歌曲共用一套形状，前端卡片不必分叉）
function trackRows(whereSql, args, uid) {
  return db.prepare(`SELECT t.id, t.path, t.title, t.artist, t.album, t.duration_ms, t.has_cover
    FROM mc_tracks t ${whereSql}`).all(...args)
    .map((r) => ({ ...r, fav: !!db.prepare('SELECT 1 FROM mc_favorites WHERE user_id=? AND track_id=?').get(uid, r.id) }));
}
// 左侧「歌手」栏 + 右侧「该歌手的专辑」一次全给：只回聚合行（不含歌曲行），几百个歌手也就几十 KB
router.get('/mc/artists', (req, res) => {
  ensureScanned();
  const artists = db.prepare(`SELECT artist, COUNT(*) AS tracks,
      (SELECT MIN(id) FROM mc_tracks x WHERE x.artist=t.artist AND x.has_cover>0) AS cover_id
    FROM mc_tracks t GROUP BY artist`).all();
  const albums = db.prepare(`SELECT artist, album, COUNT(*) AS tracks,
      SUM(duration_ms) AS duration_ms,
      MIN(CASE WHEN has_cover>0 THEN id END) AS cover_id
    FROM mc_tracks GROUP BY artist, album`).all();
  const byArtist = new Map();
  for (const a of artists) byArtist.set(a.artist, { name: a.artist, tracks: a.tracks, cover_id: a.cover_id || 0, albums: [] });
  for (const al of albums) {
    const box = byArtist.get(al.artist);
    if (!box) continue;
    box.albums.push({ name: al.album, tracks: al.tracks, duration_ms: al.duration_ms || 0, cover_id: al.cover_id || 0 });
  }
  // 歌曲多的歌手排前面（和「按目录」那种字母序不同——歌手栏第一眼想看到的是自己听得多的人）；
  // 并列时按名字排（localeCompare 'zh' 走 ICU，中文按拼音，比 SQLite 的码点序好看）
  // v1.16.7：没有歌手标签的一律沉到最底部。生产实测这类占一半以上（1654 首里 866 首无标签，
  // 多是背景/学习/古典这类本就没歌手概念的曲子）——按曲数排它必然是第一名，第一眼看到的是
  // 一个三百多行的「未知歌手」巨块，把真正的歌手挤到看不见的地方。
  const out = [...byArtist.values()].map((a) => ({
    ...a,
    albums: a.albums.sort((x, y) => y.tracks - x.tracks || String(x.name).localeCompare(String(y.name), 'zh')),
  })).sort((x, y) => {
    if (!x.name !== !y.name) return x.name ? -1 : 1;   // 有名字的整体排在无名字之前
    return y.tracks - x.tracks || String(x.name).localeCompare(String(y.name), 'zh');
  });
  res.json({ artists: out, total: out.reduce((n, a) => n + a.tracks, 0), unknown_label: '未知歌手' });
});
// 某个歌手某张专辑里的歌曲（album 传空串 = 该歌手的「未知专辑」那一档）
router.get('/mc/album-tracks', (req, res) => {
  ensureScanned();
  const artist = String(req.query.artist == null ? '' : req.query.artist);
  const album = String(req.query.album == null ? '' : req.query.album);
  const tracks = trackRows('WHERE t.artist=? AND t.album=? ORDER BY t.path COLLATE NOCASE', [artist, album], req.user.id);
  res.json({ artist, album, tracks });
});

// ---------- 播放：音频流（Range 206，照视频中心） ----------
router.get('/mc/file', (req, res) => {
  const t = trackById(req.query.id);
  if (!t) return res.status(404).json({ error: '歌曲不存在（可能刚被重新扫描清掉，刷新一下页面）' });
  const full = resolveInRoot(t.path);
  if (!full) return res.status(400).json({ error: '音乐目录未配置或文件越界' });
  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).json({ error: '文件不在磁盘上了（移动过？重新扫描试试）' }); }
  const ext = (t.path.split('.').pop() || '').toLowerCase();
  const mime = AUDIO_MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (range) {
    let m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m) { res.setHeader('Content-Range', 'bytes */' + st.size); return res.status(416).end(); }
    let start = m[1] === '' ? -1 : parseInt(m[1], 10);
    let end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; } // 后缀 range
    if (start < 0 || start > end || end >= st.size) { res.setHeader('Content-Range', 'bytes */' + st.size); return res.status(416).end(); }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.status(206);
    if (req.method === 'HEAD') return res.end();
    if (res.socket) res.socket.setNoDelay(true);
    fs.createReadStream(full, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
  } else {
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') return res.end();
    if (res.socket) res.socket.setNoDelay(true);
    fs.createReadStream(full, { highWaterMark: 1024 * 1024 }).pipe(res);
  }
});
router.options('/mc/file', (req, res) => { // <audio> 跨域预检
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'range, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.sendStatus(204);
});

// ---------- 封面：内嵌抽出图（data/mc/covers/<id>.jpg）→ 目录 cover 图 → 404 ----------
router.get('/mc/cover/:id', (req, res) => {
  const t = trackById(req.params.id);
  if (!t) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const emb = path.join(svc.COVER_DIR, t.id + '.jpg');
  if ((t.has_cover === 1 || t.has_cover === 3) && fs.existsSync(emb)) { // 3=刮削封面（v1.17.0），同存 covers/<id>.jpg
    const head = Buffer.alloc(2);
    let fd; try { fd = fs.openSync(emb, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd); } catch { /* 按默认 jpeg */ }
    res.setHeader('Content-Type', (head[0] === 0x89 && head[1] === 0x50) ? 'image/png' : 'image/jpeg');
    return res.sendFile(emb);
  }
  if (t.has_cover === 2) {
    const full = resolveInRoot(t.path);
    if (full) {
      const cp = svc.dirCover(path.dirname(full));
      if (cp) { res.setHeader('Content-Type', 'image/jpeg'); return res.sendFile(cp); }
    }
  }
  res.status(404).end();
});

// ---------- 收藏（个人：mc_favorites 按 user_id+track_id） ----------
router.get('/mc/favorites', (req, res) => {
  const rows = db.prepare(`SELECT t.id, t.path, t.title, t.artist, t.album, t.duration_ms, t.has_cover, f.created_at AS fav_at
    FROM mc_favorites f JOIN mc_tracks t ON t.id = f.track_id
    WHERE f.user_id=? ORDER BY f.created_at DESC, f.rowid DESC`).all(req.user.id)
    .map((r) => ({ ...r, fav: true }));
  res.json({ tracks: rows });
});
router.post('/mc/favorite', (req, res) => {
  const b = req.body || {};
  const t = trackById(b.id);
  if (!t) return res.status(404).json({ error: '歌曲不存在' });
  if (b.on) db.prepare('INSERT OR IGNORE INTO mc_favorites(user_id, track_id) VALUES(?,?)').run(req.user.id, t.id);
  else db.prepare('DELETE FROM mc_favorites WHERE user_id=? AND track_id=?').run(req.user.id, t.id);
  res.json({ ok: true, id: t.id, fav: !!b.on });
});

// ---------- 歌词：缓存优先，没缓存问 LRCLIB（免费无 Key；429 如实回等待秒数） ----------
router.get('/mc/lyrics/:id', async (req, res) => {
  const t = trackById(req.params.id);
  if (!t) return res.status(404).json({ error: '歌曲不存在' });
  try { res.json(await svc.fetchLyrics(t)); }
  catch (e) { res.status(502).json({ ok: false, error: '歌词服务连不上：' + (e.name === 'TimeoutError' ? 'LRCLIB 超时（10 秒）' : e.message) }); }
});

// ---------- 封面刮削（v1.17.0）：渠道连通测试 + 后台任务 ----------
// 测试（真搜一首「周杰伦 晴天」+ 真下图，不落盘）/ 开始（进程内后台跑，Cloudflare ~100s 墙内绝不同步等）
router.post('/mc/scrape/test', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可测试' });
  res.json(await svc.testScrapeChannel(String((req.body || {}).channel || '')));
});
router.post('/mc/scrape/start', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可刮削' });
  const r = svc.startScrape();
  res.status(r.ok ? 200 : 400).json(r);
});
router.post('/mc/scrape/stop', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可停止' });
  const r = svc.stopScrape();
  res.status(r.ok ? 200 : 400).json(r);
});
router.get('/mc/scrape/status', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可查看' });
  res.json(svc.scrapeStatus());
});

// ---------- 悬浮歌词（v1.17.0）：正在播放上报（任意登录用户；浏览器 musicState 节流 beacon） ----------
router.post('/mc/nowplaying', (req, res) => {
  const r = agent.setNowPlaying(req.user && req.user.username, req.body);
  if (!r.ok) return res.status(400).json({ error: '参数不对（id 为正整数）' });
  res.json({ ok: true });
});

// agent 轮询（index.js EXEMPT 免登录，key 即凭证）：注册/心跳/配置/正在播放全在这一条 GET 里
router.get('/mc/agent/poll', (req, res) => {
  if (!agent.checkAgentKey(String(req.query.key || ''))) return res.status(403).json({ error: 'key 无效' });
  const id = String(req.query.id || '');
  if (!agent.DEVICE_ID_RE.test(id)) return res.status(400).json({ error: '设备号不合法' });
  const row = agent.ensureAgent(id, req.query.computer, req.query.v, req.ip);
  res.json(agent.pollPayload(row));
});

// 已安装设备（管理员）：列表 / 改名与单设备显示开关 / 删除 / 轮换 key / 下载安装包
router.get('/mc/agents', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可查看' });
  res.json({ agents: agent.listAgents() });
});
router.put('/mc/agents/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可修改' });
  const r = agent.updateAgent(req.params.id, req.body || {});
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, agents: agent.listAgents() });
});
router.delete('/mc/agents/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可删除' });
  const r = agent.deleteAgent(req.params.id);
  if (!r.ok) return res.status(404).json({ error: '设备不存在' });
  res.json({ ok: true, agents: agent.listAgents() });
});
router.post('/mc/agent/rotate-key', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可轮换' });
  res.json({ ok: true, key: agent.rotateAgentKey() });
});
router.get('/mc/agent/package', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可下载' });
  const uninstall = req.query.mode === 'uninstall';
  const zip = agent.buildPackage(baseUrl(req), agent.getAgentKey(), uninstall ? { uninstall: true } : {});
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''"
    + encodeURIComponent(uninstall ? '悬浮歌词卸载包.zip' : '悬浮歌词安装包.zip'));
  res.send(zip);
});

module.exports = router;
