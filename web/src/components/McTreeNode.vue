<template>
  <div class="node">
    <div class="row" :class="{ sel: selected === childPath }" @click="click">
      <span class="ico material-icons">{{ open ? 'folder_open' : 'folder' }}</span>
      <span class="name" :title="entry.name">{{ entry.name }}</span>
    </div>
    <div v-if="open" class="children">
      <div v-if="loading" class="muted ld">加载中…</div>
      <div v-else-if="error" class="muted ld err">{{ error }}</div>
      <template v-else>
        <McTreeNode v-for="c in children" :key="c.name" :entry="c" :parent="childPath" :selected="selected" @select="(p) => $emit('select', p)" />
        <div v-if="!children.length" class="muted ld">（空目录）</div>
      </template>
    </div>
  </div>
</template>

<script setup>
// 音乐目录树节点：照 VsTreeNode 的懒加载展开套路，但音乐树只列目录（歌曲走右侧 /mc/library），
// 点目录 = 选中（emit 给 MusicPanel 切右侧列表）+ 就地展开。音乐树数据来自 /mc/tree 的 entries。
import { computed, ref } from 'vue';
import { api } from '../api';

const props = defineProps({ entry: Object, parent: String, selected: String });
const emit = defineEmits(['select']);

const open = ref(false);
const loading = ref(false);
const error = ref('');
const children = ref([]);

const childPath = computed(() => (props.parent ? props.parent + '/' + props.entry.name : props.entry.name));

async function click() {
  emit('select', childPath.value); // 点目录 = 右侧切到该目录歌曲列表
  open.value = !open.value;
  if (open.value && !children.value.length && !error.value) {
    loading.value = true;
    try {
      const r = await api.get('/mc/tree?dir=' + encodeURIComponent(childPath.value));
      children.value = r.entries || [];
    } catch (e) { error.value = e.message; }
    loading.value = false;
  }
}
</script>

<style scoped>
.node { font-size: 13px; }
.row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
.row:hover { background: var(--bg3); }
.row.sel { background: rgba(79, 124, 247, 0.18); }
.row .ico { flex-shrink: 0; font-size: 16px; color: var(--muted); }
.row.sel .ico { color: inherit; }
.row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.children { margin-left: 14px; border-left: 1px dashed var(--border); padding-left: 4px; }
.ld { padding: 3px 6px; font-size: 12px; }
.ld.err { color: var(--red); }
</style>
