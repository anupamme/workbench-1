// E2E（v1.14.0）：Home Assistant 接入全链。
//
// 自建一个**假 HA**（REST + 手写 WebSocket，127.0.0.1 临时端口），真起一个隔离 DATA_DIR 的
// 工作台服务器，逐段压：
//   A 连接配置/令牌（存取只回布尔、绝不回显）/ 测试连接 / 双地址故障转移 / 错令牌 401 定性——
//     401 不短路换地址（生产 2026-10-13 事故：内网地址误填成工作台自己，/api/ 同样回 401，
//     旧逻辑当场误判「令牌无效」且再不试第二个地址；新逻辑先换地址、全败才定性并点名地址）；
//   B 实体一览（区域归属链：ent.area_id > device.area_id > 未分区；可控/语音分档；degraded=false）；
//   C 快捷开关（call_service 落到假 HA + 回读 verified）；
//   D **语音链**：/dh/smarthome/command 命中 HA 设备（数字人那条）+ /xiaozhi/bridge 桥接
//     （贾维斯那条）list_devices/ping/control——三处都吃同一份合并设备表；
//   E 摄像头（JPEG 魔数）/ 历史 / 服务调试（管理员限定）；
//   F webhook 反调（EXEMPT 免登录、key 即凭证、错 key 403）+ SSE 实时流（hook 与 state 双事件）；
//   G 权限：没勾 ha 子 tab 的成员 403、勾了的可看不可改（PUT 403 / services 403 / is_admin=false /
//     hook_key 不下发）、未登录 401；
//   H pageForPath 单元断言（/ha 精确段匹配，不吞 /health）。
//
// 全程零 npm 依赖（升级链不跑 npm install——WS 帧收发手写，照 e2e-xiaozhi-voice 的先例）。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, api, checker, j } from './_noteE2E.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ck, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

// ---------- H. pageForPath 单元断言（懒 require + 临时 DATA_DIR，绝不碰真库） ----------
// ESM import 会提升到一切语句之前，所以用 createRequire 在设好 DATA_DIR 之后再加载 auth.js。
{
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-e2e-auth-'));
  const require2 = (await import('node:module')).createRequire(import.meta.url);
  const { pageForPath } = require2(path.join(ROOT, 'server/auth.js'));
  ck('H1 pageForPath("/ha") → smarthome', pageForPath('/ha') === 'smarthome');
  ck('H2 pageForPath("/ha/entities") → smarthome', pageForPath('/ha/entities') === 'smarthome');
  ck('H3 pageForPath("/health") 不被 /ha 前缀吞掉（EXEMPT 同形防冲突）', pageForPath('/health') !== 'smarthome');
  ck('H4 pageForPath("/harness") 不误中', pageForPath('/harness') !== 'smarthome');
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}

// ---------- 假 HA：REST + 手写 WebSocket ----------
const TOKEN = 'e2e-ha-token-abcdef0123456789';
const HA_PORT = 3181;
const HA_BASE = `http://127.0.0.1:${HA_PORT}`;
const nowIso = () => new Date().toISOString();

