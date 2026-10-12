// 电脑监控 ↔ 兑现登记「处罚标准」联动（v1.13.5；记账口径 v1.13.12 改为正数）——服务端全链路集成测试
//
// 覆盖用户提的需求：
//   ① 命中预警关键词 → 在【兑现登记】的兑现流水里加一笔【处罚扣款】，备注 =《预警违法电脑使用规定，扣减X元》
//      +「根据处罚标准本次扣减X元，已经实时记入赚钱结算金额中。如有再犯随时增加处罚额度。」+ AI 分析原文
//   ② 「处罚标准」按【电脑名称】【扣哪个成员】【推给哪些成员（短消息）】逐台配置
//   ③ **金额记正数**（v1.13.12 起；原先记负数，等于把钱加回去）——处罚行靠备注抬头区分，行里带 kind='penalty'
//   ④ 待兑现 = 应得 − 已兑现 − 处罚扣款 − 已赊账
//   ⑤ 命中但「预警推送给」为空也要罚（不能因为没配预警推送就静默失效）
//
// 视觉模型用本机 stub 顶替（真 AI 不可控）：stub 返回固定概括文本，命中/不命中由改文本控制。
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）。
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';

const PORT = 3197;
const STUB_PORT = 3198;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-penalty-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 25000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// ---------- 假视觉模型 ----------
let visionText = '孩子在浏览器打开 4399 小游戏网站在玩游戏，标签页标题：4399小游戏大全。';
const stubSeen = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    stubSeen.push({ url: req.url, auth: req.headers.authorization || '', body: raw });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: visionText } }], usage: { total_tokens: 123 } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));

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
// 假截图（远程分片上报走 multipart）
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 0x41)]);
async function uploadShot(devId, key) {
  const fd = new FormData();
  fd.append('id', devId);
  fd.append('key', key);
  fd.append('computer', '测试机');
  fd.append('shot', new Blob([JPG], { type: 'image/jpeg' }), 'shot.jpg');
  const r = await fetch(`${B}/api/monitor/agent/shot`, { method: 'POST', body: fd });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const monthNow = () => new Date().toLocaleDateString('sv').slice(0, 7);
const sum = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;

const cleanup = () => { try { server.kill(); } catch {} try { stub.close(); } catch {} };
process.on('exit', cleanup);

try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  const ADMIN = (lg.j.user || lg.j.u || {}).id || 1;
  ok(!!T, 'admin 登录拿到 token');

  // 视觉模型指到本机 stub（ai_config 默认共享 → 落主库，monitorService 读的正是主库那份）
  const ai = await api('POST', '/api/ai/config', {
    token: T,
    body: { model: 'stub', base_url: `http://127.0.0.1:${STUB_PORT}/v1`, api_key: 'mainkey', vision_model: 'stub-v', vision_base_url: `http://127.0.0.1:${STUB_PORT}/v1`, vision_api_key: 'test-vkey' },
  });
  ok(ai.status === 200, 'AI 视觉模型配置到本机 stub');

  const kid = await api('POST', '/api/users', { token: T, body: { username: 'kid', password: 'kid123456', role: 'user', display_name: '小明' } });
  const KID = kid.j.id;
  ok(!!KID, '建成员「小明」');

  // ---------- 监控全局配置：AI 开、每 1 张分析、关键字「游戏」、预警推送给【故意留空】、冷却 0 ----------
  const mc = await api('PUT', '/api/monitor/settings', {
    token: T,
    body: { ai_enabled: 1, ai_every: 1, keywords: '游戏', alert_users: [], alert_cooldown: 0 },
  });
  const KEY = mc.j.access_key;
  ok(mc.j.ai_enabled === 1 && mc.j.ai_every === 1 && KEY && mc.j.alert_users.length === 0, '监控配置：AI 开 / 每 1 张 / 关键字=游戏 / 预警推送给为空');

  // ---------- 两台监控电脑 ----------
  for (const [id, name] of [['testdev01', '孩子电脑'], ['testdev02', '书房电脑']]) {
    const r = await api('GET', `/api/monitor/agent/config?id=${id}&key=${KEY}&computer=${name}`);
    if (r.status !== 200) throw new Error(`建设备 ${id} 失败: ${JSON.stringify(r.j)}`);
    await api('PUT', `/api/monitor/devices/${id}`, { token: T, body: { name } });
  }
  const devs = await api('GET', '/api/monitor/devices', { token: T });
  ok(devs.j.devices.length === 2 && devs.j.devices.some((d) => d.name === '孩子电脑'), '设备清单两台，名称已改成「孩子电脑」');

  // ---------- 处罚标准：规则清单 ----------
  console.log('— 处罚标准配置（归一化 / 无效规则丢弃）');
  let p = await api('GET', '/api/typing/payouts/penalty', { token: T });
  ok(p.status === 200 && p.j.rules.length === 0 && p.j.enabled === true && p.j.devices.length === 2 && p.j.users.length === 2,
    '初始：无规则、默认启用、设备/成员清单随配置一起下发');

  p = await api('PUT', '/api/typing/payouts/penalty', {
    token: T,
    body: {
      enabled: true,
      rules: [
        { device_id: 'testdev01', amount: 5.5, deduct_user_id: ADMIN, push_user_ids: [KID, ADMIN, KID] },
        { device_id: 'testdev02', amount: 3, deduct_user_id: KID, push_user_ids: [ADMIN] },
        { device_id: 'nope-device', amount: 9, deduct_user_id: KID, push_user_ids: [] },   // 设备不存在 → 丢
        { device_id: 'testdev01', amount: 9, deduct_user_id: 99999, push_user_ids: [] },    // 成员不存在 → 丢
        { device_id: 'testdev01', amount: 0, deduct_user_id: KID, push_user_ids: [] },      // 金额 0 → 丢
      ],
    },
  });
  ok(p.j.rules.length === 2, '无效规则（设备不存在 / 成员不存在 / 金额 0）被丢弃，只剩 2 条');
  ok(p.j.rules[0].amount === 5.5 && p.j.rules[0].deduct_user_id === ADMIN, '第 1 条：孩子电脑 每次扣 5.5 → 扣 admin');
  ok(JSON.stringify(p.j.rules[0].push_user_ids) === JSON.stringify([KID, ADMIN]), '推送成员去重成 [小明, admin]');
  ok(p.j.rules[0].id === 1 && p.j.rules[1].id === 2, '规则带序号 id（前端 key 用）');

  // 金额/设备 落库口径：GET 回读一致
  p = await api('GET', '/api/typing/payouts/penalty', { token: T });
  ok(p.j.rules.length === 2 && p.j.rules[1].device_id === 'testdev02' && p.j.rules[1].amount === 3, 'PUT 后回读一致');

  // ---------- ① 命中关键字 → 正数处罚扣款 + 短消息 ----------
  console.log('— 命中预警 → 自动扣款 + 短消息');
  const up1 = await uploadShot('testdev01', KEY);
  ok(up1.status === 200 && up1.j.ok, '上报截图（孩子电脑）');
  const shot1 = await waitFor(async () => {
    const r = await api('GET', '/api/monitor/shots?device_id=testdev01&page=1&page_size=5', { token: T });
    const it = (r.j.items || []).find((x) => x.id === up1.j.id);
    return it && it.ai_text ? it : null;
  });
  ok(!!shot1 && shot1.ai_text.includes('4399'), `截图 AI 概括落库（stub 文本）`);
  ok(stubSeen.length >= 1 && stubSeen[0].auth === 'Bearer test-vkey', 'describeShot 用的是 vision_* 那套配置（Bearer test-vkey）');
  ok(stubSeen.length >= 1 && /data:image\/jpeg;base64,/.test(stubSeen[0].body), '截图以 data:image/jpeg;base64 送进视觉模型');
  ok(shot1 && shot1.alert_hit === 1, '命中的截图打上 alert_hit=1（永久保留）');

  const rows1 = await waitFor(async () => {
    const r = await api('GET', '/api/typing/payouts', { token: T });
    const pen = (r.j || []).filter((x) => x.kind === 'penalty');
    return pen.length ? r.j : null;
  });
  ok(!!rows1, '兑现流水里出现处罚行（kind=penalty）');
  const pen1 = (rows1 || []).filter((x) => x.kind === 'penalty')[0];
  const EXP1 = '《预警违法电脑使用规定，扣减5.5元》根据处罚标准本次扣减5.5元，已经实时记入赚钱结算金额中。如有再犯随时增加处罚额度。';
  ok(!!pen1 && pen1.amount === 5.5, '金额 = 5.5（正数：一行就是「从应兑换金额里扣掉 5.5」）');
  ok(!!pen1 && pen1.note.startsWith(EXP1), '备注前两段与需求原文逐字一致');
  ok(!!pen1 && pen1.note.includes('4399小游戏') && pen1.note === EXP1 + visionText.trim(), '备注第三段 = AI 分析原文，整条无多余字符');
  ok(!!pen1 && pen1.period === monthNow(), '记账月份 = 触发当月');
  ok(!!pen1 && pen1.created_by === ADMIN && pen1.created_by_name && pen1.user_id === ADMIN, '记录归属（扣 admin，登记人 admin）');
  ok((rows1 || []).filter((x) => x.kind === 'penalty').length === 1, '同样的规则只登记一笔（没有重复扣款）');
  ok((rows1 || []).filter((x) => x.kind === 'penalty').every((x) => x.amount > 0), '处罚行金额一律为正（不再有负数行）');

  // 短消息：推给 [小明, admin] 两个人，用 admin 的会话各看一次
  const msgKid = await api('GET', `/api/messages?user_id=${KID}`, { token: T });
  const m1 = (msgKid.j.messages || []).find((m) => String(m.subject || '').includes('电脑监控处罚'));
  ok(!!m1 && m1.from_user === ADMIN && m1.to_user === KID, '推给成员「小明」的短消息到了');
  ok(!!m1 && String(m1.content).includes('《预警违法电脑使用规定，扣减5.5元》') && String(m1.content).includes('孩子电脑'), '短消息正文含备注原文 + 电脑名称');
  const msgSelf = await api('GET', `/api/messages?user_id=${ADMIN}`, { token: T });
  ok((msgSelf.j.messages || []).some((m) => String(m.subject || '').includes('电脑监控处罚')), '推给 admin 本人的那条也在（多推送对象生效）');
  ok((msgKid.j.messages || []).filter((m) => String(m.subject || '').includes('电脑监控处罚')).length === 1, '重复填的推送成员不会重复发（去重）');
  // 「预警推送给」为空时不该有预警消息（本轮告警只走处罚联动）
  ok(!(msgKid.j.messages || []).some((m) => String(m.subject || '').includes('电脑监控预警')), '预警推送给为空 → 不发预警消息，但仍完成打标 + 扣款');

  // ---------- ② 第二台电脑 / 第二个成员 ----------
  console.log('— 第二台电脑串到另一个成员的账');
  const up2 = await uploadShot('testdev02', KEY);
  await waitFor(async () => {
    const r = await api('GET', '/api/monitor/shots?device_id=testdev02&page=1&page_size=5', { token: T });
    const it = (r.j.items || []).find((x) => x.id === up2.j.id);
    return it && it.ai_text ? it : null;
  });
  const kids = await waitFor(async () => {
    const r = await api('GET', '/api/typing/payouts', { token: T });
    const mine = (r.j || []).filter((x) => x.user_id === KID);
    return mine.length ? mine : null;
  });
  ok(!!kids && kids[0].amount === 3, '小明那笔 = +3（按设备命中自己的规则）');
  ok(sum(kids || []) === 3, '小明流水合计 = 3（这一列是「被扣掉多少」，所以随处罚变大）');
  ok(sum((rows1 || []).filter((x) => x.user_id === ADMIN)) === 5.5, 'admin 流水合计 = 5.5');
  const kidMsgs = await api('GET', `/api/messages?user_id=${ADMIN}`, { token: T });
  ok((kidMsgs.j.messages || []).some((m) => String(m.subject || '').includes('扣减 3 元')), '第二笔的短消息（扣减 3 元）也发了');

  // 手工登记的普通兑现行必须落成 kind='payout'（前端就靠这个字段区分「处罚」标记，别再靠金额正负）
  await api('POST', '/api/typing/payouts', { token: T, body: { user_id: KID, period: monthNow(), amount: 4, note: '微信转账' } });
  const mixed = await api('GET', '/api/typing/payouts', { token: T });
  const kid4 = (mixed.j || []).find((x) => x.user_id === KID && x.amount === 4);
  ok(!!kid4 && kid4.kind === 'payout' && !kid4.note.startsWith('《预警'), '普通兑现行 kind=payout，处罚行 kind=penalty（同一张流水并存）');

  // ---------- ③ 待兑现口径：应得 − 已兑现 − 处罚 − 已赊账 ----------
  console.log('— 待兑现口径');
  const rate = await api('PUT', '/api/typing/config', { token: T, body: { reward_chars: 1, reward_yuan: 1 } });
  ok(rate.status === 200, '费率改成 1 字 = 1 元（便于验算）');
  await api('POST', '/api/typing/progress', { token: T, body: { correct: 20, wrong: 0, seconds: 60 } }); // admin 赚 20 元
  const pv = await api('GET', `/api/typing/payouts/preview?user_id=${ADMIN}&month=${monthNow()}`, { token: T });
  ok(pv.j.earned === 20, 'admin 本月应得 20 元');
  ok(pv.j.paid === 0 && pv.j.penalty === 5.5, '已兑现 = 0；处罚扣款单列 = 5.5（处罚行没被算进「已兑现」）');
  ok(pv.j.pending === 14.5, '待兑现 = 20 − 0 − 5.5 − 0 = 14.5');
  const pv2 = await api('GET', `/api/typing/payouts/preview?user_id=${KID}&month=${monthNow()}`, { token: T });
  ok(pv2.j.earned === 0 && pv2.j.penalty === 3 && pv2.j.pending === 0, '小明：应得 0、处罚 3、待兑现不为负数（=0）');
  const sm = await api('GET', `/api/typing/summary?user_id=${ADMIN}`, { token: T });
  ok(sm.j.totals.penalty === 5.5 && sm.j.totals.pending === 14.5 && sm.j.totals.paid === 0, '赚钱日历合计同样口径（penalty/pending/paid）');
  const sm2 = await api('GET', `/api/typing/summary?user_id=${KID}`, { token: T });
  ok(sm2.j.totals.penalty === 3 && sm2.j.totals.pending === 0, '小明日历：处罚 3、待兑现 0');

  // ---------- ④ 开关关掉 → 不再扣款 ----------
  console.log('— 关掉处罚标准');
  await api('PUT', '/api/typing/payouts/penalty', { token: T, body: { enabled: false, rules: p.j.rules } });
  const up3 = await uploadShot('testdev01', KEY);
  await waitFor(async () => {
    const r = await api('GET', '/api/monitor/shots?device_id=testdev01&page=1&page_size=5', { token: T });
    const it = (r.j.items || []).find((x) => x.id === up3.j.id);
    return it && it.ai_text ? it : null;
  });
  await sleep(500); // 给同步登记留出余量
  let rows = await api('GET', '/api/typing/payouts', { token: T });
  ok(rows.j.filter((x) => x.kind === 'penalty').length === 2, '关闭后命中关键字不再产生扣款（仍是 2 笔）');

  // 不带 enabled 的 PUT 不把开关偷偷打开
  const p3 = await api('PUT', '/api/typing/payouts/penalty', { token: T, body: { rules: p.j.rules } });
  ok(p3.j.enabled === false, 'PUT 不带 enabled 时保持原值（不会偷偷启用）');

  // ---------- ⑤ 不命中关键字 / 关掉 AI ----------
  console.log('— 不命中 vs 关键字不在文本里');
  visionText = '孩子在用 Word 写作业，屏幕上是作文文档，浏览器未打开。';
  await api('PUT', '/api/typing/payouts/penalty', { token: T, body: { enabled: true, rules: p.j.rules } });
  const up4 = await uploadShot('testdev01', KEY);
  const shot4 = await waitFor(async () => {
    const r = await api('GET', '/api/monitor/shots?device_id=testdev01&page=1&page_size=5', { token: T });
    const it = (r.j.items || []).find((x) => x.id === up4.j.id);
    return it && it.ai_text ? it : null;
  });
  await sleep(500);
  rows = await api('GET', '/api/typing/payouts', { token: T });
  ok(rows.j.filter((x) => x.kind === 'penalty').length === 2, '文本不含关键字 → 不扣款（仍 2 笔）');
  ok(!!shot4 && shot4.alert_hit === 0, '未命中的截图 alert_hit 保持 0（照常按保留期清理）');

  // 关键字清空 → 连打标都不该发生
  await api('PUT', '/api/monitor/settings', { token: T, body: { keywords: [] } });
  visionText = '孩子在玩游戏。';
  const up5 = await uploadShot('testdev01', KEY);
  const shot5 = await waitFor(async () => {
    const r = await api('GET', '/api/monitor/shots?device_id=testdev01&page=1&page_size=5', { token: T });
    const it = (r.j.items || []).find((x) => x.id === up5.j.id);
    return it && it.ai_text ? it : null;
  });
  rows = await api('GET', '/api/typing/payouts', { token: T });
  ok(rows.j.filter((x) => x.kind === 'penalty').length === 2, '关键字清空 → 不扣款');
  ok(!!shot5 && shot5.alert_hit === 0, '关键字清空 → 不打 alert_hit');

  // ---------- ⑥ 权限：处罚标准归「兑现登记」受限 tab ----------
  console.log('— 权限');
  const kidLogin = await api('POST', '/api/auth/login', { body: { username: 'kid', password: 'kid123456' } });
  const KT = kidLogin.j.b?.token || kidLogin.j.token;
  const kidGet = await api('GET', '/api/typing/payouts/penalty', { token: KT });
  const kidPut = await api('PUT', '/api/typing/payouts/penalty', { token: KT, body: { enabled: true, rules: [] } });
  ok(kidGet.status === 403 && kidPut.status === 403, '普通成员改不了处罚标准（403）');
  const stillTwo = await api('GET', '/api/typing/payouts/penalty', { token: T });
  ok(stillTwo.j.rules.length === 2, '被拒的 PUT 没改到配置（规则仍 2 条）');

  console.log(`\n${failed ? '✗' : '✓'} 通过 ${passed} / 失败 ${failed}`);
} catch (e) {
  failed++;
  console.error('测试异常：', e && e.stack || e);
} finally {
  cleanup();
  await sleep(200);
  process.exit(failed ? 1 : 0);
}
