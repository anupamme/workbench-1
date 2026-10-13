// 家庭事项「从推送副本找回」的本地验证（隔离 DATA_DIR + 隔离端口，绝不碰 data/workbench.sqlite）。
//
// 复刻线上症状：条目登记时勾了推送 → messages 留下整份原文副本；随后条目行被删除（图片行还在），
// 通知列表变空。断言恢复端点能把内容拼回来、把没人引用的图片聚簇成「找回的图片」条目，
// 且严格只增不删（现有条目一条不动）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3123;
const DATA = path.join(ROOT, 'data', `tmp-recover-family-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : '  <<< ' + String(extra).slice(0, 220)}`); };

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* 已退 */ } });

const B = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${B}/api/health`)).ok) { up = true; break; } } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!up) { console.error('服务器启动超时'); process.exit(1); }

const lr = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
const lj = await lr.json();
if (!lj.token) { console.error('登录失败', JSON.stringify(lj)); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lj.token };
const jget = async (u) => (await fetch(B + u, { headers: H })).json();
const jpost = async (u, b) => (await fetch(B + u, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
const jdel = async (u) => (await fetch(B + u, { method: 'DELETE', headers: H })).json();

// 1×1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const upImg = async () => (await jpost('/api/family-images', { data: 'data:image/png;base64,' + PNG })).id;

// —— 造数据：3 条带图并勾推送（其中一条追加两张图当「正文里的图」），1 条不勾推送（不可复原），2 张孤儿图 ——
const im1 = await upImg(), im2 = await upImg(), im3 = await upImg();
const orphan1 = await upImg(), orphan2 = await upImg();
const me = (await jget('/api/auth/me'));
const myId = me.id || me.user?.id || 1;

const titleA = `今天作业<img src="/api/family-images/${im1}">`;
const idA = (await jpost('/api/family', { title: titleA, desc: '语文抄写三遍', item_date: '2026-09-01', status: 'todo', notify_users: [myId] })).id;
const idB = (await jpost('/api/family', { title: `买牛奶<img src="/api/family-images/${im2}">`, desc: '', item_date: '2026-09-02', status: 'done', notify_users: [myId] })).id;
const titleC = `班级通知<img src="/api/family-images/${im3}">\n<img src="/api/family-images/${orphan1}">`;
const idC = (await jpost('/api/family', { title: titleC, desc: '周五家长会', item_date: '2026-09-03', status: 'todo', notify_users: [myId] })).id;
const idD = (await jpost('/api/family', { title: '没勾推送的一条', desc: '正文只剩在库里了', item_date: '2026-09-04', status: 'todo' })).id;
const before = await jget('/api/family');
ck('① 造出 4 条家庭事项', before.length === 4, `实际 ${before.length}`);

// —— 复刻「条目行被删除」（走 UI 同一条 DELETE，图片行不受影响） ——
for (const id of [idA, idB, idC, idD]) await jdel('/api/family/' + id);
const afterDel = await jget('/api/family');
ck('② 删除后通知列表为空（图片行仍在）', afterDel.length === 0, `实际 ${afterDel.length}`);

// —— 干跑：只报数不写库 ——
const dry = await jpost('/api/dbdiag/recover-family', {});
ck('③ 干跑默认 dry=true', dry.dry === true, JSON.stringify(dry).slice(0, 200));
ck('④ 干跑认出 3 条可复原（不勾推送的那条不可复原）', dry.items_recoverable === 3 && dry.will_insert === 3, JSON.stringify({ rec: dry.items_recoverable, ins: dry.will_insert }));
ck('⑤ 干跑不写库（列表仍为空）', (await jget('/api/family')).length === 0, '');
ck('⑥ 干跑报出孤儿图片 = 1（只有 orphan2 没人引用；orphan1 在可复原条目 C 的正文里）', dry.images_orphan === 1, JSON.stringify({ orphan: dry.images_orphan, groups: dry.orphan_groups }));

// —— 真恢复 ——
const rec = await jpost('/api/dbdiag/recover-family', { confirm: 'RECOVER' });
ck('⑦ 真恢复 inserted=3', rec.inserted === 3, JSON.stringify(rec).slice(0, 260));
ck('⑧ 孤儿图片聚成 1 条找回条目', rec.gallery_items === 1 && rec.gallery_images === 1, JSON.stringify({ gi: rec.gallery_items, gim: rec.gallery_images }));

const list = await jget('/api/family');
const byId = Object.fromEntries(list.map((r) => [r.id, r]));
ck('⑨ 列表恢复出 3 条原文 + 1 条找回图片', list.length === 4, `实际 ${list.length}`);
ck('⑩ id 与原文一致（id 保留 → 推送消息里的引用对得上）',
  byId[idA] && byId[idA].title.includes(`/api/family-images/${im1}`) && byId[idA].desc === '语文抄写三遍' && byId[idA].item_date === '2026-09-01',
  JSON.stringify(byId[idA] || {}).slice(0, 200));
ck('⑪ 无 desc 的那条不残留换行/日期行',
  byId[idB] && byId[idB].desc === '' && byId[idB].item_date === '2026-09-02', JSON.stringify(byId[idB] || {}).slice(0, 200));
ck('⑫ 正文里追加的图片（orphan1）连同标题图一起回到条目里',
  byId[idC] && byId[idC].title.includes(`/api/family-images/${im3}`) && byId[idC].title.includes(`/api/family-images/${orphan1}`), JSON.stringify(byId[idC] || {}).slice(0, 240));
const gal = list.find((r) => r.title.startsWith('找回的图片'));
ck('⑬ 找回图片条目里含 orphan2 的 <img>（图片能显示靠 title 走 v-html）',
  gal && gal.title.includes(`/api/family-images/${orphan2}`) && !/</.test(gal.title.replace(/<img[^>]*>/g, '')), JSON.stringify(gal || {}).slice(0, 240));
ck('⑭ 恢复的条目 status 一律 todo（勾选状态无法复原，如实置未完成）',
  list.filter((r) => r.id === idA || r.id === idB || r.id === idC).every((r) => r.status === 'todo'), '');

// —— 幂等 + 只增不删 ——
const rec2 = await jpost('/api/dbdiag/recover-family', { confirm: 'RECOVER' });
ck('⑮ 再恢复一次幂等：不再插入条目', rec2.inserted === 0 && rec2.will_insert === 0, JSON.stringify(rec2).slice(0, 200));
ck('⑯ 只增不删：重复恢复后仍是 4 条（不会重复堆「找回的图片」）', (await jget('/api/family')).length === 4, '');

// —— 权限：非管理员 403 ——
const noauth = await fetch(`${B}/api/dbdiag/recover-family`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ck('⑰ 未登录被拦（401 鉴权在前的 401 / 路由内的 403 都算）', noauth.status === 401 || noauth.status === 403, String(noauth.status));

// —— sqlite_sequence 判据（本用例中 family_items 计数器应为 4，删除后不回落，恢复不动它） ——
console.log('\n  说明：本用例里 family_items 的 sqlite_sequence 期望值 = 4（4 条插入过、删除不回落）。');

console.log(`\n${pass} 通过, ${fail} 失败`);
srv.kill('SIGKILL');
await sleep(1500); // 等子进程松手再删临时目录（否则 EPERM）
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 删不掉就留着，反正带时间戳不打架 */ }
if (fail) process.exitCode = 1;
