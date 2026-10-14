<template>
  <div class="launcher-panel">
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- ============ ① 集中启动端安装包（一键全装） ============ -->
    <div class="card">
      <h3>🚀 集中启动端（Windows 托盘 · 一键全装）</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">
        双击一次安装包，<b>启动端 + 电脑监控 + 剪贴板采集 + 电子宠物 + 悬浮歌词 全部装好</b>（各自装到
        %LOCALAPPDATA% 并设开机自启；任务栏右下角出现<b>四方块图标</b>，与工作台首页图标同款）。
        装完在<b>托盘右键菜单</b>里勾选启用/停用各客户端：勾=启用（没在跑自动拉起，崩了 45 秒内看护重拉），
        去勾=停用，设置一次下次开机保持。菜单其余项：短消息通知两开关、录音转写算力就位状态、连接目标只读。
        <b>整体没有退出按钮</b>——要撤掉请用卸载包（一键卸载启动端与四个客户端）。
      </div>
      <div class="row" style="flex-wrap:wrap; gap:10px; align-items:center">
        <button class="primary" :disabled="pkgBusy" @click="dlHub()">⬇ 下载一键安装包（zip，约 8.5MB 含字体）</button>
        <button :disabled="pkgBusy" @click="dlHub('uninstall')">⬇ 卸载包</button>
        <button class="danger" @click="rotateKey">轮换密钥</button>
      </div>
      <div class="muted" style="font-size:12px; margin-top:8px">
        安装包内嵌下载者的身份（装到谁电脑上就弹谁的消息）与回连地址——内网浏览器打开本页下载即嵌内网地址、外网同理。
        电子宠物需先在宠物页打开桌面宠物开关，没开时安装包自动跳过（开起后再下载补装）；录音转写算力体积大不在此包，在下面单独装。
        轮换密钥后所有已装启动端立即失联，需重新下载安装包重装。
      </div>
    </div>

    <!-- ============ ② Windows 客户端 · 集中下载 ============ -->
    <div class="card">
      <h3>📦 Windows 客户端 · 集中下载</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">
        单独补装/重装某个客户端时用这里（与上面一键安装包里的完全同源；已随一键包装好的无需再装）。
        带 <code>.ps1 + 安装.bat</code> 两个文件的：放同一文件夹后双击 <code>安装.bat</code>；卸载包自包含可直接双击。
      </div>
      <table class="tb">
        <thead><tr><th style="width:130px">客户端</th><th>说明</th><th style="width:290px">下载</th></tr></thead>
        <tbody>
          <tr v-for="s in services" :key="s.key">
            <td><b>{{ s.name }}</b></td>
            <td class="muted" style="font-size:12.5px">{{ s.desc }}</td>
            <td>
              <button v-for="f in s.files" :key="f.label" class="mini" :disabled="busy === f.url"
                :title="f.title || ''" @click="dl(f)">{{ f.label }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ============ ③ 已上线电脑 ============ -->
    <div class="card">
      <h3>🖥 已上线电脑
        <button class="mini" style="margin-left:8px" @click="loadAgents()">↻ 刷新</button>
        <span class="muted" style="font-size:12px; font-weight:400; margin-left:8px">每 15 秒自动刷新 · {{ agents.length }} 台登记 · {{ onlineCount }} 台在线（{{ Math.round(onlineMs / 1000) }} 秒内有心跳）</span>
      </h3>
      <div v-if="!agents.length" class="muted">还没有电脑装过启动端——下载上面的安装包到 Windows 电脑双击安装，装好即出现在这里。</div>
      <table v-else class="tb">
        <thead><tr>
          <th>电脑</th><th>对接人</th><th>心跳</th><th>IP</th><th>各服务状态（启动端上报）</th><th style="width:130px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="a in agents" :key="a.id">
            <td>
              <input v-model="a._name" class="name-in" :placeholder="a.computer || a.id" @change="renameAgent(a)">
              <div class="muted" style="font-size:11px">{{ a.computer }} · {{ a.id }}</div>
            </td>
            <td>{{ a.user_name || '—' }}</td>
            <td><span class="badge" :class="a.online ? 'green' : 'gray'">{{ a.online ? '在线' : '离线' }}</span>
              <div class="muted" style="font-size:11px">{{ fmtAgo(a.last_seen) }}</div></td>
            <td class="muted" style="font-size:11.5px">{{ a.ip || '—' }}</td>
            <td><span v-for="c in chips(a)" :key="c.t" class="badge" :class="c.k" :title="c.tip || ''" style="margin:1px 3px 1px 0">{{ c.t }}</span></td>
            <td><button class="mini" @click="delAgent(a)">移除</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api';

const msg = ref('');
const msgType = ref('ok');
const busy = ref('');
const pkgBusy = ref(false);
const agents = ref([]);
const onlineMs = ref(60000);
let timer = null;

function flash(t, bad) { msg.value = t; msgType.value = bad ? 'err' : 'ok'; }

// ---------- ① 启动端安装包 ----------
async function dlHub(mode) {
  pkgBusy.value = true;
  try {
    if (mode === 'uninstall') await api.download('/launcher/agent/package?mode=uninstall', '启动端卸载包.zip');
    else await api.download('/launcher/agent/package', '启动端安装包.zip');
    flash('下载已开始（浏览器保存到下载目录）');
  } catch (e) { flash('下载失败：' + e.message, true); }
  pkgBusy.value = false;
}
async function rotateKey() {
  if (!confirm('轮换密钥后所有已安装的启动端立即失联，需要重新下载安装包并在各电脑重装。确定轮换？')) return;
  try { await api.post('/launcher/agent/rotate-key'); flash('密钥已轮换——请重新下载安装包并在各电脑重装'); }
  catch (e) { flash('轮换失败：' + e.message, true); }
}

// ---------- ② 各客户端集中下载（端点与各自功能页同源） ----------
const services = [
  {
    key: 'notify', name: '短消息通知', desc: '右下角弹新消息通知、语音消息自动播放；点击弹窗=已读并打开消息页。（启动端已内置同款能力，装其一即可）',
    files: [
      { label: '安装.cmd', url: '/messages/agent/script?type=install' },
      { label: '卸载', url: '/messages/agent/script?type=uninstall' },
    ],
  },
  {
    key: 'monitor', name: '电脑监控', desc: '按服务端配置定时截图上报（效率工具→电脑监控里配置）。装好后可在托盘菜单勾选启用/停用。',
    files: [
      { label: 'setup.ps1', url: '/monitor/agent-files?type=setup' },
      { label: '安装.bat', url: '/monitor/agent-files?type=install', title: '与 setup.ps1 放同一文件夹后双击' },
      { label: '卸载', url: '/monitor/agent-files?type=uninstall' },
    ],
  },
  {
    key: 'clipboard', name: '剪贴板采集', desc: '把这台电脑复制的文字自动采集进工作台剪贴板页（仅管理员数据）。装好后可在托盘菜单勾选启用/停用。',
    files: [
      { label: 'setup.ps1', url: '/clipboard/agent?type=setup' },
      { label: '安装.bat', url: '/clipboard/agent?type=install', title: '与 setup.ps1 放同一文件夹后双击' },
      { label: '卸载', url: '/clipboard/agent?type=uninstall' },
    ],
  },
  {
    key: 'pet', name: '电子宠物', desc: '桌面常驻宠物（需先在宠物页开启桌面宠物并保存）。可由启动端托盘显示/隐藏。',
    files: [
      { label: 'pet程序.ps1', url: '/pets/agent-files?type=petsetup', title: '宠物本体（桌面宠物开关没开时会提示）' },
      { label: '安装.bat', url: '/pets/agent-files?type=petinstall', title: '与 pet程序.ps1 放同一文件夹后双击' },
      { label: '卸载', url: '/pets/agent-files?type=petuninstall' },
    ],
  },
  {
    key: 'lyrics', name: '悬浮歌词', desc: '桌面置顶逐字歌词浮窗（跟随工作台「音乐」正在播放）。可由启动端托盘显示/隐藏。',
    files: [
      { label: '安装包.zip', url: '/mc/agent/package' },
      { label: '卸载.zip', url: '/mc/agent/package?mode=uninstall' },
    ],
  },
  {
    key: 'vibe', name: '录音转写算力', desc: '把这台电脑当转写算力（1.5B 纯 CPU / 7B 需 NVIDIA 显卡 + WSL2），NAS 太弱时真算力走客户端。托盘里显示模型就位状态与容量。',
    files: [
      { label: '1.5B 安装', url: '/vibe/client-files?type=setup&engine=vibeasr' },
      { label: '7B 安装', url: '/vibe/client-files?type=setup&engine=vibe7b' },
      { label: '1.5B 卸载', url: '/vibe/client-files?type=uninstall&engine=vibeasr' },
      { label: '7B 卸载', url: '/vibe/client-files?type=uninstall&engine=vibe7b' },
    ],
  },
];
async function dl(f) {
  busy.value = f.url;
  try { await api.download(f.url); }
  catch (e) { flash('下载失败：' + e.message + (String(e.message || '').includes('宠物') ? '（先去宠物页开启桌面宠物并保存）' : ''), true); }
  busy.value = '';
}

// ---------- ③ 已上线电脑 ----------
const onlineCount = computed(() => agents.value.filter((a) => a.online).length);
async function loadAgents() {
  try {
    const r = await api.get('/launcher/agents');
    agents.value = (r.agents || []).map((a) => ({ ...a, _name: a.name || '' }));
    onlineMs.value = r.online_ms || 60000;
  } catch { agents.value = []; }
}
async function renameAgent(a) {
  const v = String(a._name || '').trim();
  if (v === (a.name || '')) return;
  try { await api.put('/launcher/agents/' + encodeURIComponent(a.id), { name: v }); a.name = v; }
  catch (e) { flash('改名失败：' + e.message, true); }
}
async function delAgent(a) {
  if (!confirm(`从清单移除「${a.name || a.computer || a.id}」？（电脑再上线会重新登记；要彻底停用请在那台电脑跑卸载包）`)) return;
  try { await api.del('/launcher/agents/' + encodeURIComponent(a.id)); agents.value = agents.value.filter((x) => x.id !== a.id); }
  catch (e) { flash('删除失败：' + e.message, true); }
}
function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

// 各服务状态 chips：绿=在跑，蓝=已装未跑，灰=未装/未上报
function sv(a, k) { return (a.report && a.report[k]) || null; }
function chips(a) {
  const out = [];
  const n = sv(a, 'notify');
  if (n) out.push({ t: n.popup ? '弹通知' : '不弹通知', k: n.popup ? 'green' : 'gray' }, { t: n.voice ? '播语音' : '不播语音', k: n.voice ? 'green' : 'gray' });
  for (const [k, label] of [['monitor', '监控'], ['clipboard', '剪贴板'], ['pet', '宠物'], ['lyrics', '歌词']]) {
    const x = sv(a, k);
    if (!x) { out.push({ t: label + '未报', k: 'gray' }); continue; }
    if (x.running) out.push({ t: label + '✓', k: 'green' });
    else if (x.installed) out.push({ t: label + '停', k: 'blue' });
    else out.push({ t: label + '无', k: 'gray' });
  }
  const c = sv(a, 'compute');
  if (c) {
    const f = (e, name) => e && e.installed ? { t: name + ' ' + (e.gb || 0) + 'G', k: 'green' } : { t: name + ' 无', k: 'gray' };
    out.push(f(c.asr, 'ASR'), f(c.v7b, '7B'));
  }
  return out;
}

onMounted(() => {
  loadAgents();
  timer = setInterval(loadAgents, 15000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.launcher-panel { max-width: 1100px; }
.card { background: var(--bg2, #fff); border: 1px solid var(--line, #e5e7eb); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.card h3 { margin: 0 0 8px; font-size: 15px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.muted { color: var(--muted, #888); }
.msg { border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; font-size: 13px; }
.msg.ok { background: rgba(52, 168, 83, .12); color: var(--green, #34a853); }
.msg.err { background: rgba(220, 68, 55, .12); color: var(--red, #dc4437); }
.tb { width: 100%; border-collapse: collapse; font-size: 13px; }
.tb th { text-align: left; font-weight: 600; color: var(--muted, #888); padding: 6px 8px; border-bottom: 1px solid var(--line, #e5e7eb); font-size: 12px; }
.tb td { padding: 8px; border-bottom: 1px solid var(--line, #e5e7eb); vertical-align: top; }
.badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 1px solid transparent; }
.badge.green { background: rgba(52, 168, 83, .12); color: var(--green, #34a853); }
.badge.blue { background: rgba(45, 95, 217, .1); color: var(--blue, #2d5fd9); }
.badge.gray { background: rgba(130, 130, 130, .12); color: var(--muted, #888); }
button.mini { font-size: 12px; padding: 3px 8px; margin: 1px 4px 1px 0; border-radius: 6px; border: 1px solid var(--line, #d7dbe0); background: var(--bg, #f7f8fa); cursor: pointer; }
button.mini:hover { border-color: var(--blue, #2d5fd9); color: var(--blue, #2d5fd9); }
.name-in { border: 1px solid transparent; border-radius: 6px; padding: 2px 6px; font-size: 13px; background: transparent; width: 130px; }
.name-in:hover, .name-in:focus { border-color: var(--line, #d7dbe0); background: var(--bg, #f7f8fa); outline: none; }
</style>
