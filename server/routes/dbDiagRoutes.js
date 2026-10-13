// 临时只读诊断路由（v1.16.3 随包上线，定位完即删）：
//   用户报障「家庭管理 → 通知（family_items）里的数据全没了」，而远端只有
//   `/api/vc/fs-probe`（只列名字）可用，没有任何读取/查询数据文件的通道——
//   所以随这一版发一个**管理员专用、只读**的扫描端点，把每个 .sqlite 里
//   family_items 的行数/日期范围/样例标题列出来，用来判断数据还在不在、
//   落在哪个库（主库 / tenant-*.sqlite / archive/<ts>/*.sqlite）。
// 恢复动作**只增不删**：INSERT OR IGNORE 回主库 family_items，绝不 DELETE / 不覆盖。
// 本文件在定位与恢复完成后应从仓库删除（同版本再发一包把端点撤下）。
const fs = require('fs');
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { db, dataDir } = require('../db');

const router = express.Router();
const isAdmin = (req) => !!req.user && req.user.role === 'admin';
const guard = (req, res) => {
  if (!isAdmin(req)) { res.status(403).json({ error: '仅管理员可操作' }); return false; }
  return true;
};

// 关心的表：前六张是家庭模块，后面几张用来判断「是整库丢了还是就这张表空」
const TABLES = ['family_items', 'kids', 'kid_tasks', 'family_profiles', 'family_images', 'kid_stories', 'messages', 'notes', 'vibe_records'];
// 扫描时跳过的目录（模型/音频/缓存，体积大且不可能有库）
const SKIP_DIRS = new Set(['tts', 'vibeasr', 'whisper', 'mc', 'messages-voice', 'story-audio', 'pet-desktop', 'vstudy-cam', 'ssl', 'node_modules', 'Logs']);

function listSqliteFiles() {
  const out = [];
  const seen = new Set();
  const push = (abs) => {
    const key = path.resolve(abs).toLowerCase();
    if (seen.has(key)) return;
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size > 0) { seen.add(key); out.push({ abs, size: st.size, mtime: st.mtime.toISOString() }); }
    } catch { /* 读不到就跳过 */ }
  };
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(n)) continue;
        walk(p, depth + 1);
      } else if (n.endsWith('.sqlite')) push(p);
    }
  };
  walk(dataDir, 0);
  return out.sort((a, b) => b.size - a.size);
}

function inspect(abs) {
  let odb = null;
  const rel = path.relative(dataDir, abs).replace(/\\/g, '/');
  const info = { file: rel, size: fs.statSync(abs).size, tables: {}, family_sample: [], family_date_range: null, error: '' };
  try {
    odb = new DatabaseSync(abs, { readOnly: true });
    const has = new Set(odb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of TABLES) {
      if (!has.has(t)) continue;
      try { info.tables[t] = odb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { info.tables[t] = null; }
    }
    if (has.has('family_items')) {
      try {
        info.family_sample = odb.prepare('SELECT id, title, item_date, created_at FROM family_items ORDER BY id LIMIT 3').all()
          .map((r) => ({ id: r.id, title: String(r.title || '').slice(0, 40), item_date: r.item_date, created_at: r.created_at }));
        info.family_date_range = odb.prepare('SELECT MIN(item_date) AS min_d, MAX(item_date) AS max_d FROM family_items').get();
      } catch (e) { info.error = String(e.message || e); }
    }
  } catch (e) {
    info.error = String(e.message || e);
  } finally {
    try { if (odb) odb.close(); } catch { /* 关不掉也无所谓 */ }
  }
  return info;
}

// 只读扫描：每个库文件的家庭相关表行数 + family_items 样例
router.get('/dbdiag/scan', (req, res) => {
  if (!guard(req, res)) return;
  const files = listSqliteFiles();
  const mainAbs = path.resolve(path.join(dataDir, 'workbench.sqlite'));
  const out = files.map((f) => {
    const info = inspect(f.abs);
    info.mtime = f.mtime;
    info.is_main_live = path.resolve(f.abs).toLowerCase() === mainAbs.toLowerCase();
    return info;
  });
  // 现用连接上的实时读数（DB_FILE 可能不是 workbench.sqlite）
  let liveMain = null;
  try {
    const cnt = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; } };
    liveMain = { tables: Object.fromEntries(TABLES.map((t) => [t, cnt(t)])), db_file: process.env.DB_FILE || 'workbench.sqlite', data_dir: dataDir };
  } catch (e) { liveMain = { error: String(e.message || e) }; }
  res.json({ ok: true, data_dir: dataDir, db_file: process.env.DB_FILE || 'workbench.sqlite', files: out, live_main: liveMain });
});

