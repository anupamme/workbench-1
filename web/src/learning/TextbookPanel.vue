<template>
  <div class="tb-wrap">
    <!-- 教材是独立 SPA（独立版 D:\CC\Textbook 同一套源码），由 scripts/sync-workbench.mjs
         拷到 web/public/textbook/，随后端静态托管在同源 /textbook/。同源 = 共用登录态，
         iframe 里的 api() 直接用 localStorage.wb_token 调 /api/textbook/*。 -->
    <iframe
      ref="frame"
      class="tb-frame"
      :src="url"
      allow="clipboard-read; clipboard-write"
      title="全科教材"
      @load="loaded = true"
    ></iframe>
    <div v-if="!loaded" class="tb-mask">教材加载中…</div>
  </div>
</template>

<script setup>
// 学习 → 教材 tab（v1.19.0）。整页嵌入，不用工作台自己的 1200px 限宽——
// 教材页是「目录 : 教材 : 笔记 = 1:4:3」的三栏，窄了 PDF 就没法看。
import { ref, onMounted, onBeforeUnmount, inject } from 'vue';
import { prefixUrl } from '../api';

const url = ref(prefixUrl('/textbook/'));
const loaded = ref(false);
const mainFull = inject('wbMainFull', null);

onMounted(() => { if (mainFull) mainFull.value = true; });
onBeforeUnmount(() => { if (mainFull) mainFull.value = false; });
</script>

<style scoped>
.tb-wrap { position: relative; height: calc(100vh - 132px); min-height: 520px; }
.tb-frame {
  display: block; width: 100%; height: 100%; border: 0;
  background: var(--panel, #fff); border-radius: 10px;
}
.tb-mask {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--muted, #888); font-size: 13px; pointer-events: none;
}
@media (max-width: 700px) {
  .tb-wrap { height: calc(100vh - 168px); min-height: 420px; }
}
</style>