// 实体状态表（可变；服务调用会翻转 + 推 state_changed）
const ents = new Map(Object.entries({
  'light.ceiling': { state: 'on', attributes: { friendly_name: '客厅吊灯' } },
  'switch.wall': { state: 'off', attributes: { friendly_name: '墙壁开关' } },
  'climate.ac': { state: 'heat', attributes: { friendly_name: '空调', current_temperature: 21.5, current_humidity: 55 } },
  'sensor.temp': { state: '22', attributes: { friendly_name: '温度', unit_of_measurement: '°C' } },
  'sensor.humid': { state: '58', attributes: { friendly_name: '湿度', unit_of_measurement: '%' } },
  'camera.front': { state: 'idle', attributes: { friendly_name: '门口摄像头' } },
  'lock.door': { state: 'locked', attributes: { friendly_name: '大门' } },
}));
// dev1 带 name_by_user/manufacturer/model（v1.15.0 设备页「同一设备的实体框在一起」要展示这些）
const REGISTRY = {
  areas: [{ area_id: 'living_room', name: '客厅' }, { area_id: 'bedroom', name: '卧室' }],
  devices: [{ id: 'dev1', area_id: 'bedroom', name: '卧室套装', name_by_user: '卧室温控套件', manufacturer: '小米', model: '套装1代' }],
  entities: [
    { entity_id: 'light.ceiling', area_id: 'living_room' },
    { entity_id: 'switch.wall', device_id: 'dev1' },       // 实体级无区域 → 设备级（卧室）
    { entity_id: 'sensor.humid', device_id: 'dev1' },      // 同一设备的第二实体（设备卡合并两行）
    { entity_id: 'climate.ac', area_id: 'living_room' },
    { entity_id: 'sensor.temp', area_id: 'living_room' },
    // camera.front / lock.door：两级都无 → 未分区
  ],
};
const serviceCalls = [];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let wsSock = null;        // 当前 WS 连接（假 HA 只需要服务一根）
let wsSubId = 0;          // subscribe_events 的命令 id——推事件要用它
function wsSend(op, payload) {
  if (!wsSock || wsSock.destroyed) return;
  const data = Buffer.from(payload, 'utf8');
  console.log(`   [fake-ha] >> ${data.length}B ${payload.slice(0, 80)}`);
  let head;
  if (data.length < 126) head = Buffer.from([0x80 | op, data.length]);
  else { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  try { wsSock.write(Buffer.concat([head, data])); } catch { /* 已断 */ }
}
function setEntity(id, state) { // 翻状态 + （订阅已建立时）推 state_changed
  const e = ents.get(id);
  if (!e) return;
  const old = { entity_id: id, state: e.state, attributes: e.attributes, last_changed: nowIso() };
  e.state = state;
  if (wsSubId) {
    wsSend(0x1, JSON.stringify({ id: wsSubId, type: 'event', event: { event_type: 'state_changed', data: { entity_id: id, old_state: old, new_state: { entity_id: id, state: e.state, attributes: e.attributes, last_changed: nowIso() } } } }));
  }
}

const ha = http.createServer((req, res) => {
  const u = new URL(req.url, HA_BASE);
  if (!u.pathname.startsWith('/api/')) { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Unauthorized' }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let data = {}; try { data = body ? JSON.parse(body) : {}; } catch { /* 空包 */ }
    if (u.pathname === '/api/' || u.pathname === '/api') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'API running.' }));
    if (u.pathname === '/api/config') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: '2026.10.0-e2e', location_name: '测试之家' }));
    if (u.pathname === '/api/states') {
      const list = [...ents.entries()].map(([entity_id, e]) => ({ entity_id, state: e.state, attributes: e.attributes, last_changed: nowIso() }));
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
    }
    const st = u.pathname.match(/^\/api\/states\/([\w.-]+)$/);
    if (st) {
      const e = ents.get(st[1]);
      return e ? res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ entity_id: st[1], state: e.state, attributes: e.attributes, last_changed: nowIso() }))
        : res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Entity not found.' }));
    }
    if (u.pathname === '/api/services') {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([
        { domain: 'light', services: { turn_on: {}, turn_off: {}, toggle: {} } },
        { domain: 'switch', services: { turn_on: {}, turn_off: {}, toggle: {} } },
      ]));
    }
    const svcCall = u.pathname.match(/^\/api\/services\/([\w-]+)\/([\w_-]+)$/);
    if (svcCall && req.method === 'POST') {
      const [, domain, service] = svcCall;
      serviceCalls.push({ domain, service, data });
      const id = String(data.entity_id || `${domain}.x`);
      if (ents.has(id)) {
        if (service === 'turn_on') setEntity(id, domain === 'cover' ? 'open' : 'on');
        else if (service === 'turn_off') setEntity(id, domain === 'cover' ? 'closed' : 'off');
        else if (service === 'toggle') setEntity(id, ents.get(id).state === 'on' ? 'off' : 'on');
      }
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([]));
    }
    if (u.pathname.startsWith('/api/history/period/')) {
      const id = u.searchParams.get('filter_entity_id') || '';
      const e = ents.get(id);
      const pts = [{ entity_id: id, state: 'off', last_changed: new Date(Date.now() - 20 * 3600e3).toISOString() },
        ...(e ? [{ entity_id: id, state: e.state, last_changed: nowIso() }] : []),
        { entity_id: id, state: e ? e.state : 'off', last_changed: nowIso() }];
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([pts]));
    }
    if (u.pathname === '/api/camera_proxy/camera.front') {
      return res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length }).end(JPEG);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Not found.' }));
  });
});