// ---------- 取证二：主库里所有消息按 module 汇总（family=家庭事项推送的副本） ----------
// 家庭事项登记时若勾了「推送消息给」，title 原文（含 <img src="/api/family-images/N">）
// 会整份存进 messages——条目行被删了，这份副本还在。
router.get('/dbdiag/messages', (req, res) => {
  if (!guard(req, res)) return;
  const module = String(req.query.module || '').trim();
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
  const clip = (s, n) => String(s || '').slice(0, n);
  const imgIds = (s) => [...String(s || '').matchAll(/\/api\/family-images\/(\d+)/g)].map((m) => Number(m[1]));
  try {
    const byModule = db.prepare(
      'SELECT module, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM messages GROUP BY module ORDER BY n DESC'
    ).all();
    const rows = (module
      ? db.prepare('SELECT * FROM messages WHERE module=? ORDER BY id').all(module)
      : db.prepare('SELECT * FROM messages ORDER BY id LIMIT ?').all(limit)
    ).slice(0, limit).map((r) => ({
      id: r.id, module: r.module, from: r.from_user, to: r.to_user, ref_id: r.ref_id,
      created_at: r.created_at, subject: clip(r.subject, 300),
      content: clip(r.content, 2000), content_len: String(r.content || '').length,
      image_ids: imgIds(`${r.subject}\n${r.content}`),
    }));
    // 这些消息引用的图片今天还在不在（主库 family_images 里查得到就是还在）
    const refIds = [...new Set(rows.flatMap((r) => r.image_ids))];
    const alive = refIds.length
      ? db.prepare(`SELECT id FROM family_images WHERE id IN (${refIds.map(() => '?').join(',')})`).all(...refIds).map((r) => r.id)
      : [];
    res.json({
      ok: true, by_module: byModule, count: rows.length,
      images_referenced: refIds.length, images_alive: alive.length,
      images_missing: refIds.filter((id) => !alive.includes(id)),
      messages: rows,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- 取证三：某个库文件的**全部**表名+行数（不限于家庭那几张） ----------
router.get('/dbdiag/tables', (req, res) => {
  if (!guard(req, res)) return;
  const src = String(req.query.file || '').trim();
  if (!src) return res.status(400).json({ error: '需要 file（相对 data 目录）' });
  const abs = path.resolve(dataDir, src);
  if (!abs.startsWith(path.resolve(dataDir) + path.sep)) return res.status(400).json({ error: '路径越界' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在：' + src });
  let odb = null;
  try {
    odb = new DatabaseSync(abs, { readOnly: true });
    const names = odb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const tables = {};
    for (const n of names) {
      try { tables[n] = odb.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get().n; } catch { tables[n] = null; }
    }
    res.json({ ok: true, file: src, size: fs.statSync(abs).size, mtime: fs.statSync(abs).mtime.toISOString(), tables });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally { try { if (odb) odb.close(); } catch { /* ignore */ } }
});

// ---------- 取证四：一次性迁移的守卫键（判断「升级/重启会不会再跑清库」） ----------
const GUARD_KEYS = [
  'multi_tenant_v1', 'mt_cleanup_done', 'family_share_v1', 'stable_db_archived',
  'email_rebuild_done', 'push_merge_v1', 'current_version', 'system_name',
];
router.get('/dbdiag/settings', (req, res) => {
  if (!guard(req, res)) return;
  const out = {};
  for (const k of GUARD_KEYS) {
    try { out[k] = db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null; } catch { out[k] = null; }
  }
  let share = [];
  try { share = db.prepare('SELECT module, is_shared FROM share_config ORDER BY module').all(); } catch { /* ignore */ }
  const usersMeta = db.prepare('SELECT id, username, role FROM users WHERE is_bot=0 ORDER BY id').all();
  res.json({ ok: true, guards: out, share_config: share, users: usersMeta });
});

// ---------- 取证五：AUTOINCREMENT 计数器 + 空闲页 + 图片时间直方图 ----------
// 判据说明：
//   sqlite_sequence 只增不减（AUTOINCREMENT 语义），family_items 若曾有过 4..86 这些行、
//   哪怕后来被删光，计数器也会停在最大值——所以它是「这些行到底在不在过主库」的铁证。
//   freelist_count > 0 = 文件里确实存在被删数据留下的空闲页（能间接印证「删过东西」）。
//   family_images 的 created_at 按天直方图给出图片录入的时间分布，用来给「孤儿图片」聚簇。
router.get('/dbdiag/seq', (req, res) => {
  if (!guard(req, res)) return;
  const seqOf = (abs) => {
    let odb = null;
    const out = { file: path.relative(dataDir, abs).replace(/\\/g, '/'), size: fs.statSync(abs).size, sequence: {}, pragma: {}, images_by_day: null, error: '' };
    try {
      odb = new DatabaseSync(abs, { readOnly: true });
      const has = (t) => !!odb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (has('sqlite_sequence')) {
        for (const r of odb.prepare('SELECT name, seq FROM sqlite_sequence').all()) out.sequence[r.name] = r.seq;
      }
      for (const p of ['page_count', 'page_size', 'freelist_count', 'auto_vacuum']) {
        try { out.pragma[p] = Object.values(odb.prepare(`PRAGMA ${p}`).get())[0]; } catch { /* 老版本不支持就略过 */ }
      }
      if (has('family_images')) {
        out.images_by_day = odb.prepare("SELECT substr(created_at,1,10) AS d, COUNT(*) AS n, MIN(id) AS id_min, MAX(id) AS id_max FROM family_images GROUP BY d ORDER BY d").all();
      }
    } catch (e) { out.error = String(e.message || e); } finally { try { if (odb) odb.close(); } catch { /* ignore */ } }
    return out;
  };
  const files = [path.join(dataDir, process.env.DB_FILE || 'workbench.sqlite'), ...listSqliteFiles().map((f) => f.abs)];
  const seen = new Set();
  const uniq = [];
  for (const f of files) {
    const k = path.resolve(f).toLowerCase();
    if (seen.has(k) || !fs.existsSync(f)) continue;
    seen.add(k); uniq.push(f);
  }
  res.json({ ok: true, files: uniq.map(seqOf) });
});

// ---------- 恢复：从「家庭事项推送副本」重建 family_items + 把孤儿图片归集成找回条 ----------
// 原理：登记时若勾了「推送消息给」，条目原文（title 全文含 <img>）整份存进 messages。
// 条目行被删了，这份副本还在，据此把内容拼回来（严格只增：INSERT OR IGNORE，按 id 跳过已有行）。
// 不可复原的字段（status / 谁勾选的 / 43 条当时没勾推送的条目正文）如实报出，不编。
const FAMILY_MSG_PREFIX = '家庭事项：';
const ORPHAN_GAP_SEC = 300; // 孤儿图片聚簇：相邻两张时间差 > 5 分钟即算另一条

function parseFamilyPush(m) {
  const id = Number(m.ref_id || 0);
  if (!id) return null;
  let title = String(m.subject || '');
  if (title.startsWith(FAMILY_MSG_PREFIX)) title = title.slice(FAMILY_MSG_PREFIX.length);
  else return null; // 不是「家庭事项：」开头的不是本模块的推送（防误用）
  let content = String(m.content || '');
  let item_date = null;
  const dm = /\n日期：(\d{4}-\d{2}-\d{2})\s*$/.exec(content);
  if (dm) { item_date = dm[1]; content = content.slice(0, dm.index); }
  let desc = content.startsWith(title) ? content.slice(title.length) : content;
  desc = desc.replace(/^\n+/, '');
  return { id, title, desc, item_date, created_at: m.created_at, msg_id: m.id };
}

function planFamilyRecover() {
  const msgs = db.prepare("SELECT id, subject, content, ref_id, created_at FROM messages WHERE module='family' ORDER BY id").all();
  const byId = new Map();
  for (const m of msgs) {
    const p = parseFamilyPush(m);
    if (!p) continue;
    const cur = byId.get(p.id);
    // 同一条推给多人会有多份副本：取「正文更长」的那份（desc 可能被后来的编辑改更长）
    if (!cur) byId.set(p.id, p);
    else {
      if (p.desc.length > cur.desc.length) cur.desc = p.desc;
      if (!cur.item_date && p.item_date) cur.item_date = p.item_date;
    }
  }
  const items = [...byId.values()].sort((a, b) => a.id - b.id);
  const existIds = new Set(db.prepare('SELECT id FROM family_items').all().map((r) => r.id));
  const toInsert = items.filter((it) => !existIds.has(it.id));

  // 孤儿图片 = family_images 里没有被任何（已存在的 + 待恢复的）条目引用的那些
  const allItems = db.prepare('SELECT id, title, desc FROM family_items').all();
  const ref = new Set();
  const grab = (s) => { for (const m of String(s || '').matchAll(/\/api\/family-images\/(\d+)/g)) ref.add(Number(m[1])); };
  for (const r of allItems) { grab(r.title); grab(r.desc); }
  for (const it of toInsert) { grab(it.title); grab(it.desc); }
  const imgs = db.prepare('SELECT id, mime, created_at FROM family_images ORDER BY id').all();
  const orphans = imgs.filter((r) => !ref.has(r.id));

  // 按时间聚簇：同一批粘贴的图片 created_at 几乎相同，间隔 > 5 分钟视为另一条
  const groups = [];
  let g = null;
  const toSec = (s) => {
    const t = Date.parse(String(s || '').replace(' ', 'T'));
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  };
  for (const o of orphans) {
    const sec = toSec(o.created_at);
    const last = g && g.items.length ? toSec(g.items[g.items.length - 1].created_at) : null;
    if (!g || sec === null || last === null || sec - last > ORPHAN_GAP_SEC) { g = { at: o.created_at, date: String(o.created_at || '').slice(0, 10), items: [] }; groups.push(g); }
    g.items.push(o);
  }
  return { msgs: msgs.length, items, toInsert, orphans, groups };
}

const recStamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(s || '');
};

router.post('/dbdiag/recover-family', (req, res) => {
  if (!guard(req, res)) return;
  try {
    const dry = !(req.body && req.body.confirm === 'RECOVER');
    const p = planFamilyRecover();
    const plan = {
      ok: true, dry,
      msgs_family: p.msgs,
      items_recoverable: p.items.length,
      items_already_in_db: p.items.length - p.toInsert.length,
      will_insert: p.toInsert.length,
      images_total: db.prepare('SELECT COUNT(*) AS n FROM family_images').get().n,
      images_orphan: p.orphans.length,
      orphan_groups: p.groups.length,
      insert_sample: p.toInsert.slice(0, 8).map((it) => ({ id: it.id, date: it.item_date, created_at: it.created_at, title: String(it.title).slice(0, 60), desc_len: it.desc.length })),
      orphan_groups_preview: p.groups.slice(0, 12).map((g) => ({ at: g.at, n: g.items.length, ids: g.items.slice(0, 6).map((x) => x.id) })),
      note: '只增不删：条目 INSERT OR IGNORE（按原 id，跳过主库已有的）；孤儿图片各归入一条「找回的图片」新条目。不改动、不删除任何现有数据。',
      unrecoverable: '条目正文里没勾推送的那批（原文已随之丢失，只剩图片）；status 勾选状态、勾选人、登记人一律无法复原，统一按未完成处理。',
    };
    if (dry) return res.json(plan);

    const fdb = db; // family 共享开关为「开」时家庭数据读写主库；为「关」时主库不是用户看到的那份
    let shareOn = null;
    try { shareOn = db.prepare("SELECT is_shared FROM share_config WHERE module='family'").get()?.is_shared ?? null; } catch { /* 老库无此表 */ }
    const admin = db.prepare("SELECT id, username, COALESCE(NULLIF(display_name,''), NULLIF(nickname,''), username) AS nm FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
    const stmt = fdb.prepare(`INSERT OR IGNORE INTO family_items(id, title, desc, item_date, status, created_at, created_by, created_by_name)
      VALUES(?,?,?,?,?,?,?,?)`);
    let ins = 0;
    for (const it of p.toInsert) {
      ins += stmt.run(it.id, it.title, it.desc, it.item_date, 'todo', it.created_at, admin ? admin.id : null, admin ? admin.nm : '').changes;
    }
    // 孤儿图片：一条聚簇 = 一条新条目。图片必须放 title——列表里只有 title 走 v-html，
    // desc 是纯文本插值（{{ }}）渲染不出 <img>。
    let gal = 0, galItems = 0;
    const gstmt = fdb.prepare(`INSERT INTO family_items(title, desc, item_date, status, created_by, created_by_name)
      VALUES(?,?,?,?,?,?)`);
    for (const g of p.groups) {
      const title = `找回的图片 · ${recStamp(g.at)}（${g.items.length} 张）`
        + g.items.map((x) => `<img src="/api/family-images/${x.id}">`).join('');
      const desc = '这条在数据找回时按时间聚簇还原：原文已丢失，图片都还在。';
      gstmt.run(title, desc, g.date || null, 'todo', admin ? admin.id : null, admin ? admin.nm : '');
      gal++; galItems += g.items.length;
    }
    res.json({ ...plan, dry: false, inserted: ins, gallery_items: gal, gallery_images: galItems, items_after: db.prepare('SELECT COUNT(*) AS n FROM family_items').get().n, family_share_on: shareOn });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 列名取主库 family_items 的真实结构，只搬两边都有的列
function commonCols(srcCols) {
  const dst = new Set(db.prepare('PRAGMA table_info(family_items)').all().map((r) => r.name));
  return srcCols.filter((c) => dst.has(c));
}

// 恢复（严格只增不删）：把某个库文件里的 family_items 用 INSERT OR IGNORE 回填主库。
// 干跑（默认）= 只报数；真做要带 confirm: 'RESTORE'。
router.post('/dbdiag/restore-family', (req, res) => {
  if (!guard(req, res)) return;
  const src = String(req.body && req.body.src || '').trim();
  if (!src) return res.status(400).json({ error: '需要 src（相对 data 目录的库文件名，如 tenant-1.sqlite）' });
  const abs = path.resolve(dataDir, src);
  if (!abs.startsWith(path.resolve(dataDir) + path.sep)) return res.status(400).json({ error: '路径越界' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在：' + src });

  let odb = null;
  try {
    odb = new DatabaseSync(abs, { readOnly: true });
    const has = odb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='family_items'").get();
    if (!has) return res.status(400).json({ error: '源库里没有 family_items 表：' + src });
    const rows = odb.prepare('SELECT * FROM family_items ORDER BY id').all();
    const cols = rows.length ? commonCols(Object.keys(rows[0])) : [];
    const mainIds = new Set(db.prepare('SELECT id FROM family_items').all().map((r) => r.id));
    const toInsert = rows.filter((r) => !mainIds.has(r.id));
    const plan = {
      ok: true, dry: !(req.body && req.body.confirm === 'RESTORE'), src,
      src_total: rows.length, main_existing: mainIds.size,
      will_insert: toInsert.length, cols: cols.join(','),
      sample: toInsert.slice(0, 5).map((r) => ({ id: r.id, title: String(r.title || '').slice(0, 40), item_date: r.item_date })),
      note: '只增不删：INSERT OR IGNORE，按 id 跳过主库已有的行，不改动、不删除任何现有数据。',
    };
    if (plan.dry) return res.json(plan);

    const ph = cols.map(() => '?').join(',');
    const stmt = db.prepare(`INSERT OR IGNORE INTO family_items (${cols.join(',')}) VALUES (${ph})`);
    let inserted = 0;
    for (const r of toInsert) { try { inserted += stmt.run(...cols.map((c) => r[c])).changes; } catch { /* 单行失败不中断 */ } }
    const after = db.prepare('SELECT COUNT(*) AS n FROM family_items').get().n;
    res.json({ ...plan, dry: false, inserted, main_after: after });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try { if (odb) odb.close(); } catch { /* ignore */ }
  }
});

module.exports = router;
