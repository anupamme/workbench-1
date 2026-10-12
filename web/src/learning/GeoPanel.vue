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

      <!-- 地球仪是第三方独立页面（自带完整性自检，必须原样加载、不能改写），
           所以用全高 iframe 原样嵌入——功能与单独打开完全一致。 -->
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
          <div>地球仪页面没有随本版前端一起发布（<code>geo/earth-globe.html</code> 取不到）。</div>
          <div class="muted">请让管理员用最新升级包重新部署一次；本页其余功能不受影响。</div>
        </div>
        <div v-if="!loaded && !checking && !missing" class="geo-mask">
          <span>正在加载地球仪（约 6 MB，含 8K 底图，首次稍慢）…</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 学习 → 地理 tab（v1.13.14）：把参考页「地球仪 · 3D模拟实验室 V0916-1」完整搬进工作台。
// 该页主脚本对自身做完整性自检（全文哈希 + 纹理首尾 + DOM 校验），任何改写都会让它自毁成
// 「页面完整性校验失败」——所以这里**只能原样托管 + iframe 嵌入**，不做任何源码移植/裁剪。
// 文件放在 web/public/geo/earth-globe.html（vite 原样拷进 dist 根，随升级包分发）。
import { ref, onMounted } from 'vue';
import { prefixUrl } from '../api';

// 同源相对地址（含 fnOS 网关 /app/{appname} 前缀）——iframe 的 src 不能用 /api 那套 token 拼接
const url = ref(prefixUrl('/geo/earth-globe.html'));
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