// WebSocket：/api/websocket（HA 是 server、工作台是 client——帧序照 HA 官方：auth_required → auth → auth_ok）
ha.on('upgrade', (req, socket) => {
  const url = new URL(req.url, HA_BASE);
  if (url.pathname !== '/api/websocket') { try { socket.destroy(); } catch {} return; }
  const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key'] || '') + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  wsSock = socket;
  wsSubId = 0;
  wsSend(0x1, JSON.stringify({ type: 'auth_required' }));
  let acc = Buffer.alloc(0);
  socket.on('data', (d) => {
    acc = Buffer.concat([acc, d]);
    while (acc.length >= 2) {
      const op = acc[0] & 0x0f;
      const masked = !!(acc[1] & 0x80);
      let len = acc[1] & 0x7f, off = 2;
      if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
      const mlen = masked ? 4 : 0;
      if (acc.length < off + mlen + len) return;
      const mask = masked ? acc.subarray(off, off + 4) : null;
      off += mlen;
      const payload = Buffer.from(acc.subarray(off, off + len));
      acc = acc.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (op === 0x8) { try { socket.end(); } catch {} return; }
      if (op !== 0x1) continue;
      let m; try { m = JSON.parse(payload.toString('utf8')); } catch { continue; }
      // 分发不许 return：一条 data 事件里可能攒了多帧（客户端会把同 tick 的三条命令合包），
      // return 会把 acc 里还没消费的帧晾到下一次 data 事件——第一条 e2e 就这样把 entity_registry 晾了 10 秒超时
      if (m.type === 'auth') {
        if (m.access_token === TOKEN) wsSend(0x1, JSON.stringify({ type: 'auth_ok', ha_version: '2026.10.0-e2e' }));
        else wsSend(0x1, JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
      } else if (m.type === 'ping') {
        wsSend(0x1, JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
      } else if (m.type === 'subscribe_events') {
        wsSubId = m.id;
        wsSend(0x1, JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
      } else if (m.type === 'config/area_registry/list') {
        wsSend(0x1, JSON.stringify({ id: m.id, type: 'result', success: true, result: REGISTRY.areas }));
      } else if (m.type === 'config/device_registry/list') {
        wsSend(0x1, JSON.stringify({ id: m.id, type: 'result', success: true, result: REGISTRY.devices }));
      } else if (m.type === 'config/entity_registry/list') {
        wsSend(0x1, JSON.stringify({ id: m.id, type: 'result', success: true, result: REGISTRY.entities }));
      } else {
        wsSend(0x1, JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
      }
    }
  });
  socket.on('error', () => { /* close 收尾 */ });
});

await new Promise((r) => ha.listen(HA_PORT, '127.0.0.1', r));

// ---------- 起隔离工作台 ----------
const WB_PORT = 3180;
const S = await startServer({ tag: 'ha', port: WB_PORT });
const B = S.B;
const admin = await login(B, 'admin', 'test123456');
const A = api(B, admin.H);

try {
  // ===== A. 配置 / 令牌 / 连接 =====
  console.log('\n[A] 连接配置 / 令牌 / 测试连接');
  const cfg0 = await A.get('/ha/config');
  ck('A1 初始配置 device_source=mihome', cfg0.body.config.device_source === 'mihome');
  ck('A2 初始无令牌（只回布尔）', cfg0.body.has_token === false);
  ck('A3 is_admin=true', cfg0.body.is_admin === true);
  ck('A4 hook_url 形如 …/api/ha/hook/<key>', /\/api\/ha\/hook\/\w{8,}/.test(String(cfg0.body.hook_url)), cfg0.body.hook_url);
  ck('A5 管理员可见 hook_key', typeof cfg0.body.hook_key === 'string' && cfg0.body.hook_key.length >= 16);

  const badPut = await A.put('/ha/config', { url: 'ftp://x' });
  ck('A6 非法地址明确报错（asyncH 兜 503 + 中文报错）', badPut.status === 503 && /内网地址/.test(badPut.body.error || ''), JSON.stringify(badPut.body));

  const badTest = await A.post('/ha/test', { url: HA_BASE, token: 'wrong-token' });
  ck('A7 错令牌 → ok:false + code=ha_auth（所有地址都拒后才定性）', badTest.body.ok === false && badTest.body.code === 'ha_auth', JSON.stringify(badTest.body));

  // 事故复刻（生产 2026-10-13）：内网地址误填成工作台自己——工作台 /api/ 未登录同样回 401。
  // 旧代码 401 短路：当场误判「令牌无效」、不再试第二个地址，用户刚生成的令牌被冤枉。
  const wbAsHa = await A.post('/ha/test', { url: B, url_external: HA_BASE, token: TOKEN });
  ck('A7b 首地址=工作台自己（401）→ 换第二个地址成功', wbAsHa.body.ok === true && wbAsHa.body.base === HA_BASE, JSON.stringify(wbAsHa.body));
  const wbOnly = await A.post('/ha/test', { url: B, token: TOKEN });
  ck('A7c 只剩错误地址（401）→ ha_auth 且报错点名该地址', wbOnly.body.ok === false && wbOnly.body.code === 'ha_auth' && wbOnly.body.base === B && String(wbOnly.body.error).includes(':3180'), JSON.stringify(wbOnly.body));

  const save = await A.put('/ha/config', { url: HA_BASE, url_external: 'http://127.0.0.1:9', token: TOKEN, device_source: 'ha' });
  ck('A8 保存配置 200', save.status === 200 && save.body.config.device_source === 'ha');
  const cfg1 = await A.get('/ha/config');
  ck('A9 保存后 has_token=true', cfg1.body.has_token === true);
  ck('A10 令牌绝不回显（整包里搜不到明文）', !JSON.stringify(cfg1.body).includes(TOKEN));

  const t1 = await A.post('/ha/test', {});
  ck('A11 测试连接 ok（读已存配置）', t1.body.ok === true && t1.body.version === '2026.10.0-e2e' && t1.body.location_name === '测试之家', JSON.stringify(t1.body));
  const t2 = await A.post('/ha/test', { url: 'http://127.0.0.1:9', url_external: HA_BASE, token: TOKEN });
  ck('A12 双地址故障转移（内网坏→外网通）', t2.body.ok === true && t2.body.base === HA_BASE, JSON.stringify(t2.body));

  // ===== B. 实体一览 =====
  console.log('\n[B] 实体一览（区域归属 / 分档 / WS 注册表）');
  let wsProbe = null;
  const wsUp = await until(async () => {
    const c = await A.get('/ha/config');
    wsProbe = c.body.ws || null;
    if (!(c.body.ws && c.body.ws.connected)) return false;
    const e = await A.get('/ha/entities');
    return e.body.degraded === false;
  });
  ck('B1 WebSocket 已连上（auth_ok 后 connected=true 且注册表非降级）', wsUp, JSON.stringify(wsProbe));
  const ents1 = await A.get('/ha/entities');
  const list = ents1.body.entities || [];
  const byId = (id) => list.find((e) => e.entity_id === id);
  ck('B2 七个实体全回来了', list.length === 7, JSON.stringify(list.map((e) => e.entity_id)));
  ck('B3 degraded=false（WS 注册表拿到了）', ents1.body.degraded === false, ents1.body.degraded_error || JSON.stringify(ents1.body).slice(0, 200));
  const ceil = byId('light.ceiling');
  ck('B4 客厅吊灯：区域=客厅（ent.area_id 直取）', ceil && ceil.area === '客厅');
  ck('B5 墙壁开关：区域=卧室（走 device.area_id）', byId('switch.wall') && byId('switch.wall').area === '卧室');
  ck('B6 大门：未分区（两级都无）', byId('lock.door') && byId('lock.door').area === '未分区');
  ck('B7 灯=语音可控', ceil.voice === true && ceil.controllable === true);
  ck('B8 门锁=面板可控但语音不认（安全决策）', byId('lock.door').voice === false && byId('lock.door').controllable === true);
  ck('B9 传感器只读', byId('sensor.temp').voice === false && byId('sensor.temp').controllable === false);
  ck('B10 温度话术带单位', byId('sensor.temp').state_text === '22 °C');
  ck('B11 空调抽取温湿度 t/h', byId('climate.ac').t === 21.5 && byId('climate.ac').h === 55);
  ck('B12 区域清单带计数', (ents1.body.areas || []).some((a) => a.name === '客厅' && a.count >= 3), JSON.stringify(ents1.body.areas));

  // ===== C. 快捷开关 =====
  console.log('\n[C] 快捷开关（call_service + 回读验证）');
  const c1 = await A.post('/ha/control', { entity_id: 'light.ceiling', action: 'off' });
  ck('C1 关吊灯 ok+verified（回读真关了）', c1.body.ok === true && c1.body.verified === true && /已关闭/.test(c1.body.message), JSON.stringify(c1.body));
  ck('C2 假 HA 收到 light.turn_off', serviceCalls.some((c) => c.domain === 'light' && c.service === 'turn_off'));
  const c2 = await A.post('/ha/control', { entity_id: 'switch.wall', action: 'toggle' });
  ck('C3 toggle：关→开', c2.body.ok === true && ents.get('switch.wall').state === 'on', JSON.stringify(c2.body));
  const c3 = await A.post('/ha/control', { entity_id: 'light|bad', action: 'on' });
  ck('C4 非法 entity_id 400', c3.status === 400);
  const c4 = await A.post('/ha/control', { entity_id: 'light.ceiling', action: 'dance' });
  ck('C5 非法 action 400', c4.status === 400);

  // ===== D. 语音链（数字人 + 贾维斯共用合并设备表） =====
  console.log('\n[D] 语音链：数字人 /dh/smarthome/command + 智能板 bridge');
  const d1 = await A.post('/dh/smarthome/command', { text: '打开客厅吊灯' });
  ck('D1 「打开客厅吊灯」命中 HA 设备', d1.body.matched === true && d1.body.control && d1.body.control.ok === true, JSON.stringify(d1.body));
  ck('D2 回执是真话术（已打开客厅吊灯）', /打开/.test(String(d1.body.control.message)) && /客厅吊灯/.test(String(d1.body.control.message)), d1.body.control && d1.body.control.message);
  ck('D3 设备真的开了', ents.get('light.ceiling').state === 'on');
  const d2 = await A.post('/dh/smarthome/command', { text: '今天天气怎么样' });
  ck('D4 闲聊不接管', d2.body.matched === false);
  const d3 = await A.post('/dh/smarthome/command', { text: '空调现在多少度' });
  ck('D5 无开关动词的疑问不接管', d3.body.matched === false, JSON.stringify(d3.body));

  const xzCfg = await A.get('/xiaozhi/config');
  const KEY = xzCfg.body.bridge_key;
  ck('D6 桥接 key 拿到', typeof KEY === 'string' && KEY.length >= 16);
  const bridge = (body) => fetch(`${B}/api/xiaozhi/bridge?k=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j);
  const ld = await bridge({ op: 'list_devices' });
  const ldNames = ((ld.devices || []).map((d) => d.name));
  ck('D7 桥接 list_devices 带 HA 设备（3 台语音域）', ld.ok === true && ld.total === 3 && ldNames.includes('客厅吊灯') && ldNames.includes('墙壁开关') && ldNames.includes('空调'), JSON.stringify(ld));
  ck('D8 瘦身回包不含 did（v1.9.13 规矩不破）', !('did' in (ld.devices[0] || {})));
  const pg = await bridge({ op: 'ping' });
  ck('D9 ping 话术写明 Home Assistant 3 台', pg.ok === true && /Home Assistant 有 3 台/.test(pg.message), pg.message);
  const bc = await bridge({ op: 'control', device: '客厅吊灯', action: 'off' });
  ck('D10 桥接 control 关吊灯（贾维斯那条路也通）', bc.ok === true && ents.get('light.ceiling').state === 'off', JSON.stringify(bc));

  // 别名（与米家共用一张表）
  const al1 = await A.put('/xiaozhi/device-alias', { did: 'light.ceiling', alias: '大灯' });
  ck('D11 HA 实体可登记别名', al1.body.ok === true, JSON.stringify(al1.body));
  const alBad = await A.put('/xiaozhi/device-alias', { did: 'light.ceiling', alias: '客厅吊灯' });
  ck('D12 别名=本名被拦', alBad.status === 400);
  const ld2 = await bridge({ op: 'list_devices' });
  ck('D13 清单里改叫「大灯」（别名接管）', (ld2.devices || []).some((d) => d.name === '大灯') && !(ld2.devices || []).some((d) => d.name === '客厅吊灯'), JSON.stringify(ld2.devices));
  const bc2 = await bridge({ op: 'control', device: '大灯', action: 'on' });
  ck('D14 叫别名能控制', bc2.ok === true && ents.get('light.ceiling').state === 'on');
  await A.put('/xiaozhi/device-alias', { did: 'light.ceiling', alias: '' }); // 清掉，别影响后面

  // ===== E. 摄像头 / 历史 / 服务调试 =====
  console.log('\n[E] 摄像头 / 历史 / 服务调试');
  const cam = await fetch(`${B}/api/ha/camera/camera.front?token=${admin.token}`);
  const camBuf = Buffer.from(await cam.arrayBuffer());
  ck('E1 摄像头快照 200 + JPEG 魔数（?token= 鉴权同图床先例）', cam.status === 200 && camBuf[0] === 0xff && camBuf[1] === 0xd8 && camBuf[2] === 0xff);
  ck('E2 Content-Type image/jpeg', (cam.headers.get('content-type') || '').includes('image/jpeg'));
  const hist = await A.get('/ha/history/light.ceiling?hours=24');
  ck('E3 历史点位回来（数组）', Array.isArray(hist.body.points) && hist.body.points.length >= 2);
  const svcs = await A.get('/ha/services');
  ck('E4 服务目录（管理员）', svcs.status === 200 && (svcs.body.services || []).some((s) => s.domain === 'light' && s.services.turn_on));
  const run1 = await A.post('/ha/service', { domain: 'light', service: 'turn_off', data: { entity_id: 'light.ceiling' } });
  ck('E5 服务调用执行', run1.body.ok === true && serviceCalls.some((c) => c.domain === 'light' && c.service === 'turn_off' && c.data.entity_id === 'light.ceiling'));
  const run2 = await A.post('/ha/service', { domain: 'bad domain', service: 'x' });
  ck('E6 非法 domain 400', run2.status === 400);

  // ===== F. webhook + SSE =====
  console.log('\n[F] webhook 反调 + SSE 实时流');
  const hookKey = (await A.get('/ha/config')).body.hook_key;
  const hookUrl = `${B}/api/ha/hook/${hookKey}`;
  const wBad = await fetch(hookUrl.replace(hookKey, '0'.repeat(hookKey.length)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) });
  ck('F1 错 key 403', wBad.status === 403);
  const wOk = await fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '洗衣机结束', message: '阳台洗衣机洗完了' }) });
  const wj = await wOk.json();
  ck('F2 免登录 webhook ok（key 即凭证）', wOk.status === 200 && wj.ok === true);

  // SSE：先挂上流，等 retry 行落地（订阅就绪），再触发 webhook + 翻状态，两类事件都要在流里看到
  const sseText = await (async () => {
    const ac = new AbortController();
    let text = '';
    const saw = () => text.includes('"type":"hook"') && text.includes('门磁') && text.includes('"type":"state"') && text.includes('switch.wall');
    let reader = null;
    try {
      const r = await fetch(`${B}/api/ha/events?token=${admin.token}`, { signal: ac.signal });
      reader = r.body.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + 8000;
      let armed = false;
      while (Date.now() < deadline && !saw()) {
        const t = sleep(Math.max(50, deadline - Date.now())).then(() => { throw new Error('sse-deadline'); });
        t.catch(() => { /* 输家兜底 */ });
        const chunk = await Promise.race([reader.read(), t]);
        if (chunk.done) break;
        text += dec.decode(chunk.value, { stream: true });
        if (!armed && text.includes('retry:')) { // 流已就绪：此刻起触发的事件必经此流
          armed = true;
          fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '门磁', message: '大门被打开' }) }).catch(() => {});
          setEntity('switch.wall', 'off'); // WS state_changed → 服务端 applyStateEvent → SSE
        }
      }
    } catch { /* 超时收流 */ }
    finally { ac.abort(); }
    return text;
  })();
  ck('F3 SSE 收到 retry 心跳行', sseText.includes('retry:'), sseText.slice(0, 120));
  ck('F4 SSE 收到 hook 事件', sseText.includes('"type":"hook"') && sseText.includes('门磁'), sseText.slice(-300));
  ck('F5 SSE 收到 state 事件（WS state_changed 透传）', sseText.includes('"type":"state"') && sseText.includes('switch.wall'), sseText.slice(-300));
  const hl = await A.get('/ha/hooklog?limit=10');
  ck('F6 hooklog 落库可查', (hl.body.events || []).some((e) => e.title === '门磁' && e.source === 'hook'), JSON.stringify(hl.body).slice(0, 200));
  ck('F7 控制留痕也在流水里（非 hook 来源的事件存在）', (hl.body.events || []).some((e) => e.source !== 'hook'), JSON.stringify(hl.body).slice(0, 200));

  // ===== G. 权限 =====
  console.log('\n[G] 权限与鉴权');
  const noTok = await fetch(`${B}/api/ha/entities`);
  ck('G1 未登录 401', noTok.status === 401);
  const mkUser = (u) => fetch(`${B}/api/users`, { method: 'POST', headers: { ...admin.H, 'Content-Type': 'application/json' }, body: JSON.stringify(u) });
  await mkUser({ username: 'uNoHa', password: 'uno123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } });
  await mkUser({ username: 'uHa', password: 'uyes123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['ha'] } });
  const uNo = await login(B, 'uNoHa', 'uno123456');
  const uYes = await login(B, 'uHa', 'uyes123456');
  const UN = api(B, uNo.H);
  const UY = api(B, uYes.H);
  ck('G2 没勾 ha 子 tab → 实体一览 403', (await UN.get('/ha/entities')).status === 403);
  ck('G3 勾了 ha → 实体一览 200', (await UY.get('/ha/entities')).status === 200);
  ck('G4 普通成员改配置 403', (await UY.put('/ha/config', { url: HA_BASE })).status === 403);
  ck('G5 普通成员服务调试 403（任意服务=HA 全量权限）', (await UY.get('/ha/services')).status === 403 && (await UY.post('/ha/service', { domain: 'light', service: 'turn_on', data: {} })).status === 403);
  const ucfg = await UY.get('/ha/config');
  ck('G6 普通成员 is_admin=false 且 hook_key 不下发', ucfg.body.is_admin === false && !ucfg.body.hook_key);
  ck('G7 普通成员能开关（与米家面板同口径）', (await UY.post('/ha/control', { entity_id: 'light.ceiling', action: 'on' })).body.ok === true);

  // ===== I. 仪表盘（v1.15.0）：设备分类 + 条目可见性，整表替换语义 =====
  console.log('\n[I] 仪表盘：分类 CRUD / 条目键校验 / 孤儿清扫 / 权限');
  const catBad1 = await A.put('/ha/categories', { categories: [{ name: '灯光', icon: 'not_an_icon' }] });
  ck('I1 图标不在白名单 400（haBad ≠ HA 调用失败）', catBad1.status === 400 && /图标/.test(catBad1.body.error || ''), JSON.stringify(catBad1.body));
  const catBad2 = await A.put('/ha/categories', { categories: [{ name: '超级长的分类名字超过十六个字了啊吧', icon: 'home' }] }); // 17 字
  ck('I2 分类名超 16 字 400', catBad2.status === 400 && /1~16/.test(catBad2.body.error || ''), JSON.stringify(catBad2.body));
  const catOk = await A.put('/ha/categories', { categories: [{ name: '灯光', icon: 'lightbulb' }, { name: '摄像头', icon: 'photo_camera' }] });
  ck('I3 保存两个分类 200 且现场发 c 前缀 id', catOk.status === 200 && catOk.body.categories.length === 2
    && catOk.body.categories.every((c) => /^c[0-9a-f]{6,16}$/.test(c.id) && c.name && c.icon), JSON.stringify(catOk.body));
  const cat1 = catOk.body.categories[0].id, cat2 = catOk.body.categories[1].id;

  // 实体一览的新字段：devices / cats / dash + 每实体的 device_id/device_name
  const ents2 = await A.get('/ha/entities');
  const dev1 = (ents2.body.devices || []).find((d) => d.id === 'dev1');
  ck('I4 devices 清单：dev1 两实体归一台设备（count=2，取 name_by_user/manufacturer）', dev1 && dev1.count === 2 && dev1.name === '卧室温控套件' && dev1.manufacturer === '小米' && dev1.area === '卧室', JSON.stringify(ents2.body.devices));
  const sw = (ents2.body.entities || []).find((e) => e.entity_id === 'switch.wall');
  ck('I5 实体带 device_id/device_name', (ents2.body.entities || []).every((e) => typeof e.device_id === 'string') && sw && sw.device_id === 'dev1' && sw.device_name === '卧室温控套件');
  ck('I6 实体一览带 cats + dash', (ents2.body.cats || []).length === 2 && ents2.body.dash && typeof ents2.body.dash === 'object');

  // 仪表盘条目键校验
  const dashBad = await A.put('/ha/dashboard', { dashboard: { 'foo:bar': { visible: true } } });
  ck('I7 非法条目键 400（应为 dev:/ent: 前缀）', dashBad.status === 400 && /dev:|ent:|格式/.test(dashBad.body.error || ''), JSON.stringify(dashBad.body));
  const dashOk = await A.put('/ha/dashboard', {
    dashboard: {
      'dev:dev1': { visible: true, cat: cat1, sort: 10 },
      'ent:camera.front': { visible: true, cat: cat2, sort: 20 },
      'ent:light.ceiling': { visible: false, cat: 'cdeadbeef99', sort: -5 }, // 未知分类/负 sort → 服务端归一
    },
  });
  ck('I8 保存仪表盘 200（dev: 键 + cat 落位）', dashOk.status === 200 && dashOk.body.dashboard['dev:dev1'].visible === true && dashOk.body.dashboard['dev:dev1'].cat === cat1);
  ck('I9 未知 cat 清空、负 sort 归 0（不报错）', dashOk.body.dashboard['ent:light.ceiling'].cat === '' && dashOk.body.dashboard['ent:light.ceiling'].sort === 0 && dashOk.body.dashboard['ent:light.ceiling'].visible === false);
  ck('I10 回读 GET /ha/entities 里 cat 保留', (await A.get('/ha/entities')).body.dash['ent:camera.front'].cat === cat2);
  ck('I11 普通成员存分类 403', (await UY.put('/ha/categories', { categories: [] })).status === 403);
  ck('I12 普通成员存仪表盘 403', (await UY.put('/ha/dashboard', { dashboard: {} })).status === 403);

  // 删除分类（整表替换只剩 cat2）→ 指向 cat1 的孤儿引用被清扫；cat2 的保留
  const catDel = await A.put('/ha/categories', { categories: [{ id: cat2, name: '摄像头', icon: 'photo_camera' }] });
  const dashAfter = (await A.get('/ha/entities')).body.dash;
  ck('I13 删分类清扫孤儿：dev:dev1 的 cat 清空、visible/sort 不动', catDel.status === 200 && dashAfter['dev:dev1'].cat === '' && dashAfter['dev:dev1'].visible === true && dashAfter['dev:dev1'].sort === 10, JSON.stringify(dashAfter));
  ck('I14 还在的分类引用不动（ent:camera.front.cat 保留）', dashAfter['ent:camera.front'].cat === cat2, JSON.stringify(dashAfter));
} finally {
  try { wsSock && wsSock.destroy(); } catch { /* 已断 */ }
  try { ha.close(); } catch { /* 已断 */ }
  S.stop();
}
if (!done()) process.exit(1);
