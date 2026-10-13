// Home Assistant 实体域分类（v1.14.0，智能家居页「HomeAssistant」tab）。
// 纯函数、零依赖：域 → 中文标签 / 语音可控判定 / 开关服务映射 / 开态判定 / 状态话术。
// 单测见 scripts/check-ha-guards.mjs。
//
// 域分三档（刻意从严，先跑通再放开）：
//   VOICE_DOMAINS  语音可控——有明确「打开/关闭」语义，米家同款动词直接映射；
//   PANEL_DOMAINS  仅面板可控——有开关服务但语义敏感或动作型（门锁/场景/脚本/自动化/吸尘器），
//                  绝不进语音链路（误唤醒一句「把门打开」不该真开门），面板上可以点；
//   其余           只读展示（sensor/binary_sensor/weather/person/…），无开关能力。
// 锁（lock）从语音里排除是安全决策，不是能力缺口——要开门锁请去 HA 本体或面板上确认。

// 语音可控域。顺序即面板筛选 chips 的展示顺序。
const VOICE_DOMAINS = ['light', 'switch', 'fan', 'climate', 'cover', 'humidifier', 'water_heater', 'media_player', 'input_boolean'];

// 仅面板可控域（可点开/执行，但语音链路不认）。
const PANEL_DOMAINS = ['lock', 'scene', 'script', 'automation', 'vacuum', 'siren', 'button'];

const DOMAIN_LABELS = {
  light: '灯', switch: '开关', fan: '风扇', climate: '温控', cover: '窗帘/卷帘',
  humidifier: '加湿器', water_heater: '热水器', media_player: '媒体播放', input_boolean: '虚拟开关',
  sensor: '传感器', binary_sensor: '二元传感器', weather: '天气', sun: '日照', zone: '区域',
  person: '成员', device_tracker: '设备追踪', camera: '摄像头', lock: '门锁', scene: '场景',
  script: '脚本', automation: '自动化', vacuum: '吸尘器', siren: '警笛', button: '按钮',
  alarm_control_panel: '安防', input_number: '虚拟数值', input_select: '虚拟选择', input_text: '虚拟文本',
  number: '数值', select: '选择', text: '文本', time: '时间', datetime: '日期时间', date: '日期',
  timer: '计时器', todo: '待办', calendar: '日历', update: '更新', sun2: '日照', image: '图片',
};

// 域 → turn_on/turn_off 之外的开关服务映射。
// 盖帘没有 turn_on：开=open_cover、关=close_cover、切=stop_cover（HA 语义）。
// media_player 用 turn_on/turn_off（比 play_media/media_pause 更贴合「开/关」的语音语义）。
function serviceFor(domain, action) {
  // action 统一用 'on' | 'off' | 'toggle'（xiaozhiService.controlDevice 已把它收敛成 on/off）
  if (domain === 'cover') {
    if (action === 'on') return 'open_cover';
    if (action === 'off') return 'close_cover';
    return 'stop_cover';
  }
  if (action === 'toggle') return 'toggle';
  if (action === 'on') return 'turn_on';
  if (action === 'off') return 'turn_off';
  return null;
}

// 实体当前是否处于「开」态。HA state 字符串各域口径不同：
//   常规域 'on'；盖帘 'open'/'opening'（动作中算已开）；媒体 'playing'（paused 算关，
//   与「关闭播放器」的直觉一致）；温控 state='off' 之外（auto/heat/cool/idle…）都算开
//   （idle=已开机在待温，不是关机）；unavailable/unknown 一律算关（不可控）。
function isOn(domain, state, attributes) {
  const s = String(state == null ? '' : state).toLowerCase();
  if (!s || s === 'unavailable' || s === 'unknown' || s === 'off' || s === 'closed' || s === 'none') return false;
  if (domain === 'cover') return s === 'open' || s === 'opening';
  if (domain === 'media_player') return s === 'playing' || s === 'on';
  if (domain === 'climate') {
    // hvac_action=heating/cooling/idle 说明设备真开着；state 只剩 mode 名时退回「非 off 即开」
    const act = String((attributes || {}).hvac_action || '').toLowerCase();
    if (act && act !== 'off') return true;
    return true;
  }
  return s === 'on';
}

