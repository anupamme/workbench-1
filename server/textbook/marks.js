// Annotation sidecar files.
//
// Marks are stored next to the PDF as `<name>.marks.json` so the notes travel
// with the book when the folder is copied. An empty annotation set deletes the
// file instead of leaving a zero-byte sidecar behind.
const fs = require('fs');
const path = require('path');

const SUFFIX = '.marks.json';

function sidecarPath(pdfFull) {
  return pdfFull.replace(/\.pdf$/i, '') + SUFFIX;
}

// One writer per file: rapid successive saves must not interleave read/write and
// lose strokes.
const queues = new Map();
function withLock(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

function emptyDoc(pdfRel) {
  return { version: 1, pdf: String(pdfRel || ''), updated_at: null, pages: {} };
}

function countStrokes(doc) {
  let n = 0;
  const pages = (doc && doc.pages) || {};
  for (const k of Object.keys(pages)) {
    const arr = pages[k];
    if (Array.isArray(arr)) n += arr.length;
  }
  return n;
}

async function readMarks(pdfFull, pdfRel) {
  const file = sidecarPath(pdfFull);
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return emptyDoc(pdfRel);
    if (!doc.pages || typeof doc.pages !== 'object') doc.pages = {};
    return doc;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyDoc(pdfRel);
    // A corrupt sidecar must not break reading. Keep it on disk for the user and
    // start from an empty page set rather than throwing.
    return { ...emptyDoc(pdfRel), corrupt: true };
  }
}

function sanitizePage(page) {
  const n = Number(page);
  if (!Number.isFinite(n) || n < 1 || n > 20000) return null;
  return String(Math.floor(n));
}

function sanitizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  const points = Array.isArray(s.points) ? s.points : null;
  if (!points || points.length < 1) return null;
  const pts = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
    if (pts.length >= 4000) break;
  }
  if (!pts.length) return null;
  const tool = String(s.tool || 'pen');
  const color = /^#[0-9a-fA-F]{3,8}$/.test(String(s.color || '')) ? s.color : '#e11d48';
  const width = Number.isFinite(Number(s.width)) ? Math.min(120, Math.max(0.5, Number(s.width))) : 2;
  const alpha = Number.isFinite(Number(s.alpha)) ? Math.min(1, Math.max(0.03, Number(s.alpha))) : 1;
  return {
    id: String(s.id || '').slice(0, 40) || Math.random().toString(36).slice(2, 10),
    tool, color, width, alpha, points: pts,
  };
}

function sanitizeDoc(body, pdfRel) {
  const pages = {};
  const src = (body && body.pages) || {};
  for (const key of Object.keys(src)) {
    const pg = sanitizePage(key);
    if (!pg) continue;
    const arr = Array.isArray(src[key]) ? src[key] : [];
    const out = [];
    for (const s of arr) {
      const st = sanitizeStroke(s);
      if (st) out.push(st);
      if (out.length >= 3000) break;
    }
    if (out.length) pages[pg] = out;
  }
  return { version: 1, pdf: String(pdfRel || ''), updated_at: new Date().toISOString(), pages };
}

/**
 * Replace the whole annotation document. Returns { saved, strokes, deleted }.
 * `deleted` is true when the new document is empty and the sidecar was removed.
 */
function writeMarks(pdfFull, pdfRel, body) {
  const file = sidecarPath(pdfFull);
  return withLock(file, async () => {
    const doc = sanitizeDoc(body, pdfRel);
    const strokes = countStrokes(doc);
    if (!strokes) {
      let deleted = false;
      try { await fs.promises.unlink(file); deleted = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { saved: true, strokes: 0, deleted };
    }
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(doc), 'utf8');
    await fs.promises.rename(tmp, file); // atomic on the same volume
    return { saved: true, strokes, deleted: false };
  });
}

module.exports = { SUFFIX, sidecarPath, readMarks, writeMarks, sanitizeDoc, countStrokes };
