// HA states 缓存「补丁保鲜饿死全量重拉」事故的回归测试（v1.16.12）。
//
// 事故（2026-10-14 生产，设备页 18/103 台）：getStates 的 10s TTL 本意是定期全量重拉
// /api/states，但每条 WS state_changed 都刷 statesCache.at——家里 2000+ 实体状态事件
// 几秒一条，TTL 永不过期，全量重拉从初始快照后一次都没发生；初始快照恰好取在 HA 半程
// （只有零头），页面就永远停在残缺名单上靠事件滴灌缓慢生长。
//
// 本测试起一个手写假 HA（REST + 裸 WS 协议：auth_required→auth→auth_ok→subscribe_events），
// 第一次 /api/states 只回 3 个实体（模拟半程），之后高频推 state_changed（模拟事故里的
// 保鲜源），验证：① 硬上限内补丁即时效（不滥用重拉）② 超过硬上限后无视补丁强制全量
// 重拉（旧代码在此必挂：statesCalls 恒为 1）③ HA 拉不动时旧快照优雅顶住不整页报错
// ④ ?fresh=1 强拉通道不受影响。
// 用法：node scripts/e2e-ha-statessync.mjs（硬上限经 env 缩到 3s，必须在 startServer 前设置）
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, login, api } from './_noteE2E.mjs';

process.env.HA_STATES_HARD_TTL_MS = '3000'; // 服务端子进程经 env 透传读到（_noteE2E 会 spread process.env）

let pass = 0, fail = 0;
const ck = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : '   <<< ' + extra}`); };

// ---------- 手写假 HA：REST + WS ----------
const st = (entity_id, name) => ({ entity_id, state: 'on', attributes: { friendly_name: name || entity_id }, last_changed: new Date().toISOString() });
const PARTIAL = [st('switch.p1'), st('sensor.p2'), st('light.p3')];
const FULL = [...PARTIAL, st('light.full_1'), st('switch.full_2'), st('sensor.full_3'), st('cover.full_4'), st('fan.full_5'), st('climate.full_6'), st('button.full_7')];
let statesCalls = 0, restFail = false, extraLater = [];

const conns = []; // { pushEvent }
let patchSeq = 0;
const haSrv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/states')) {
    statesCalls++;
    if (restFail) { res.writeHead(500); res.end('boom'); return; }
    const list = statesCalls === 1 ? PARTIAL : FULL.concat(extraLater);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ version: '2026.10.0-test', location_name: '测试之家' }));
});
function sendFrame(socket, obj) {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : (() => { const b = Buffer.alloc(4); b[0] = 0x81; b[1] = 126; b.writeUInt16BE(p.length, 2); return b; })();
  socket.write(Buffer.concat([h, p]));
}
haSrv.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  socket.on('error', () => { /* 对端被杀（SIGKILL 拆卸）时的 ECONNRESET 属正常 */ });
  let subId = null;
  const conn = { pushEvent: (data) => { if (subId != null) sendFrame(socket, { id: subId, type: 'event', event: { event_type: 'state_changed', data } }); } };
  conns.push(conn);
  sendFrame(socket, { type: 'auth_required' });
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let p = buf.subarray(off, off + len);
      if (mask) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = p[i] ^ mask[i % 4]; p = out; }
      buf = buf.subarray(off + len);
      if (op !== 1) continue;
      let m; try { m = JSON.parse(p.toString('utf8')); } catch { continue; }
      if (m.type === 'auth') { sendFrame(socket, { type: 'auth_ok', ha_version: '2026.10.0-test' }); continue; }
      if (m.type === 'subscribe_events') { subId = m.id; sendFrame(socket, { id: m.id, type: 'result', success: true, result: null }); continue; }
      if (String(m.type).startsWith('config/')) { sendFrame(socket, { id: m.id, type: 'result', success: true, result: [] }); continue; }
      sendFrame(socket, { id: m.id, type: 'result', success: true, result: null });
    }
  });
});

await new Promise((r) => haSrv.listen(0, '127.0.0.1', r));
const HA = 'http://127.0.0.1:' + haSrv.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = await startServer({ tag: 'statessync', port: 3197 });
const A = api(S.B, (await login(S.B, 'admin', 'test123456')).H);
try {
  const pc = await A.put('/ha/config', { url: HA, token: 'stub-token' });
  ck('① 写入 HA 连接配置（指向假 HA）', pc.status === 200 && pc.body.has_token === true, JSON.stringify(pc.body).slice(0, 120));

  const e1 = await A.get('/ha/entities');
  const ids1 = new Set((e1.body.entities || []).map((x) => x.entity_id));
  ck('② 首次名单=初始快照（3 个，模拟 HA 半程）', e1.status === 200 && ids1.size === 3 && ids1.has('switch.p1'), `entities=${ids1.size} statesCalls=${statesCalls}`);

  // 事故复刻：高频 state_changed（每 250ms 一个「新」实体）——旧代码里这就是把 TTL 保鲜到永不过期的元凶
  const pusher = setInterval(() => {
    patchSeq++;
    for (const c of conns) c.pushEvent({ entity_id: 'switch.ws_patch_' + patchSeq, new_state: st('switch.ws_patch_' + patchSeq) });
  }, 250);

  await sleep(1500);
  const e2 = await A.get('/ha/entities');
  const ids2 = new Set((e2.body.entities || []).map((x) => x.entity_id));
  ck('③ 硬上限内：WS 补丁即时效（新实体已在名单）', ids2.has('switch.ws_patch_1') && ids2.has('switch.ws_patch_3'), `patch 实体数=${[...ids2].filter((i) => i.startsWith('switch.ws_patch_')).length}`);
  ck('④ 硬上限内：不滥用全量重拉（statesCalls 仍=1）', statesCalls === 1, `statesCalls=${statesCalls}`);

  await sleep(2200); // 累计 3.7s > 硬上限 3s
  const e3 = await A.get('/ha/entities');
  const ids3 = new Set((e3.body.entities || []).map((x) => x.entity_id));
  ck('⑤ 超硬上限：无视补丁强制全量重拉（statesCalls≥2）', statesCalls >= 2, `statesCalls=${statesCalls}`);
  ck('⑥ 全量名单回来了（full_1~full_7 都在）', ['light.full_1', 'switch.full_2', 'climate.full_6', 'button.full_7'].every((i) => ids3.has(i)), `entities=${ids3.size}`);

  // HA 拉不动：旧快照优雅顶住（200 + 残留名单），而不是整页 503
  restFail = true;
  const callsBefore = statesCalls;
  await sleep(3500);
  const e4 = await A.get('/ha/entities');
  const ids4 = new Set((e4.body.entities || []).map((x) => x.entity_id));
  ck('⑦ HA 500 时旧快照顶住（200 且 full 名单仍在）', e4.status === 200 && ids4.has('light.full_1'), `HTTP ${e4.status}`);
  ck('⑧ 失败后仍按节奏重试过（statesCalls 增加）', statesCalls > callsBefore, `${callsBefore}→${statesCalls}`);

  clearInterval(pusher);
  restFail = false; extraLater = [st('button.extra_1')];
  const e5 = await A.get('/ha/entities?fresh=1');
  const ids5 = new Set((e5.body.entities || []).map((x) => x.entity_id));
  ck('⑨ ?fresh=1 强拉通道不受影响（extra_1 在）', e5.status === 200 && ids5.has('button.extra_1'), `HTTP ${e5.status}`);
} catch (e) {
  ck('检查跑完（异常中断算失败）', false, e.message);
} finally {
  S.stop();
  haSrv.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
