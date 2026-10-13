// Home Assistant 域分类纯函数单测（v1.14.0）——零 DB 零网络：
//   node scripts/check-ha-guards.mjs
// 覆盖：serviceFor 服务映射 / isOn 各域开态口径 / stateText 话术 / voiceItemsFrom 语音设备表整形
//（隐藏实体剔除、区域归属链、别名表兼容的 did 格式、温湿度抽取、backend='ha' 标记）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = require('../server/services/haDomains.js');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '   <<< ' + extra}`); };

console.log('\n[1] serviceFor：域 → 开关服务映射');
ck('light on → turn_on', D.serviceFor('light', 'on') === 'turn_on');
ck('light off → turn_off', D.serviceFor('light', 'off') === 'turn_off');
ck('switch toggle → toggle', D.serviceFor('switch', 'toggle') === 'toggle');
ck('cover on → open_cover（盖帘没有 turn_on）', D.serviceFor('cover', 'on') === 'open_cover');
ck('cover off → close_cover', D.serviceFor('cover', 'off') === 'close_cover');
ck('cover toggle → stop_cover（HA 语义：切=停）', D.serviceFor('cover', 'toggle') === 'stop_cover');
ck('fan off → turn_off', D.serviceFor('fan', 'off') === 'turn_off');
ck('未知动作 → null（不瞎猜服务名）', D.serviceFor('light', 'dance') === null);

console.log('\n[2] isOn：各域开态口径');
ck("常规域 'on' → 开", D.isOn('light', 'on', {}) === true);
ck("常规域 'off' → 关", D.isOn('switch', 'off', {}) === false);
ck("'unavailable' → 关（不可控）", D.isOn('light', 'unavailable', {}) === false);
ck("'unknown' → 关", D.isOn('fan', 'unknown', {}) === false);
ck('空 state → 关', D.isOn('light', null, {}) === false);
ck("cover 'open' → 开", D.isOn('cover', 'open', {}) === true);
ck("cover 'opening' → 开（动作中算已开）", D.isOn('cover', 'opening', {}) === true);
ck("cover 'closed' → 关", D.isOn('cover', 'closed', {}) === false);
ck("cover 'on' → 关（盖帘没有 on 态，防误判）", D.isOn('cover', 'on', {}) === false);
ck("media 'playing' → 开", D.isOn('media_player', 'playing', {}) === true);
ck("media 'paused' → 关（与「关闭播放器」直觉一致）", D.isOn('media_player', 'paused', {}) === false);
ck("media 'on' → 开", D.isOn('media_player', 'on', {}) === true);
ck("climate 'heat' → 开", D.isOn('climate', 'heat', {}) === true);
ck("climate 'idle' → 开（待温≠关机）", D.isOn('climate', 'idle', {}) === true);
ck("climate 'off' → 关", D.isOn('climate', 'off', {}) === false);
ck("climate unavailable+hvac_action 残留 → 仍关（unavailable 先判）", D.isOn('climate', 'unavailable', { hvac_action: 'heating' }) === false);
ck('大小写不敏感（HA 恒小写，防御）', D.isOn('light', 'ON', {}) === true);

console.log('\n[3] stateText：面板状态话术');
ck("'unavailable' → 不可用", D.stateText('light', 'unavailable', {}) === '不可用');
ck("'unknown' → 未知", D.stateText('sensor', 'unknown', {}) === '未知');
ck('数字传感器带单位', D.stateText('sensor', '23.5', { unit_of_measurement: '°C' }) === '23.5 °C');
ck('非数字带单位原样拼', D.stateText('sensor', 'abc', { unit_of_measurement: 'µg/m³' }).includes('µg/m³'));
ck("binary_sensor motion on → 有动静", D.stateText('binary_sensor', 'on', { device_class: 'motion' }) === '有动静');
ck("binary_sensor motion off → 无动静", D.stateText('binary_sensor', 'off', { device_class: 'motion' }) === '无动静');
ck("binary_sensor 普通开 → 开", D.stateText('binary_sensor', 'on', {}) === '开');
ck('climate 制热中带当前温度', D.stateText('climate', 'heat', { hvac_action: 'heating', current_temperature: 21.5 }) === '制热中，21.5°C');
ck('climate 待温', D.stateText('climate', 'auto', { hvac_action: 'idle' }) === '待温');
ck("灯 on → 开着", D.stateText('light', 'on', {}) === '开着');
ck("灯 off → 关着", D.stateText('light', 'off', {}) === '关着');

