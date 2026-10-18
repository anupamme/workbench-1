// Textbook tables. Kept in their own tb_* namespace so the module can be lifted
// out of the workbench database later without renaming anything.
//
// The workbench passes its main node:sqlite database (the one that owns users and
// the shared settings). In standalone mode the same SQL runs against a local
// data/textbook.sqlite created by server/index.js.
function ensureSchema(db) {
  const run = (sql) => db.exec(sql);
  run(`
CREATE TABLE IF NOT EXISTS tb_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS tb_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pdf TEXT NOT NULL,
  title TEXT DEFAULT '',
  html TEXT DEFAULT '',
  share_token TEXT DEFAULT NULL,
  share_enabled INTEGER DEFAULT 0,
  share_with_book INTEGER DEFAULT 1,
  share_mode TEXT DEFAULT 'dynamic',
  share_html TEXT DEFAULT '',
  share_root TEXT DEFAULT '',
  share_expires_at TEXT DEFAULT NULL,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (user_id, pdf)
);
CREATE TABLE IF NOT EXISTS tb_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pdf TEXT NOT NULL,
  page INTEGER NOT NULL,
  label TEXT DEFAULT '',
  color TEXT DEFAULT '#f59e0b',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS tb_ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scope TEXT DEFAULT '',
  profile TEXT DEFAULT '',
  content TEXT NOT NULL,
  model TEXT DEFAULT '',
  tokens INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS tb_ai_usage (
  user_id INTEGER PRIMARY KEY,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  calls INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tb_last (
  user_id INTEGER PRIMARY KEY,
  pdf TEXT DEFAULT '',
  page INTEGER DEFAULT 1,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tb_notes_pdf ON tb_notes(user_id, pdf);
CREATE INDEX IF NOT EXISTS idx_tb_bookmarks_pdf ON tb_bookmarks(user_id, pdf);
CREATE INDEX IF NOT EXISTS idx_tb_ai_reports_user ON tb_ai_reports(user_id, id DESC);
`);
  // older databases get the columns added in place (no destructive migrations)
  const cols = (t) => {
    try { return db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name); } catch { return []; }
  };
  const add = (t, name, ddl) => {
    if (!cols(t).includes(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${ddl}`);
  };
  add('tb_notes', 'share_with_book', 'INTEGER DEFAULT 1');
  add('tb_notes', 'share_mode', "TEXT DEFAULT 'dynamic'");
  add('tb_notes', 'share_html', "TEXT DEFAULT ''");
  add('tb_notes', 'share_root', "TEXT DEFAULT ''");
}

module.exports = { ensureSchema };
