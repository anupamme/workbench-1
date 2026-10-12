// 一次性订正测试（v1.13.12）：typing_payouts 里的【负数行】在启动时就地翻正。
//
// 为什么单独测：生产上正好有一行 -1（处罚记成负数），本次部署靠这条迁移把它改成正数——
// 迁移是「跑一次就上锁」（settings.typing_penalty_positive_v11312），写错/漏跑都不会有第二次机会，
// 所以必须真起三次服务：① 建库；② 造旧数据（含负数）后启动，看有没有翻正；③ 守卫上锁后再启动，确认不翻第二次。
//
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）。
import { spawn } from 'child_process';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3196;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-penmig-'));
const DB_FILE = path.join(DATA, 'workbench.sqlite');
const GUARD = 'typing_penalty_positive_v11312';
const PEN_PREFIX = '《预警违法电脑使用规定，扣减';

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
function start() {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
  return server;
}
async function stop() {
  if (!server) return;
  server.kill();
  for (let i = 0; i < 40; i++) { await sleep(200); if (server.exitCode !== null) break; }
  server = null;
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) return; } catch { /* 未起 */ }
    await sleep(500);
  }
  throw new Error('服务 60s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text() };
}
const monthNow = () => new Date().toLocaleDateString('sv').slice(0, 7);

const cleanup = () => { try { server && server.kill(); } catch { /* 已退 */ } };
process.on('exit', cleanup);

// 直接开库造「旧版留下」的数据：一行处罚负数（生产那一行就是它）+ 一条普通兑现 +
// 一条备注里没有处罚抬头的负数（这张表唯一的负数来源就是处罚联动，所以它也照翻正——验证迁移不看备注）
function seedLegacyRows(uid) {
  const d = new DatabaseSync(DB_FILE);
  const m = monthNow();
  d.prepare('INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)')
    .run(uid, m, -1, `${PEN_PREFIX}1元》根据处罚标准本次扣减1元，已经实时记入赚钱结算金额中。如有再犯随时增加处罚额度。`, uid);
  d.prepare('INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)')
    .run(uid, m, 12.5, '微信转账', uid);
  d.prepare('INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)')
    .run(uid, m, -3, '手工录错的行（备注不含处罚抬头）', uid);
  const rows = d.prepare('SELECT amount, note FROM typing_payouts ORDER BY id').all();
  d.close();
  return rows;
}
// 守卫上锁之后再塞两行（第 3 次启动用）：两行负数都不该再被翻（迁移只会跑一次，也不可能把已翻的正数翻回去）
function seedAfterLock(uid) {
  const d = new DatabaseSync(DB_FILE);
  const m = monthNow();
  d.prepare('INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)')
    .run(uid, m, -2, `${PEN_PREFIX}2元》手工补录的旧式负数行`, uid);
  d.prepare('INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)')
    .run(uid, m, -1.25, '手工补录的负数', uid);
  d.close();
}
function readRows() {
  const d = new DatabaseSync(DB_FILE);
  const rows = d.prepare('SELECT amount, note FROM typing_payouts ORDER BY id').all();
  const guard = d.prepare('SELECT value FROM settings WHERE key=?').get(GUARD);
  d.close();
  return { rows, guard: guard && guard.value };
}

try {
  // ---------- 第 1 次启动：让 db.js 建表 ----------
  start();
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  const ADMIN = (lg.j.user || lg.j.b?.user || {}).id || 1;
  ok(!!T && existsSync(DB_FILE), '第一次启动：库已建好');
  await stop();

  // ---------- 造旧版数据：先擦掉守卫（模拟「升级前的库」） ----------
  const seeded = seedLegacyRows(ADMIN);
  ok(seeded.length === 3 && seeded[0].amount === -1, '造出旧数据：处罚行 -1 / 普通兑现 12.5 / 一条非处罚负数 -3');
  {
    const d = new DatabaseSync(DB_FILE);
    d.prepare('DELETE FROM settings WHERE key=?').run(GUARD);
    d.close();
  }

  // ---------- 第 2 次启动：迁移把负数行全部翻正 ----------
  start();
  await waitReady();
  const after = readRows();
  ok(after.rows[0].amount === 1, '处罚负数行 -1 → +1（生产那唯一一行就是它）');
  ok(after.rows[0].note.startsWith(PEN_PREFIX), '翻正后备注原文一字未改（判据与展示都靠它）');
  ok(after.rows[1].amount === 12.5, '普通兑现行 12.5 未被动过');
  ok(after.rows[2].amount === 3, '判据只看 amount<0：备注不含处罚抬头的负数行也翻正（该表唯一的负数来源就是处罚联动，宁可翻全也不漏）');
  ok(!!after.guard, '守卫键已落 settings（同一库不会再跑第二次）');

  // 接口口径：那一笔现在算「处罚扣款」，不算「已兑现」
  const pv = await api('GET', `/api/typing/payouts/preview?user_id=${ADMIN}&month=${monthNow()}`, { token: T });
  ok(pv.j.penalty === 1 && pv.j.paid === 15.5, `预览口径：处罚扣款 = 1、已兑现 = 12.5 + 3（实得 ${pv.j.penalty}/${pv.j.paid}）`);
  const list = await api('GET', '/api/typing/payouts', { token: T });
  const pen = (list.j || []).find((x) => x.amount === 1);
  ok(!!pen && pen.kind === 'penalty', '列表里它被认成处罚行（kind=penalty）');
  ok((list.j || []).every((x) => Number(x.amount) > 0), '翻正后这张表里一条负数都没有了');

  // ---------- 第 3 次启动：守卫生效，不再二次翻 ----------
  await stop();
  seedAfterLock(ADMIN);
  start();
  await waitReady();
  const again = readRows();
  ok(again.rows.filter((r) => r.amount === -2).length === 1, '守卫已上锁：后补的负数处罚行不再自动翻正（迁移只跑一次）');
  ok(again.rows.filter((r) => r.amount === -1.25).length === 1, '后补的非处罚负数同样没动过');
  ok(again.rows.filter((r) => r.amount === 1).length === 1 && again.rows.filter((r) => r.amount === 3).length === 1,
    '已翻正的行没被再翻回去（守卫挡住第二次执行）');
  const list2 = await api('GET', '/api/typing/payouts', { token: T });
  const manual = (list2.j || []).find((x) => x.amount === -1.25);
  ok(!!manual && manual.kind === 'payout', '那条非处罚负数仍归 kind=payout（不会被当成处罚）');
  // 处罚桶按绝对值算：万一旧版又写进负数处罚行（回滚过一次、守卫已上锁不会再翻正），也只会是扣减、不会变成加钱。
  // 「已兑现」桶照直求和（这里人为塞的负数会把它拉低）——它就是一本「扣掉多少」的账，不额外造语义；
  // 只有「处罚」这一桶吃了 ABS，因为处罚在语义上永远是扣减（这正是用户报的那个「负数=加钱」的防线）。
  const pv3 = await api('GET', `/api/typing/payouts/preview?user_id=${ADMIN}&month=${monthNow()}`, { token: T });
  ok(pv3.j.penalty === 3, `负数的处罚行也按扣减算（处罚 = 1 + 2，那条非处罚负数不算进处罚桶）= ${pv3.j.penalty}`);

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', e && e.stack || e);
} finally {
  await stop();
  await sleep(200);
  process.exit(failed ? 1 : 0);
}