console.log('\n[4] 域分档：语音 / 面板 / 只读');
ck('灯/开关/风扇在语音档', ['light', 'switch', 'fan'].every((d) => D.isVoiceDomain(d)));
ck('门锁不在语音档（安全决策）', !D.isVoiceDomain('lock'));
ck('场景/脚本/自动化不在语音档', ['scene', 'script', 'automation'].every((d) => !D.isVoiceDomain(d)));
ck('门锁/场景在面板可控档（可点不进语音）', ['lock', 'scene'].every((d) => D.isControllable(d) && !D.isVoiceDomain(d)));
ck('传感器只读（两档都不在）', !D.isControllable('sensor') && !D.isVoiceDomain('sensor'));
ck('labelOf 中文标签', D.labelOf('light') === '灯' && D.labelOf('climate') === '温控');
ck('labelOf 未收录域原样返回', D.labelOf('weird_domain') === 'weird_domain');

console.log('\n[5] voiceItemsFrom：states + 注册表 → 语音设备表');
const STATES = [
  { entity_id: 'light.ceiling', state: 'on', attributes: { friendly_name: '客厅吊灯' } },
  { entity_id: 'switch.wall', state: 'off', attributes: { friendly_name: '墙壁开关' } },
  { entity_id: 'sensor.temp', state: '22', attributes: { friendly_name: '温度', unit_of_measurement: '°C' } },  // 只读域：不该进表
  { entity_id: 'lock.door', state: 'locked', attributes: { friendly_name: '大门' } },                            // 面板域：不该进语音表
  { entity_id: 'climate.ac', state: 'heat', attributes: { friendly_name: '空调', current_temperature: 21.5, current_humidity: 55 } },
  { entity_id: 'light.hidden_lamp', state: 'on', attributes: { friendly_name: '隐藏灯' } },                       // 注册表 hidden_by：剔除
  { entity_id: 'light.dis_lamp', state: 'on', attributes: { friendly_name: '禁用灯' } },                          // 注册表 disabled_by：剔除
  { entity_id: 'fan.nofan', state: 'unavailable', attributes: { friendly_name: '失联风扇' } },                     // 不可用也进表（online:false，语音里如实报离线）
];
const REG = {
  areas: [{ area_id: 'living_room', name: '客厅' }, { area_id: 'bedroom', name: '卧室' }],
  devices: [{ id: 'dev1', area_id: 'bedroom' }],
  entities: [
    { entity_id: 'light.ceiling', area_id: 'living_room' },
    { entity_id: 'switch.wall', device_id: 'dev1' },                    // 无 ent.area_id：走 device.area_id（卧室）
    { entity_id: 'climate.ac', area_id: 'living_room' },
    { entity_id: 'light.hidden_lamp', hidden_by: 'user' },
    { entity_id: 'light.dis_lamp', disabled_by: 'integration' },
    // fan.nofan 无注册表条目：实体级/设备级区域都无 → 未分区
  ],
};
const items = D.voiceItemsFrom(STATES, REG);
const by = (did) => items.find((x) => x.did === did);
ck('语音表共 4 条（灯/开关/温控/失联风扇）', items.length === 4, JSON.stringify(items.map((x) => x.did)));
ck('sensor/lock 不进语音表', !by('sensor.temp') && !by('lock.door'));
ck('隐藏/禁用实体被剔除', !by('light.hidden_lamp') && !by('light.dis_lamp'));
ck('did=entity_id（过别名表 /^\\w.-/ 校验）', /^[A-Za-z0-9_.-]{1,64}$/.test(items[0].did));
ck('backend=ha 分流标记', items.every((x) => x.backend === 'ha'));
ck('home 固定 Home Assistant', items.every((x) => x.home === 'Home Assistant'));
ck('ent.area_id 直取（客厅吊灯）', by('light.ceiling').room === '客厅');
ck('ent 无区域时走 device.area_id（墙壁开关→卧室）', by('switch.wall').room === '卧室');
ck('两级都无 → 未分区（失联风扇）', by('fan.nofan').room === '未分区');
ck('sw.v 开态（吊灯 on=true）', by('light.ceiling').sw.v === true);
ck('sw.v 关态（墙壁开关 off=false）', by('switch.wall').sw.v === false);
ck('sw.siid/piid 为 null（不会误走米家 setProp）', by('light.ceiling').sw.siid === null && by('light.ceiling').sw.piid === null);
ck('温湿度抽取（空调 t=21.5 h=55）', by('climate.ac').t === 21.5 && by('climate.ac').h === 55);
ck('unavailable → online:false 但保留在表里', by('fan.nofan').online === false);
ck('name 取 friendly_name', by('light.ceiling').name === '客厅吊灯');
ck('无 friendly_name 回退 entity_id', D.voiceItemsFrom([{ entity_id: 'light.x', state: 'on', attributes: {} }], {})[0].name === 'light.x');
ck('registry 缺省（空对象）不炸、归未分区', D.voiceItemsFrom([{ entity_id: 'light.y', state: 'on', attributes: {} }], undefined)[0].room === '未分区');
ck('states 为空 → 空表', D.voiceItemsFrom(null, REG).length === 0);

