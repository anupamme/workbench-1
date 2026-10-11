// 电脑监控处罚联动（v1.13.5）
// 电脑监控里「预警关键字」命中时（屏幕 AI 概括文本包含关键字），按「兑现登记 → 处罚标准」的规则
// 自动在 typing_payouts 里登记一笔【负数】兑现（= 扣款），并给指定成员发一条短消息。
//   · 负数兑现让「兑现记录」合计可为负——合计本来就是 0 时，扣完直接变欠账的负值。
//   · 待兑现 = 应得合计 − 已兑现 − 处罚扣款 − 已赊账（见 typingRoutes 的 preview/summary）。
// 配置存主库 settings.monitor_penalty_cfg（钱款管理，UI 在「学习 → 兑现登记」页的「处罚标准」卡）。
// 规则字段：device_id = 哪台被监控电脑；amount = 每次扣减金额；deduct_user_id = 扣减哪个成员；
//           push_user_ids = 短消息推给哪些成员。
// ⚠️ 无效规则直接丢弃（设备不存在 / 扣减成员不存在 / 金额非法 / 推送成员不存在）：
//    typing_payouts 列表是 INNER JOIN users，写进不存在用户的账会从列表里凭空消失——钱少一笔还不显眼。
const { db, getSetting, setSetting } = require('../db');
const messageService = require('./messageService');

const CFG_KEY = 'monitor_penalty_cfg';

function listDevices() {
  return db.prepare(
    'SELECT id, name FROM monitor_devices ORDER BY (COALESCE(sort_order,0)=0), COALESCE(sort_order,0), created_at'
  ).all();
}
// 用户清单（给 UserPicker 用，字段名对齐 /messages/contacts 的形状）
function listUsers() {
  return db.prepare('SELECT id, username, display_name, nickname, role FROM users WHERE is_bot=0 ORDER BY id')
    .all().map((u) => ({ ...u, is_bot: 0 }));
}
function firstAdminId() {
  const r = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
  return r ? r.id : 1;
}
const userName = (u) => (u && (u.display_name || u.nickname || u.username)) || `用户#${u && u.id}`;
// 金额显示：5 → "5"、5.5 → "5.5"（拼进备注文案）
const fmtMoney = (n) => String(Math.round(Number(n) * 100) / 100);

function normRule(r) {
  if (!r || typeof r !== 'object') return null;
  const amount = Math.round(Number(r.amount) * 100) / 100;
  const deduct = Number(r.deduct_user_id) || 0;
  const device_id = String(r.device_id || '').trim().slice(0, 64);
  if (!(amount > 0) || amount > 100000 || !device_id || !deduct) return null;
  const push = (Array.isArray(r.push_user_ids) ? r.push_user_ids : []).map(Number).filter(Boolean);
  return { device_id, amount, deduct_user_id: deduct, push_user_ids: [...new Set(push)].slice(0, 10) };
}

function getConfig() {
  let cfg = {};
  try { cfg = JSON.parse(getSetting(db, CFG_KEY, '{}') || '{}'); } catch { /* 容错 */ }
  const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).map(normRule).filter(Boolean);
  return { enabled: cfg.enabled !== false, rules: rules.map((r, i) => ({ ...r, id: i + 1 })) };
}

// 保存（整体替换语义，同设备别名表的先例）：只留真实存在的设备/扣减成员/推送成员
function saveConfig(patch) {
  const devIds = new Set(listDevices().map((d) => d.id));
  const userIds = new Set(listUsers().map((u) => u.id));
  const raw = (patch && Array.isArray(patch.rules)) ? patch.rules : [];
  const rules = [];
  for (const r of raw.slice(0, 50)) {
    const n = normRule(r);
    if (!n) continue;
    if (!devIds.has(n.device_id)) continue;        // 设备已删/不存在 → 丢
    if (!userIds.has(n.deduct_user_id)) continue;  // 扣减成员不存在 → 丢
    n.push_user_ids = n.push_user_ids.filter((i) => userIds.has(i));
    n.id = rules.length + 1;
    rules.push(n);
  }
  // enabled 缺省时保持原值（前端 PUT 一定会带；不带就别把用户关掉的开关偷偷打开）
  const enabled = !patch || patch.enabled === undefined ? getConfig().enabled : !!patch.enabled;
  setSetting(db, CFG_KEY, JSON.stringify({ enabled, rules }));
  return { ...getConfig(), devices: listDevices(), users: listUsers() };
}

// 预警命中时调用：按规则登记负数兑现 + 发短消息。返回实际执行的结果（供日志）。
function applyPenalty({ deviceId, deviceName, keyword, aiText, ts }) {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.rules.length) return [];
  const month = new Date().toLocaleDateString('sv').slice(0, 7); // 记账月 = 触发当月
  const done = [];
  for (const r of cfg.rules) {
    if (String(r.device_id) !== String(deviceId)) continue;
    const u = db.prepare('SELECT id, username, display_name, nickname FROM users WHERE id=? AND is_bot=0').get(r.deduct_user_id);
    if (!u) continue;
    const name = userName(u);
    const X = fmtMoney(r.amount);
    const ai = String(aiText || '').trim().slice(0, 300);
    // 备注原因：按需求拼接 —— 《预警违法电脑使用规定，扣减X元》 + 处罚标准说明 + AI 分析内容
    const note = (
      `《预警违法电脑使用规定，扣减${X}元》`
      + `根据处罚标准本次扣减${X}元，已经实时记入赚钱结算金额中。如有再犯随时增加处罚额度。`
      + ai
    ).slice(0, 500);
    const from = firstAdminId();
    db.prepare('INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)')
      .run(r.deduct_user_id, month, -r.amount, note, from);
    const subject = `电脑监控处罚：${name} 被扣减 ${X} 元`;
    const content = `【${deviceName || deviceId}】${ts || ''} 的屏幕截图命中预警关键词「${keyword}」。\n`
      + `${note}\n（已实时记入 ${name} 的「兑现登记 → 兑现记录」，金额为负=欠账）`;
    for (const uid of r.push_user_ids) {
      try {
        messageService.send(db, { from_user: from, to_user: uid, subject, content, module: 'monitor' });
      } catch (e) { console.warn(`[monitor] 处罚消息发送失败(用户${uid}):`, e.message); }
    }
    done.push({ user_id: r.deduct_user_id, user_name: name, amount: r.amount });
  }
  return done;
}

module.exports = { CFG_KEY, getConfig, saveConfig, applyPenalty, listDevices, listUsers };
