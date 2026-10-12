<template>
  <div class="geo">
    <div class="card geo-card">
      <h3>
        🌏 地理 · 3D 地球仪
        <span class="muted geo-hint">
          拖动旋转 / 滚轮缩放 · 点一下地球看经纬度 · 右上角可切 2D 平面图
        </span>
        <a class="geo-open" :href="url" target="_blank" rel="noopener">↗ 新窗口打开</a>
      </h3>

      <!-- 地球仪是本站自制的独立页面（`geo/globe.html`，无第三方版权依赖），
           用全高 iframe 原样嵌入——功能与单独打开完全一致。 -->
      <div class="geo-frame-wrap">
        <iframe
          v-if="!checking && !missing"
          ref="frame"
          class="geo-frame"
          :src="url"
          allow="fullscreen"
          title="3D 地球仪"
          @load="loaded = true"
        ></iframe>
        <div v-else-if="checking" class="geo-state">正在加载地球仪…</div>
        <div v-else class="geo-state err">
          <div>地球仪页面没有随本版前端一起发布（<code>geo/globe.html</code> 取不到）。</div>
          <div class="muted">请让管理员用最新升级包重新部署一次；本页其余功能不受影响。</div>
        </div>
        <div v-if="!loaded && !checking && !missing" class="geo-mask">
          <span>正在加载地球仪（约 2.6 MB，含 5400×2700 底图，首次稍慢）…</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 学习 → 地理 tab（v1.13.15）：地球仪是本站自制页 `geo/globe.html`，源码在本仓库
// （web/public/geo/globe.html），无第三方版权依赖、无完整性自检——可以随时改。
// 历史：v1.13.14 嵌的是第三方页 earth-globe.html（© JZS LAB 尖子声原创，自带全文哈希
// 自检、只能原样托管），已按用户要求整套自研替换，那份文件已移出构建树。
// vite 把 web/public/** 原样拷进 dist 根，所以它随升级包分发。
import { ref, onMounted } from 'vue';
import { prefixUrl } from '../api';

// 同源相对地址（含 fnOS 网关 /app/{appname} 前缀）——iframe 的 src 不能用 /api 那套 token 拼接
const url = ref(prefixUrl('/geo/globe.html'));
const loaded = ref(false);
const checking = ref(true);
const missing = ref(false);

onMounted(async () => {
  // HEAD 探一下文件在不在：不在就直说「本版没带上」，别让用户对着白框猜
  try {
    const r = await fetch(url.value, { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) missing.value = true;
  } catch { /* 探不通就当它在（可能是网关拦了 HEAD），交给 iframe 自己表现 */ }
  checking.value = false;
});
</script>

<style scoped>
.geo-card { padding-bottom: 14px; }
.geo-hint { font-size: 12px; font-weight: 400; margin-left: 4px; }
.geo-open { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--accent, #4b8bf5); text-decoration: none; white-space: nowrap; }
.geo-open:hover { text-decoration: underline; }
/* 全高：页面本身带图例/坐标栏/全屏按钮，这里只留一条细标题，把高度几乎全给地球仪 */
.geo-frame-wrap { position: relative; height: calc(100vh - 210px); min-height: 520px; }
.geo-frame { width: 100%; height: 100%; border: 0; border-radius: 8px; background: #05070d; display: block; }
.geo-mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(5, 7, 13, .88); color: #cfd6e4; font-size: 13px; border-radius: 8px; pointer-events: none; }
.geo-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  background: #05070d; color: #cfd6e4; font-size: 13px; border-radius: 8px; text-align: center; padding: 20px; }
.geo-state.err { color: #ffb4b4; }
</style>