console.log('\n[6] 语音域清单完整性（xiaozhiService 合并表的前提）');
ck('VOICE_DOMAINS 九域齐', D.VOICE_DOMAINS.length === 9 && D.VOICE_DOMAINS.includes('humidifier') && D.VOICE_DOMAINS.includes('water_heater') && D.VOICE_DOMAINS.includes('input_boolean'));
ck('PANEL_DOMAINS 不与 VOICE 重叠', D.PANEL_DOMAINS.every((d) => !D.VOICE_DOMAINS.includes(d)));

console.log('\n[7] 仪表盘（v1.15.0）：分类图标白名单 + 条目键校验');
ck('CATEGORY_ICONS 非空且无重复', D.CATEGORY_ICONS.length >= 10 && new Set(D.CATEGORY_ICONS).size === D.CATEGORY_ICONS.length);
ck('isCategoryIcon 白名单内认', D.isCategoryIcon('home') && D.isCategoryIcon('pets') && D.isCategoryIcon('power_settings_new'));
ck('isCategoryIcon 白名单外拒（含大小写混淆/空）', !D.isCategoryIcon('delete') && !D.isCategoryIcon('Home') && !D.isCategoryIcon('') && !D.isCategoryIcon(null));
ck('isDashKey 认 dev:/ent: 前缀（64 字内）', D.isDashKey('dev:abc123') && D.isDashKey('ent:light.ceiling') && D.isDashKey('ent:' + 'x'.repeat(64)));
ck('isDashKey 拒无前缀/空前缀/65 字/非字符串', !D.isDashKey('foo:bar') && !D.isDashKey('') && !D.isDashKey('dev:') && !D.isDashKey('ent:' + 'x'.repeat(65)) && !D.isDashKey(123));
// 前端 HaPanel.vue 抄了一份同样的数组做勾选界面——两边必须逐项一致，只改一边会出现
// 「页面上勾不到这个图标」或「Material 缺字形渲染成一串字母」
const vueSrc = fs.readFileSync(path.join(ROOT, 'web/src/components/HaPanel.vue'), 'utf8');
const vm = vueSrc.match(/const CATEGORY_ICONS = \[([\s\S]*?)\];/);
const vueIcons = vm ? [...vm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
ck('HaPanel 勾选清单与服务端白名单逐项一致', Array.isArray(vueIcons) && vueIcons.join(',') === D.CATEGORY_ICONS.join(','),
  `服务端 ${D.CATEGORY_ICONS.length} 个 / 前端 ${vueIcons ? vueIcons.length : 0} 个`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
