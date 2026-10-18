// HTTP API for the textbook module.
//
// The router is created with a small context so the same code runs inside the
// workbench (shares its users, settings DB and AI service) and standalone
// (server/index.js wires a local SQLite file and its own AI config).
//
// ctx = {
//   db,                 // node:sqlite DatabaseSync, already passed to ensureSchema
//   ai,                 // optional { chatEx, hasConfig }
//   defaultRoot,        // textbook directory used when the user has not set one
//   dataDir,            // optional, for future storage
//   listUsers,          // optional () => [{ id, username, display_name, nickname, role }]
//   isAdmin(req),       // optional; defaults to true (standalone)
//   mountBase,          // optional, '/textbook' (only used to build share URLs)
// }
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const books = require('./books');
const marks = require('./marks');

const EXT_CT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const SETTING_KEYS = ['root', 'student_name', 'grade', 'academic_year', 'intro',
  'exts', 'show54', 'theme', 'default_expand', 'default_students'];

function localNow() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().replace('T', ' ').slice(0, 19);
}

function createRouter(ctx) {
  const db = ctx.db;
  const router = express.Router();
  const uid = (req) => (req.user && Number.isFinite(Number(req.user.id)) ? Number(req.user.id) : 0);
  const isAdmin = (req) => (typeof ctx.isAdmin === 'function' ? !!ctx.isAdmin(req) : true);

  function getSetting(userId, key, def) {
    try {
      const row = db.prepare('SELECT value FROM tb_settings WHERE user_id = ? AND key = ?').get(userId, key);
      if (!row) return def;
      return JSON.parse(row.value);
    } catch { return def; }
  }
  function setSetting(userId, key, value) {
    const raw = JSON.stringify(value);
    const now = localNow();
    db.prepare(`INSERT INTO tb_settings(user_id, key, value, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(userId, key, raw, now);
  }
  function allSettings(userId) {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = getSetting(userId, k, null);
    return out;
  }

  function rootOf(req) {
    const r = getSetting(uid(req), 'root', '');
    return String(r || ctx.defaultRoot || '').trim();
  }
  function optsOf(req) {
    const exts = getSetting(uid(req), 'exts', ['.pdf']);
    return { exts: Array.isArray(exts) ? exts : ['.pdf'], show54: !!getSetting(uid(req), 'show54', false) };
  }
  function resolveBookPath(req, rel) {
    const root = rootOf(req);
    if (!root) return null;
    const full = books.resolveInRoot(root, rel);
    return full;
  }
  function ensurePdf(req, rel) {
    const full = resolveBookPath(req, rel);
    if (!full) return null;
    if (!/\.pdf$/i.test(full)) return null;
    try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
    return full;
  }

  function safeUser(u) {
    return {
      id: u.id, username: u.username, name: u.display_name || u.nickname || u.username,
      role: u.role || 'user', disabled: !!u.disabled,
    };
  }
  function listUsers() {
    if (typeof ctx.listUsers === 'function') {
      try { return ctx.listUsers().map(safeUser); } catch { return []; }
    }
    return [{ id: uid({ user: null }), username: '本机用户', name: '本机用户', role: 'admin' }];
  }

  // ---- settings -----------------------------------------------------------
  // The embedded copy hides standalone-only management screens; the same SPA
  // serves both, so it asks the server what it can do instead of guessing.
  router.get('/capabilities', (req, res) => {
    res.json({
      embedded: !!ctx.embedded,
      manage_users: !!ctx.manageUsers,
      ai_config: !!ctx.aiConfig,
      admin: isAdmin(req),
    });
  });

  router.get('/settings', (req, res) => {
    const u = uid(req);
    const s = allSettings(u);
    const root = String(s.root || ctx.defaultRoot || '');
    let rootOk = false, rootErr = '';
    if (root) {
      try { rootOk = fs.statSync(root).isDirectory(); } catch { rootErr = '目录不存在或不可读'; }
    } else rootErr = '尚未设置教材根目录';
    res.json({
      settings: {
        ...s,
        root,
        exts: Array.isArray(s.exts) && s.exts.length ? s.exts : ['.pdf'],
        show54: !!s.show54,
        default_expand: Array.isArray(s.default_expand) ? s.default_expand : [],
        theme: s.theme === 'dark' ? 'dark' : 'light',
        student_name: s.student_name || '',
        grade: s.grade || '',
        academic_year: s.academic_year || '',
        intro: s.intro || '',
      },
      root_ok: rootOk,
      root_error: rootErr,
      optional_exts: books.OPTIONAL_EXTS,
      default_root: ctx.defaultRoot || '',
    });
  });

  router.put('/settings', (req, res) => {
    const u = uid(req);
    const b = req.body || {};
    if ('root' in b) {
      const r = String(b.root || '').trim();
      if (r) {
        try { if (!fs.statSync(r).isDirectory()) return res.status(400).json({ error: '目录不存在' }); }
        catch { return res.status(400).json({ error: '目录不存在' }); }
      }
      setSetting(u, 'root', r);
      books.clearCache();
    }
    if ('student_name' in b) setSetting(u, 'student_name', String(b.student_name || '').slice(0, 60));
    if ('grade' in b) setSetting(u, 'grade', String(b.grade || '').slice(0, 60));
    if ('academic_year' in b) setSetting(u, 'academic_year', String(b.academic_year || '').slice(0, 40));
    if ('intro' in b) setSetting(u, 'intro', String(b.intro || '').slice(0, 5000));
    if ('theme' in b) setSetting(u, 'theme', b.theme === 'dark' ? 'dark' : 'light');
    if ('show54' in b) setSetting(u, 'show54', !!b.show54);
    if ('default_expand' in b && Array.isArray(b.default_expand)) {
      setSetting(u, 'default_expand', b.default_expand.slice(0, 40).map((x) => String(x).slice(0, 300)));
    }
    if ('exts' in b) {
      const allowed = new Set(['.pdf', ...books.OPTIONAL_EXTS]);
      const list = (Array.isArray(b.exts) ? b.exts : []).map((x) => {
        let e = String(x || '').toLowerCase();
        if (!e.startsWith('.')) e = '.' + e;
        return e;
      }).filter((e) => allowed.has(e));
      setSetting(u, 'exts', list.length ? Array.from(new Set(['.pdf', ...list])) : ['.pdf']);
    }
    res.json({ ok: true });
  });

  // Directory picker for the root setting. Directories only, never file bytes.
  router.get('/browse', (req, res) => {
    const raw = String(req.query.path || '').trim();
    const show = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.pdf_merge_folder'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    };
    if (!raw) {
      const roots = [];
      const push = (p, label) => {
        try { if (fs.statSync(p).isDirectory() && !roots.find((r) => r.path === p)) roots.push({ name: label, path: p }); } catch { /* skip */ }
      };
      if (process.platform === 'win32') {
        for (let i = 65; i <= 90; i++) push(`${String.fromCharCode(i)}:\\`, `${String.fromCharCode(i)}:\\`);
      } else {
        push('/', '/');
        push(path.join(require('os').homedir(), ''), '主目录');
      }
      if (ctx.defaultRoot) push(ctx.defaultRoot, '默认教材目录');
      return res.json({ path: '', parent: null, dirs: roots });
    }
    let st;
    try { st = fs.statSync(raw); } catch { return res.status(404).json({ error: '目录不存在' }); }
    if (!st.isDirectory()) return res.status(400).json({ error: '不是目录' });
    const parent = path.dirname(raw);
    res.json({ path: raw, parent: parent === raw ? null : parent, dirs: show(raw) });
  });

  // ---- tree / covers ------------------------------------------------------
  router.get('/tree', (req, res) => {
    const root = rootOf(req);
    if (!root) return res.status(400).json({ error: 'no_root', message: '尚未设置教材根目录' });
    const d = books.listDir(root, req.query.path || '', optsOf(req));
    if (d.error) return res.status(d.error === 'not_found' ? 404 : 400).json(d);
    res.json(d);
  });

  router.post('/refresh', (req, res) => {
    books.clearCache();
    res.json({ ok: true });
  });

  router.get('/covers', (req, res) => {
    const root = rootOf(req);
    if (!root) return res.status(400).json({ error: 'no_root' });
    const limit = Math.min(1200, Math.max(1, Number(req.query.limit) || 600));
    const rel = String(req.query.path || '');
    const full = books.resolveInRoot(root, rel);
    if (!full) return res.status(400).json({ error: 'bad_path' });
    try {
      if (!fs.statSync(full).isDirectory()) return res.status(400).json({ error: 'not_dir' });
    } catch { return res.status(404).json({ error: 'not_found' }); }
    const items = books.collectPdfs(root, rel, optsOf(req), limit);
    res.json({ path: rel, items, truncated: items.length >= limit });
  });

  router.get('/thumb', (req, res) => {
    const full = ensurePdf(req, req.query.path || '');
    if (!full) return res.status(404).end();
    const jpg = books.thumbPathFor(full);
    try {
      if (!fs.statSync(jpg).isFile()) return res.status(404).end();
    } catch { return res.status(404).end(); }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(jpg);
  });

  // ---- files (Range) ------------------------------------------------------
  function streamFile(req, res, full) {
    const ext = path.extname(full).toLowerCase();
    const ct = EXT_CT[ext];
    if (!ct) return res.status(400).json({ error: 'unsupported_type' });
    let st;
    try { st = fs.statSync(full); } catch { return res.status(404).end(); }
    if (!st.isFile()) return res.status(404).end();
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`);

    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Length', st.size);
      return fs.createReadStream(full, { highWaterMark: 1024 * 1024 }).pipe(res);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
      return res.end();
    }
    let start, end;
    if (m[1] === '' && m[2] !== '') {
      const suffix = Number(m[2]);
      start = Math.max(0, st.size - suffix);
      end = st.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
      return res.end();
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(full, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
  }

  router.get('/file', (req, res) => {
    const root = rootOf(req);
    const full = books.resolveInRoot(root, req.query.path || '');
    if (!full) return res.status(400).json({ error: 'bad_path' });
    const ext = path.extname(full).toLowerCase();
    const allowed = books.allowedExtensions(optsOf(req).exts);
    if (!allowed.has(ext)) return res.status(403).json({ error: 'ext_not_allowed' });
    streamFile(req, res, full);
  });

  // ---- annotations --------------------------------------------------------
  router.get('/marks', async (req, res) => {
    const rel = String(req.query.path || '');
    const full = ensurePdf(req, rel);
    if (!full) return res.status(404).json({ error: 'not_found' });
    try {
      const doc = await marks.readMarks(full, rel);
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: 'read_failed', message: String(e.message || e) });
    }
  });

  router.put('/marks', async (req, res) => {
    const rel = String(req.query.path || '');
    const full = ensurePdf(req, rel);
    if (!full) return res.status(404).json({ error: 'not_found' });
    try {
      const r = await marks.writeMarks(full, rel, req.body || {});
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: 'write_failed', message: String(e.message || e) });
    }
  });

  // ---- bookmarks ----------------------------------------------------------
  router.get('/bookmarks', (req, res) => {
    const u = uid(req);
    const rel = String(req.query.path || '');
    const rows = db.prepare('SELECT id, page, label, color, created_at FROM tb_bookmarks WHERE user_id = ? AND pdf = ? ORDER BY page, id')
      .all(u, rel);
    res.json({ items: rows });
  });

  router.post('/bookmarks', (req, res) => {
    const u = uid(req);
    const b = req.body || {};
    const rel = String(b.path || '');
    if (!ensurePdf(req, rel)) return res.status(404).json({ error: 'not_found' });
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    const label = String(b.label || '').slice(0, 200);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || '')) ? b.color : '#f59e0b';
    const r = db.prepare('INSERT INTO tb_bookmarks(user_id, pdf, page, label, color, created_at) VALUES(?,?,?,?,?,?)')
      .run(u, rel, page, label, color, localNow());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  router.put('/bookmarks/:id', (req, res) => {
    const u = uid(req);
    const id = Number(req.params.id);
    const b = req.body || {};
    const row = db.prepare('SELECT id FROM tb_bookmarks WHERE id = ? AND user_id = ?').get(id, u);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if ('page' in b) db.prepare('UPDATE tb_bookmarks SET page = ? WHERE id = ?').run(Math.max(1, Math.floor(Number(b.page) || 1)), id);
    if ('label' in b) db.prepare('UPDATE tb_bookmarks SET label = ? WHERE id = ?').run(String(b.label || '').slice(0, 200), id);
    if ('color' in b && /^#[0-9a-fA-F]{6}$/.test(String(b.color))) db.prepare('UPDATE tb_bookmarks SET color = ? WHERE id = ?').run(b.color, id);
    res.json({ ok: true });
  });

  router.delete('/bookmarks/:id', (req, res) => {
    const u = uid(req);
    db.prepare('DELETE FROM tb_bookmarks WHERE id = ? AND user_id = ?').run(Number(req.params.id), u);
    res.json({ ok: true });
  });

  // ---- notes --------------------------------------------------------------
  function noteRow(u, rel) {
    return db.prepare('SELECT * FROM tb_notes WHERE user_id = ? AND pdf = ?').get(u, rel);
  }
  function shareUrlOf(token) {
    const raw = ctx.mountBase != null ? ctx.mountBase : '/textbook';
    const base = String(raw).replace(/\/+$/, '');
    return `${base}/#/share/${token}`;
  }

  router.get('/note', (req, res) => {
    const u = uid(req);
    const rel = String(req.query.path || '');
    const row = noteRow(u, rel);
    if (!row) return res.json({ path: rel, html: '', title: '', share: null });
    res.json({
      path: rel,
      html: row.html || '',
      title: row.title || '',
      updated_at: row.updated_at,
      share: row.share_token && row.share_enabled ? {
        token: row.share_token,
        url: shareUrlOf(row.share_token),
        with_book: !!row.share_with_book,
        mode: row.share_mode || 'dynamic',
        expires_at: row.share_expires_at,
      } : null,
    });
  });

  router.put('/note', (req, res) => {
    const u = uid(req);
    const b = req.body || {};
    const rel = String(b.path || '');
    const full = ensurePdf(req, rel);
    if (!full) return res.status(404).json({ error: 'not_found' });
    const html = String(b.html || '');
    const title = String(b.title || path.basename(full).replace(/\.pdf$/i, '')).slice(0, 200);
    const now = localNow();
    db.prepare(`INSERT INTO tb_notes(user_id, pdf, title, html, created_at, updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id, pdf) DO UPDATE SET title = excluded.title, html = excluded.html, updated_at = excluded.updated_at`)
      .run(u, rel, title, html, now, now);
    // static shares keep their snapshot until the owner refreshes them
    const row = noteRow(u, rel);
    if (row && row.share_enabled && row.share_mode === 'static' && b.refresh_share) {
      db.prepare('UPDATE tb_notes SET share_html = ? WHERE id = ?').run(html, row.id);
    }
    res.json({ ok: true, updated_at: now });
  });

  router.post('/note/share', (req, res) => {
    const u = uid(req);
    const b = req.body || {};
    const rel = String(b.path || '');
    const full = ensurePdf(req, rel);
    if (!full) return res.status(404).json({ error: 'not_found' });
    const row = noteRow(u, rel);
    if (!row) return res.status(400).json({ error: 'empty_note', message: '先写点笔记再分享' });
    const days = [0, 7, 14, 30].includes(Number(b.days)) ? Number(b.days) : 0;
    const withBook = b.with_book === false ? 0 : 1;
    const mode = b.mode === 'static' ? 'static' : 'dynamic';
    const root = rootOf(req);
    const token = row.share_token && row.share_enabled && b.keep_token
      ? row.share_token
      : crypto.randomBytes(18).toString('base64url');
    const expires = days > 0
      ? db.prepare("SELECT datetime('now','localtime', ?) AS t").get(`+${days} days`).t
      : null;
    db.prepare(`UPDATE tb_notes SET share_token = ?, share_enabled = 1, share_with_book = ?,
      share_mode = ?, share_html = ?, share_root = ?, share_expires_at = ? WHERE id = ?`)
      .run(token, withBook, mode, mode === 'static' ? (row.html || '') : '', root, expires, row.id);
    res.json({
      ok: true, token, url: shareUrlOf(token), with_book: !!withBook,
      mode, expires_at: expires,
    });
  });

  router.delete('/note/share', (req, res) => {
    const u = uid(req);
    const rel = String(req.query.path || '');
    const row = noteRow(u, rel);
    if (!row) return res.status(404).json({ error: 'not_found' });
    db.prepare("UPDATE tb_notes SET share_enabled = 0, share_token = NULL, share_expires_at = NULL WHERE id = ?").run(row.id);
    res.json({ ok: true });
  });

  // ---- public share (no auth; mounted outside the login gate) -------------
  function publicNote(token) {
    if (!token || String(token).length < 16) return null;
    const row = db.prepare('SELECT * FROM tb_notes WHERE share_token = ? AND share_enabled = 1').get(String(token));
    if (!row) return null;
    if (row.share_expires_at) {
      const now = localNow();
      if (new Date(String(row.share_expires_at).replace(' ', 'T')) < new Date(now.replace(' ', 'T'))) return null;
    }
    return row;
  }

  router.get('/pub/:token', (req, res) => {
    const row = publicNote(req.params.token);
    if (!row) return res.status(404).json({ error: 'not_found', message: '链接已失效或已关闭' });
    const html = row.share_mode === 'static' ? (row.share_html || '') : (row.html || '');
    const bookTitle = path.basename(row.pdf).replace(/\.pdf$/i, '');
    res.json({
      title: row.title || bookTitle,
      html,
      updated_at: row.updated_at,
      expires_at: row.share_expires_at,
      with_book: !!row.share_with_book,
      book: row.share_with_book ? { title: bookTitle, path: row.pdf } : null,
    });
  });

  router.get('/pub/:token/file', (req, res) => {
    const row = publicNote(req.params.token);
    if (!row || !row.share_with_book) return res.status(404).end();
    const root = String(row.share_root || rootOf(req) || '');
    const full = books.resolveInRoot(root, row.pdf);
    if (!full || !/\.pdf$/i.test(full)) return res.status(404).end();
    streamFile(req, res, full);
  });

  router.get('/pub/:token/thumb', (req, res) => {
    const row = publicNote(req.params.token);
    if (!row || !row.share_with_book) return res.status(404).end();
    const root = String(row.share_root || rootOf(req) || '');
    const full = books.resolveInRoot(root, row.pdf);
    if (!full) return res.status(404).end();
    const jpg = books.thumbPathFor(full);
    try { if (!fs.statSync(jpg).isFile()) return res.status(404).end(); } catch { return res.status(404).end(); }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(jpg);
  });

  // ---- AI analysis --------------------------------------------------------
  function stripHtml(html) {
    return String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<img[^>]*>/gi, ' [图片] ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function recordUsage(u, usage) {
    if (!usage) return 0;
    const p = Number(usage.prompt_tokens) || 0;
    const c = Number(usage.completion_tokens) || 0;
    const t = Number(usage.total_tokens) || p + c;
    if (!t) return 0;
    db.prepare(`INSERT INTO tb_ai_usage(user_id, prompt_tokens, completion_tokens, total_tokens, calls, updated_at)
      VALUES(?,?,?,?,1,?)
      ON CONFLICT(user_id) DO UPDATE SET
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        calls = calls + 1, updated_at = excluded.updated_at`)
      .run(u, p, c, t, localNow());
    return t;
  }

  router.post('/ai/analyze', async (req, res) => {
    const u = uid(req);
    if (!ctx.ai || typeof ctx.ai.chatEx !== 'function') {
      return res.status(409).json({ error: 'ai_unavailable', message: '工作台还没有配置 AI' });
    }
    try {
      if (typeof ctx.ai.hasConfig === 'function' && !ctx.ai.hasConfig(null)) {
        return res.status(409).json({ error: 'ai_unconfigured', message: '请先在设置→AI 里配置模型' });
      }
    } catch { /* fall through to the call */ }
    const b = req.body || {};
    const scope = String(b.scope || 'all');
    const rel = String(b.path || '');
    const s = allSettings(u);
    let notes;
    if (scope === 'pdf' && rel) {
      const row = noteRow(u, rel);
      notes = row ? [row] : [];
      if (!notes.length) return res.status(400).json({ error: 'empty_note', message: '这篇教材还没有笔记' });
    } else {
      notes = db.prepare("SELECT pdf, title, html, updated_at FROM tb_notes WHERE user_id = ? AND html != '' ORDER BY updated_at DESC LIMIT 20").all(u);
      if (!notes.length) return res.status(400).json({ error: 'empty_note', message: '还没有任何笔记' });
    }
    const profile = [
      s.student_name ? `学生：${s.student_name}` : '',
      s.grade ? `年级：${s.grade}` : '',
      s.academic_year ? `学年：${s.academic_year}` : '',
      s.intro ? `基本情况：${s.intro}` : '',
    ].filter(Boolean).join('\n') || '（未填写学生信息）';

    let budget = 12000;
    const parts = [];
    for (const n of notes) {
      const text = stripHtml(n.html);
      if (!text) continue;
      const title = n.title || path.basename(String(n.pdf || '')).replace(/\.pdf$/i, '');
      const cut = text.slice(0, Math.min(3000, Math.max(600, Math.floor(budget))));
      budget -= cut.length;
      parts.push(`### 教材/笔记：${title}\n更新时间：${n.updated_at || ''}\n${cut}`);
      if (budget <= 0) break;
    }
    if (!parts.length) return res.status(400).json({ error: 'empty_note', message: '笔记内容是空的' });

    const sys = '你是一位经验丰富的中小学全科教师和学习规划师。请根据学生的基本信息和学习笔记，分析其对相关教材内容的掌握情况。'
      + '输出 Markdown，必须包含四个部分：## 总体掌握情况、## 各学科掌握分析、## 薄弱知识点与原因、## 下一步学习建议。'
      + '要求：结论必须有笔记中的依据；不确定的地方明确说「笔记中没有体现」；语气客观、具体、可执行；不要编造学生没写过的内容。';
    const userMsg = `学生信息：\n${profile}\n\n学习笔记（最多 ${parts.length} 篇，按最近更新排序）：\n\n${parts.join('\n\n')}\n\n请输出分析报告。`;
    try {
      const r = await ctx.ai.chatEx(
        [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        { maxTokens: 2200, temperature: 0.3, tdb: req.tdb || null },
      );
      const tokens = recordUsage(u, r.usage);
      const ins = db.prepare('INSERT INTO tb_ai_reports(user_id, scope, profile, content, model, tokens, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(u, scope, profile, r.content || '', r.model || '', tokens, localNow());
      res.json({ ok: true, id: Number(ins.lastInsertRowid), content: r.content, model: r.model || '', tokens });
    } catch (e) {
      res.status(502).json({ error: 'ai_failed', message: String(e.message || e) });
    }
  });

  router.get('/ai/reports', (req, res) => {
    const u = uid(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = db.prepare('SELECT id, scope, profile, model, tokens, created_at, substr(content, 1, 120) AS preview FROM tb_ai_reports WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(u, limit);
    res.json({ items: rows });
  });

  router.get('/ai/report/:id', (req, res) => {
    const u = uid(req);
    const row = db.prepare('SELECT * FROM tb_ai_reports WHERE id = ? AND user_id = ?').get(Number(req.params.id), u);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.delete('/ai/report/:id', (req, res) => {
    const u = uid(req);
    db.prepare('DELETE FROM tb_ai_reports WHERE id = ? AND user_id = ?').run(Number(req.params.id), u);
    res.json({ ok: true });
  });

  function usageOf(userId) {
    const row = db.prepare('SELECT * FROM tb_ai_usage WHERE user_id = ?').get(userId);
    return row || { user_id: userId, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, updated_at: null };
  }

  router.get('/ai/usage', (req, res) => {
    res.json(usageOf(uid(req)));
  });

  // ---- users --------------------------------------------------------------
  router.get('/users', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
    const users = listUsers();
    const usage = new Map(db.prepare('SELECT * FROM tb_ai_usage').all().map((r) => [Number(r.user_id), r]));
    const noteCounts = new Map(db.prepare('SELECT user_id, COUNT(*) AS n FROM tb_notes GROUP BY user_id').all()
      .map((r) => [Number(r.user_id), Number(r.n)]));
    const items = users.map((u) => {
      const g = usage.get(Number(u.id)) || {};
      return {
        ...u,
        prompt_tokens: Number(g.prompt_tokens) || 0,
        completion_tokens: Number(g.completion_tokens) || 0,
        total_tokens: Number(g.total_tokens) || 0,
        calls: Number(g.calls) || 0,
        notes: noteCounts.get(Number(u.id)) || 0,
        updated_at: g.updated_at || null,
      };
    });
    res.json({ items });
  });

  // ---- last position ------------------------------------------------------
  router.get('/last', (req, res) => {
    const row = db.prepare('SELECT pdf, page, updated_at FROM tb_last WHERE user_id = ?').get(uid(req));
    res.json(row || { pdf: '', page: 1, updated_at: null });
  });

  router.put('/last', (req, res) => {
    const u = uid(req);
    const b = req.body || {};
    const pdf = String(b.pdf || '');
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    if (pdf && !ensurePdf(req, pdf)) return res.status(404).json({ error: 'not_found' });
    if (!pdf) return res.status(400).json({ error: 'bad_path' });
    db.prepare(`INSERT INTO tb_last(user_id, pdf, page, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET pdf = excluded.pdf, page = excluded.page, updated_at = excluded.updated_at`)
      .run(u, pdf, page, localNow());
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createRouter, SETTING_KEYS };