// 面板一行用的状态短话术（数字传感器带单位；二元/常规域给中文）。
function stateText(domain, state, attributes) {
  const s = String(state == null ? '' : state);
  if (s === 'unavailable') return '不可用';
  if (s === 'unknown') return '未知';
  const attrs = attributes || {};
  if (attrs.unit_of_measurement) {
    const num = Number(s);
    return (Number.isFinite(num) ? num : s) + ' ' + String(attrs.unit_of_measurement);
  }
  if (domain === 'binary_sensor') return s === 'on' ? (attrs.device_class === 'motion' ? '有动静' : '开') : (attrs.device_class === 'motion' ? '无动静' : '关');
  if (domain === 'climate') {
    const cur = Number(attrs.current_temperature);
    const t = Number.isFinite(cur) ? `，${cur}°C` : '';
    const act = String(attrs.hvac_action || '');
    const actText = act === 'heating' ? '制热中' : act === 'cooling' ? '制冷中' : act === 'idle' ? '待温' : s;
    return actText + t;
  }
  if (isOn(domain, s, attrs)) return '开着';
  if (domain === 'cover') return '关着';
  return '关着';
}

// 域的中文标签（面板分组与语音回执用；未收录的域原样返回）。
function labelOf(domain) { return DOMAIN_LABELS[domain] || domain; }

// 是否语音可控域
function isVoiceDomain(domain) { return VOICE_DOMAINS.includes(domain); }

// 是否面板可控域（语音 + 面板两档）
function isControllable(domain) { return VOICE_DOMAINS.includes(domain) || PANEL_DOMAINS.includes(domain); }

// HA 的 states 快照 + 注册表 → 米家同款语音设备表（xiaozhiService.resolveDevice/controlDevice 直接吃）。
// 纯函数（不碰 DB/网络），单测在 scripts/check-ha-guards.mjs。字段口径对齐 listDevicesForBridge：
//   did=entity_id（通过 setDeviceAlias 的 /^[\w.-]{1,64}$/ 校验，别名表直接复用）；
//   sw.siid/piid 为 null（HA 分支在 controlDevice 里先于 setProp 拦截，不会走到米家写入）；
//   backend='ha' 是分流标记——合并表里没这个字段的都是米家设备。
function voiceItemsFrom(states, registry) {
  const reg = registry || {};
  const areas = new Map((reg.areas || []).map((a) => [a.area_id, a.name || a.area_id]));
  const devices = new Map((reg.devices || []).map((d) => [d.id, d]));
  const ents = new Map((reg.entities || []).map((e) => [e.entity_id, e]));
  const out = [];
  for (const st of states || []) {
    const entityId = String(st && st.entity_id || '');
    const domain = entityId.split('.')[0];
    if (!isVoiceDomain(domain)) continue;
    const ent = ents.get(entityId) || {};
    if (ent.hidden_by || ent.disabled_by) continue; // HA 侧隐藏/禁用的实体不进语音
    const attrs = (st && st.attributes) || {};
    const dev = ent.device_id ? devices.get(ent.device_id) : null;
    const areaId = ent.area_id || (dev && dev.area_id) || '';
    const room = areaId ? (areas.get(areaId) || areaId) : '未分区';
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    out.push({
      did: entityId,
      name: String(attrs.friendly_name || entityId),
      home: 'Home Assistant',
      room,
      online: st.state !== 'unavailable' && st.state !== 'unknown',
      sw: { siid: null, piid: null, v: isOn(domain, st.state, attrs) },
      t: num(attrs.current_temperature),
      h: num(attrs.current_humidity),
      backend: 'ha',
      domain,
      state: st.state,
    });
  }
  return out;
}

// ---------- 仪表盘（v1.15.0）：分类图标白名单 + 仪表盘键校验（纯函数，check-ha-guards 单测） ----------
// 分类图标 = Material Icons 单色字形。这里是唯一权威白名单；HaPanel 抄一份同样的数组用于
// 勾选界面，check-ha-guards 断言两边逐项一致（防止只改一边：页面上勾不到 / 渲染成一串字母）。
const CATEGORY_ICONS = [
  'home', 'lightbulb', 'curtains', 'photo_camera', 'air', 'device_thermostat',
  'tv', 'speaker', 'lock', 'sensors', 'water_drop', 'hot_tub', 'power_settings_new',
  'cleaning_services', 'security', 'kitchen', 'garage', 'yard', 'directions_car', 'pets',
];
function isCategoryIcon(s) { return CATEGORY_ICONS.includes(String(s || '')); }
// 仪表盘条目键：dev:<device_id>（同一设备整卡，设备页的「可见」勾的就是它）或 ent:<entity_id>（无设备归属的单实体卡）
function isDashKey(s) {
  return typeof s === 'string' && /^(dev|ent):[\w.-]{1,64}$/.test(s);
}

module.exports = {
  VOICE_DOMAINS, PANEL_DOMAINS, serviceFor, isOn, stateText, labelOf, isVoiceDomain, isControllable,
  voiceItemsFrom,
  CATEGORY_ICONS, isCategoryIcon, isDashKey,
};
