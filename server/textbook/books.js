// Directory scanning, ordering rules and sidecar thumbnails.
//
// The data root is a plain folder tree:
//   学段 / 学科 / 教材版本 / 年级 / 上下册 / *.pdf
// Only the ordering is opinionated: users read the tree top-down and the default
// curriculum order is the one they expect (see compareNames below).
const fs = require('fs');
const path = require('path');

const PDF_RE = /\.pdf$/i;
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;
const OFFICE_RE = /\.(docx?|xlsx?|pptx?)$/i;

const DEFAULT_EXTS = ['.pdf'];
const OPTIONAL_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.jpg', '.jpeg', '.png'];

// 学段顺序：小学 → 初中(中学) → 高中 → 大学；五四学制紧跟在本学段之后（默认隐藏）
const STAGE_ORDER = ['小学', '初中', '中学', '高中', '大学'];
const SUBJECT_ORDER = ['数学', '语文', '英语'];

function normName(s) {
  return String(s || '')
    .replace(/　/g, ' ')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .trim();
}

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumber(text) {
  const s = String(text || '');
  const m = s.match(/([零〇一二两三四五六七八九十百]+)\s*(?:年级|册|学期)?/);
  if (!m) return 0;
  const t = m[1];
  if (t === '十') return 10;
  if (t === '百') return 100;
  if (t.includes('十')) {
    const [a, b] = t.split('十');
    return (CN_DIGIT[a] || 0) * 10 + (CN_DIGIT[b] || 0);
  }
  if (t.includes('百')) {
    const [a, b] = t.split('百');
    return (CN_DIGIT[a] || 0) * 100 + (b ? cnNumber(b) : 0);
  }
  return CN_DIGIT[t[0]] || 0;
}

function stageRank(name) {
  const n = normName(name);
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    if (n.includes(STAGE_ORDER[i])) return i;
  }
  return 50;
}
function is54(name) { return /五[•·.\-]?四/.test(normName(name)); }
function isExercise(name) { return /习题|练习|试卷|真题/.test(normName(name)); }
function isPeoples(name) { return /人教|人民教育|统编/.test(normName(name)); }
function subjectRank(name) {
  const n = normName(name);
  const i = SUBJECT_ORDER.findIndex((s) => n.includes(s));
  return i < 0 ? 50 : i;
}
function gradeRank(name) {
  const n = normName(name);
  if (/学生读本/.test(n)) return 99; // pseudo-grade folder, always last
  if (/高[一二三]/.test(n)) return 10 + cnNumber(n.replace(/^.*?高/, ''));
  const m = n.match(/([零〇一二两三四五六七八九十]+)年级/);
  if (m) return cnNumber(m[1]);
  // 大学课本常用「上册/下册」或书名，无年级
  return 0;
}
function volumeRank(name) {
  const n = normName(name);
  if (/上册/.test(n)) return 1;
  if (/中册/.test(n)) return 2;
  if (/下册/.test(n)) return 3;
  if (/全一册/.test(n)) return 4;
  return 0;
}
// 「第一册 / 第2单元 / 必修1」 style ordinals used by high-school books
function ordinalRank(name) {
  const n = normName(name);
  const m = n.match(/第\s*([零〇一二两三四五六七八九十]+|\d+)\s*(?:册|章|单元|课|部分)/);
  if (!m) return 0;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : cnNumber(m[1]);
}

// Returns a comparator for folder names at a given tree level.
// kind: 'stage' | 'subject' | 'version' | 'grade' | 'volume' | 'dir' | 'file'
function compareNodes(a, b) {
  // 习题/试卷类永远排在后面（任何层级都适用）
  const ea = isExercise(a.name) ? 1 : 0;
  const eb = isExercise(b.name) ? 1 : 0;
  if (ea !== eb) return ea - eb;

  if (a.kind === 'stage') {
    const ra = stageRank(a.name), rb = stageRank(b.name);
    if (ra !== rb) return ra - rb;
    // 五四学制排在本学段之后
    const sa = is54(a.name) ? 1 : 0, sb = is54(b.name) ? 1 : 0;
    if (sa !== sb) return sa - sb;
  }
  if (a.kind === 'subject') {
    const ra = subjectRank(a.name), rb = subjectRank(b.name);
    if (ra !== rb) return ra - rb;
  }
  if (a.kind === 'version') {
    const pa = isPeoples(a.name) ? 0 : 1, pb = isPeoples(b.name) ? 0 : 1;
    if (pa !== pb) return pa - pb;
  }
  if (a.kind === 'grade') {
    const ra = gradeRank(a.name), rb = gradeRank(b.name);
    if (ra !== rb) return ra - rb;
  }
  if (a.kind === 'volume') {
    const ra = volumeRank(a.name), rb = volumeRank(b.name);
    if (ra !== rb) return ra - rb;
  }
  // 数字优先按「一、二、三…」的中文数字语义排，其余按中文自然序
  const ga = gradeRank(a.name), gb = gradeRank(b.name);
  if (ga !== gb) return ga - gb;
  const va = volumeRank(a.name), vb = volumeRank(b.name);
  if (va !== vb) return va - vb;
  const oa = ordinalRank(a.name), ob = ordinalRank(b.name);
  if (oa !== ob) return oa - ob;
  return normName(a.name).localeCompare(normName(b.name), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function kindForDepth(depth) {
  return ['stage', 'subject', 'version', 'grade', 'volume'][depth] || 'dir';
}

function isHiddenThumb(name) {
  // Generated covers live next to the PDF as <same-name>.jpg. They are book
  // covers, not user documents, so never list them as browsable files.
  return false; // resolved against siblings in listDir
}

function resolveInRoot(root, rel) {
  if (!root) return null;
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  const normRoot = path.resolve(root);
  if (full !== normRoot && !full.startsWith(normRoot + path.sep)) return null;
  return full;
}

function relOf(root, full) {
  return path.relative(root, full).replace(/\\/g, '/');
}

function allowedExtensions(exts) {
  const list = Array.isArray(exts) && exts.length ? exts : DEFAULT_EXTS;
  const out = new Set();
  for (const e of list) {
    let x = String(e || '').trim().toLowerCase();
    if (!x) continue;
    if (!x.startsWith('.')) x = '.' + x;
    if (x === '.pdf') out.add('.pdf');
    else if (OPTIONAL_EXTS.includes(x)) out.add(x);
  }
  out.add('.pdf'); // PDF 永远显示
  return out;
}

function thumbPathFor(pdfFull) {
  return pdfFull.replace(/\.pdf$/i, '.jpg');
}
function thumbExists(pdfFull) {
  try { return fs.statSync(thumbPathFor(pdfFull)).size > 0; } catch { return false; }
}

function isGeneratedThumb(dirEntries, name) {
  if (!/\.(jpe?g|png)$/i.test(name)) return false;
  const stem = name.replace(/\.(jpe?g|png)$/i, '').toLowerCase();
  return dirEntries.some((n) => n.toLowerCase() === stem + '.pdf');
}

/**
 * List one directory.
 * opts: { root, exts, show54, includeFiles }
 */
function listDir(root, rel, opts = {}) {
  const full = resolveInRoot(root, rel);
  if (!full) return { error: 'bad_path' };
  let st;
  try { st = fs.statSync(full); } catch { return { error: 'not_found' }; }
  if (!st.isDirectory()) return { error: 'not_dir' };

  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch (e) { return { error: 'read_failed', detail: String(e.message || e) }; }
  const names = entries.map((e) => e.name);
  const allowed = allowedExtensions(opts.exts);
  const depth = String(rel || '').split('/').filter(Boolean).length;
  const kind = kindForDepth(depth);
  const nodes = [];

  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const childRel = relOf(root, path.join(full, ent.name));
    if (ent.isDirectory()) {
      if (ent.name.endsWith('.pdf_merge_folder')) continue;
      let pdfCount = 0;
      try { pdfCount = countPdfs(path.join(full, ent.name), 2000); } catch { /* ignore */ }
      if (!pdfCount) continue; // folders without any PDF (or selected formats) are noise
      nodes.push({
        name: ent.name, path: childRel, type: 'dir', kind,
        pdf_count: pdfCount, depth,
        stage54: depth === 0 && is54(ent.name) ? 1 : 0,
      });
    } else {
      const ext = path.extname(ent.name).toLowerCase();
      if (isGeneratedThumb(names, ent.name)) continue;
      if (!allowed.has(ext) && ext !== '.pdf') continue;
      if (ext === '.pdf') {
        nodes.push({
          name: ent.name, path: childRel, type: 'pdf', kind: 'file', depth,
          title: ent.name.replace(/\.pdf$/i, ''),
          thumb: thumbExists(path.join(full, ent.name)),
        });
      } else if (allowed.has(ext)) {
        nodes.push({ name: ent.name, path: childRel, type: 'file', kind: 'file', depth, ext });
      }
    }
  }
  nodes.sort(compareNodes);
  // Publisher level: when 人教版/统编版 exists, everything else is collapsed into
  // one "其他版本" bucket in the UI. Mark the groups here so the client does not
  // have to re-implement the publisher matching.
  let grouped = false;
  if (kind === 'version') {
    const peoples = nodes.filter((n) => isPeoples(n.name));
    if (peoples.length) {
      grouped = true;
      for (const n of nodes) n.group = isPeoples(n.name) ? 'people' : 'other';
    }
  }
  return {
    path: String(rel || '').replace(/\\/g, '/'), kind, depth, nodes,
    version_grouped: grouped,
    other_versions: grouped ? nodes.filter((n) => n.group === 'other').length : 0,
  };
}

// Recursive PDF counts feed every directory listing, and the tree is ~2,000
// PDFs. A short TTL cache keeps browsing snappy without hiding newly added books
// for long (the UI has an explicit refresh that clears it).
const countCache = new Map(); // full dir -> { n, t }
const COUNT_TTL = 120 * 1000;
function countPdfs(dir, cap = 5000) {
  const hit = countCache.get(dir);
  const now = Date.now();
  if (hit && now - hit.t < COUNT_TTL) return hit.n;
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (e.name.endsWith('.pdf_merge_folder')) continue;
        stack.push(path.join(cur, e.name));
      } else if (PDF_RE.test(e.name)) n++;
    }
  }
  countCache.set(dir, { n, t: now });
  return n;
}
function clearCache() { countCache.clear(); }

// Recursively collect PDFs under one directory, in tree order.
// Used by the cover grid ("show every textbook below this folder").
function collectPdfs(root, rel, opts = {}, limit = 600) {
  const out = [];
  const walk = (r, depth) => {
    if (out.length >= limit) return;
    const d = listDir(root, r, { ...opts, includeFiles: true });
    if (d.error) return;
    for (const n of d.nodes) {
      if (out.length >= limit) return;
      if (n.type === 'pdf') {
        out.push({
          path: n.path, name: n.name, title: n.title, thumb: n.thumb,
          stage: String(n.path).split('/')[0] || '',
        });
      } else if (n.type === 'dir' && depth < 8) {
        walk(n.path, depth + 1);
      }
    }
  };
  walk(String(rel || ''), 0);
  return out;
}

module.exports = {
  DEFAULT_EXTS, OPTIONAL_EXTS, PDF_RE, IMG_RE, OFFICE_RE,
  resolveInRoot, relOf, allowedExtensions, listDir, collectPdfs, countPdfs, clearCache,
  thumbPathFor, thumbExists, compareNodes, gradeRank, volumeRank, ordinalRank,
  is54, isExercise, isPeoples, stageRank, subjectRank, normName,
};
