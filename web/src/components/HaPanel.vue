<template>
  <div class="ha-panel">
    <!-- ==================== 子页签：仪表盘 / 配置 / 设备（v1.15.0 建；v1.16.1 起每次打开都落在仪表盘，不再记忆上次） ==================== -->
    <div class="ha-sub">
      <button :class="{ on: sub === 'dash' }" @click="sub = 'dash'">仪表盘</button>
      <button :class="{ on: sub === 'cfg' }" @click="sub = 'cfg'">配置</button>
      <button :class="{ on: sub === 'dev' }" @click="sub = 'dev'">设备</button>
    </div>
    <div v-if="err" class="msg err">{{ err }}</div>
    <div v-if="okMsg" class="msg ok">{{ okMsg }}</div>

    <!-- ==================== 仪表盘：全部接入设备卡片 + 左侧分类书签（图标页签）+ 拖动排序 ==================== -->
    <template v-if="sub === 'dash'">
      <div v-if="cfg && !wsOn" class="dim ha-dash-hint">
        <template v-if="cfg.has_token">Home Assistant 未连接{{ cfg.ws && cfg.ws.last_error ? `（${cfg.ws.last_error}）` : '' }}——</template>
        <template v-else>还没配置 Home Assistant 连接——</template>
        <a href="javascript:void(0)" @click="sub = 'cfg'">去【配置】页处理</a>
      </div>

      <div class="ha-dash-wrap">
        <!-- 书签式分类页签：只显图标（分类名在 title 悬浮提示）；分类在【设备】页设置 -->
        <div class="ha-rail">
          <button class="ha-rail-btn" :class="{ on: dashTab === '' }" title="全部" @click="dashTab = ''">
            <span class="material-icons">apps</span>
          </button>
          <button v-for="c in ents.cats" :key="c.id" class="ha-rail-btn" :class="{ on: dashTab === c.id }" :title="c.name" @click="dashTab = c.id">
            <span class="material-icons">{{ c.icon }}</span>
          </button>
        </div>

        <div class="ha-dash-main">
          <div v-if="loading && !ents.entities.length" class="dim" style="text-align:center;padding:32px">正在拉取设备…</div>
          <div v-else-if="!ents.entities.length" class="dim" style="text-align:center;padding:32px">
            {{ cfg && cfg.has_token ? 'HA 里还没有实体' : '先到【配置】页填地址与长期访问令牌' }}
          </div>
          <div v-else-if="!dashItems.length" class="dim" style="text-align:center;padding:32px">
            {{ dashTab
              ? '这个分类下还没有可见设备——到【设备】页把设备勾选「仪表盘可见」并归入分类'
              : '仪表盘默认不展示任何设备——勾选过的设备才会出现在这里' }}
            <div style="margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
              <button v-if="isAdmin" class="btn sm" :disabled="addingAll" @click="showAllDash">{{ addingAll ? '正在加入…' : '全部设备加入仪表盘' }}</button>
              <button class="btn sm" @click="sub = 'dev'">去设备页配置</button>
            </div>
          </div>

          <!-- 卡片区：整页不限宽，按屏幕宽度自适配；管理员可拖左上角把手排序 -->
          <div v-else class="ha-dcards">
            <!-- 单实体卡（无设备归属的实体 / 摄像头） -->
            <div v-for="it in dashItems" :key="it.key" :data-dk="it.key" class="ha-card-unit"
              :class="{ dragging: dragKey === it.key, gone: !it.rows.length }">
              <span v-if="isAdmin && it.rows.length" class="ha-grip material-icons"
                title="拖动排序" @pointerdown="dragStart(it.key, $event)">drag_indicator</span>
              <template v-if="it.kind === 'ent' && it.rows[0]">
                <div class="ha-ent-inner" @click="openDetail(it.rows[0])">
                  <img v-if="it.rows[0].domain === 'camera' && it.rows[0].online" class="ha-cam" :src="camUrl(it.rows[0])"
                    @error="it.rows[0].online = false" @click.stop="camTick++" @dblclick.stop="zoomCam = it.rows[0]" alt="" />
                  <!-- 数值传感器（温度/湿度等）直接大字显示，点击进详情看 24h 趋势 -->
                  <div v-else-if="isBigVal(it.rows[0])" class="ha-big ent">
                    <b>{{ bigNum(it.rows[0]) }}<i v-if="it.rows[0].unit">{{ it.rows[0].unit }}</i></b>
                    <span class="dim">{{ it.rows[0].name }}</span>
                    <span class="dim ha-big-hint">点击看 24 小时趋势</span>
                  </div>
                  <!-- 空调单实体卡：目标温度/目标湿度/当前室温（v1.16.2 按类别收敛） -->
                  <div v-else-if="it.view.nums.length" class="ha-bigs ent-nums">
                    <div v-for="(n, i) in it.view.nums" :key="i" class="ha-big">
                      <b><span v-if="n.icon" class="material-icons ha-num-ic">{{ n.icon }}</span>{{ n.val }}<i v-if="n.unit">{{ n.unit }}</i></b>
                      <span class="dim">{{ n.label }}</span>
                    </div>
                  </div>
                  <template v-else>
                    <span class="material-icons ha-icon">{{ iconOf(it.rows[0]) }}</span>
                    <div class="ha-name" :title="it.rows[0].entity_id">{{ it.rows[0].name }}</div>
                    <div class="ha-state" :class="{ on: it.rows[0].on }">{{ it.rows[0].online ? it.rows[0].state_text : '不可用' }}<span v-if="it.rows[0].unit" class="dim"> · {{ it.rows[0].unit }}</span></div>
                  </template>
                  <!-- 窗帘单实体卡：开合比例进度条（v1.16.2） -->
                  <div v-if="it.view.bar" class="ha-posbar" :title="`已开 ${it.view.bar.pct}%`">
                    <span class="ha-posbar-track"><span class="ha-posbar-fill" :style="{ width: it.view.bar.pct + '%' }"></span></span>
                    <span class="ha-posbar-txt">{{ it.view.bar.pct }}%</span>
                  </div>
                  <button v-if="it.rows[0].controllable && it.rows[0].online" class="ha-toggle" :class="{ on: it.rows[0].on, busy: toggling[it.rows[0].entity_id] }"
                    :title="it.rows[0].on ? '点击关闭' : '点击开启'" @click.stop="toggle(it.rows[0])"><span></span></button>
                </div>
              </template>
              <!-- 设备卡：同一设备下的实体归在一张卡里。v1.16.9 按用户重申的规格二次收紧：
                   卡上只有开关按钮（单路=右上角一个；多路=一排带名字的小开关）+ 该类别该有的内容，其余一律不上卡——
                   监控=预览图+一个主开关（v1.16.11：其余开关进设备页/详情）/ 温度计=温湿电量（不出开关）/
                   空调=目标温湿+当前室温+开关 / 灯光=开关 / 窗帘=开合比例条+开关 / 插座=开关+功率；认不出类别的也只出开关+数值。 -->
              <template v-else-if="it.rows.length">
                <div class="ha-dcard-head">
                  <b :title="`查看 ${it.title} 详情`" @click="it.view.primary && openDetail(it.view.primary)">{{ it.title }}</b>
                  <span class="dim">{{ it.area }}</span>
                </div>
                <!-- 单开关：右上角一个按钮——卡片的固定件，不再渲染整行实体 -->
                <button v-if="it.view.single" class="ha-toggle" :class="{ on: it.view.single.on, busy: toggling[it.view.single.entity_id] }"
                  :title="it.view.single.on ? '点击关闭' : '点击开启'" @click.stop="toggle(it.view.single)"><span></span></button>
                <div class="ha-dbody">
                  <div v-for="r in it.view.cams" :key="r.entity_id" class="ha-camwrap">
                    <img class="ha-cam" :src="camUrl(r)" @error="r.online = false" @click.stop="camTick++" @dblclick.stop="zoomCam = r" title="点击刷新画面，双击放大" alt="" />
                  </div>
                  <div v-if="it.view.nums.length" class="ha-bigs">
                    <div v-for="(n, i) in it.view.nums" :key="i" class="ha-big" title="点击看详情" @click="openDetail(n.e)">
                      <b><span v-if="n.icon" class="material-icons ha-num-ic">{{ n.icon }}</span>{{ n.val }}<i v-if="n.unit">{{ n.unit }}</i></b>
                      <span class="dim">{{ n.label }}</span>
                    </div>
                  </div>
                  <div v-if="it.view.bar" class="ha-posbar" :title="`已开 ${it.view.bar.pct}%`">
                    <span class="ha-posbar-track"><span class="ha-posbar-fill" :style="{ width: it.view.bar.pct + '%' }"></span></span>
                    <span class="ha-posbar-txt">{{ it.view.bar.pct }}%</span>
                  </div>
                  <!-- 没有数值/进度条/预览的卡（灯光类典型）：中间一个大图标 + 开关状态，卡不空、行内结构一致 -->
                  <div v-if="it.view.hero" class="ha-hero" @click="openDetail(it.view.hero)">
                    <span class="material-icons" :class="{ on: it.view.hero.on }">{{ iconOf(it.view.hero) }}</span>
                    <b :class="{ on: it.view.hero.on }">{{ it.view.hero.online ? it.view.hero.state_text : '不可用' }}</b>
                  </div>
                  <!-- 多路可控（双路开关/插线板/监控+风机等）：一排小开关各带名字，不占整行 -->
                  <div v-if="it.view.sws.length > 1" class="ha-swrow">
                    <div v-for="r in it.view.sws" :key="r.entity_id" class="ha-sw" @click="openDetail(r)">
                      <button class="ha-toggle sm" :class="{ on: r.on, busy: toggling[r.entity_id] }"
                        :title="r.on ? '点击关闭' : '点击开启'" @click.stop="toggle(r)"><span></span></button>
                      <span class="ha-sw-name" :title="r.entity_id">{{ r.name }}</span>
                    </div>
                  </div>
                </div>
              </template>
              <div v-else class="dim" style="font-size:12px;padding:8px 4px">设备已不在线上清单里——到【设备】页取消可见</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 配置：连接状态 / 连接配置 / 语音设备来源 / Webhook / 服务调试 / 事件 ==================== -->
    <template v-else-if="sub === 'cfg'">
      <div class="card ha-status">
        <span class="ha-dot" :class="{ on: wsOn }"></span>
        <b>{{ wsOn ? '已连接' : '未连接' }}</b>
        <span v-if="cfg" class="dim">
          · {{ cfg.config.url || '未配内网地址' }}<template v-if="cfg.config.url_external"> / {{ cfg.config.url_external }}</template>
        </span>
        <span v-if="onExternal" class="ha-warn" :title="`内网地址连不上，当前实际走 ${cfg.ws.url}`">· 正走外网地址（内网未通）</span>
        <span v-if="cfg && cfg.version" class="dim">· HA {{ cfg.version }}<template v-if="cfg.location_name"> · {{ cfg.location_name }}</template></span>
        <span v-if="cfg" class="dim">· 语音来源：{{ srcLabel(cfg.config.device_source) }}</span>
        <!-- 全局开关（v1.15.1 从仪表盘挪来）：要么所有摄像头缩略图都自动刷新，要么都不刷；点图仍可手动刷新 -->
        <label v-if="hasCamera" class="ha-radio" title="开启后摄像头缩略图每 15 秒自动刷新（全局生效）；关闭后点图片仍可手动刷新"><input type="checkbox" v-model="camAuto" />摄像头画面自动刷新</label>
        <span style="flex:1"></span>
        <button class="btn sm" :disabled="loading" @click="loadAll(true)">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
      <div v-if="cfg && !wsOn && cfg.ws && cfg.ws.last_error" class="msg err">WebSocket：{{ cfg.ws.last_error }}（实体一览仍可用 REST 轮询，实时推送要连上才生效）</div>

      <div v-if="isAdmin" class="card">
        <h3 style="margin:0 0 12px">连接配置</h3>
        <div v-if="!cfg" class="dim" style="padding:8px 0">加载中…</div>
        <template v-else>
          <div class="ha-form">
            <label>内网地址（局域网直连，优先使用）</label>
            <input v-model="form.url" placeholder="http://192.168.110.105:8123" />
            <label>外网地址（可选；内网不通时自动改走这里）</label>
            <input v-model="form.url_external" placeholder="https://ha.example.com" />
            <label>长期访问令牌（LLAT）</label>
            <input type="password" v-model="form.token" autocomplete="new-password"
              :placeholder="cfg.has_token ? '已保存（留空 = 保持不变）' : 'HA 左下角头像 → 安全 → 长期访问令牌 → 创建令牌'" />
            <label>注册表缓存（分钟）——区域/设备/实体清单的有效期</label>
            <input v-model.number="form.cache_ttl_min" type="number" min="1" max="1440" style="max-width:120px" />
            <div class="ha-row">
              <button class="btn sm" :disabled="testing" @click="doTest">{{ testing ? '测试中…' : '测试连接（可用未保存的值）' }}</button>
              <button class="btn" :disabled="saving" @click="doSave">{{ saving ? '保存中…' : '保存配置' }}</button>
            </div>
            <div v-if="testResult" :class="testResult.ok ? 'msg ok' : 'msg err'">
              {{ testResult.ok
                ? `连通：${testResult.base}${testResult.version ? ` · HA ${testResult.version}` : ''} · ${testResult.latency_ms}ms`
                : testResult.error }}
            </div>
          </div>

          <hr class="ha-hr" />
          <h3 style="margin:0 0 6px">语音设备来源</h3>
          <p class="dim" style="margin:0 0 8px;font-size:13px">
            决定「数字人」与「智能板（贾维斯）」的语音控制走哪边——两个面板的设备列表与快捷开关同步生效，别名表共用。
          </p>
          <div class="ha-row">
            <label class="ha-radio"><input type="radio" value="mihome" v-model="form.device_source" />只走米家</label>
            <label class="ha-radio"><input type="radio" value="ha" v-model="form.device_source" />只走 Home Assistant</label>
            <label class="ha-radio"><input type="radio" value="both" v-model="form.device_source" />两者合并</label>
          </div>
          <p class="dim" style="margin:8px 0 0;font-size:12px">{{ srcHint(form.device_source) }}</p>

          <hr class="ha-hr" />
          <h3 style="margin:0 0 6px">Webhook 反向回调</h3>
          <p class="dim" style="margin:0 0 8px;font-size:13px">
            把下面的地址填进 HA 自动化的 RESTful 动作（方法 POST、JSON 里带 title/message），HA 那边的事件就会实时出现在下方「事件」区。
            key 即凭证，免登录但仅登记事件——不在工作台执行任何动作。
          </p>
          <div class="ha-row">
            <input class="ha-hook" readonly :value="cfg.hook_url" @focus="$event.target.select()" />
            <button class="btn sm" @click="copyHook">复制</button>
            <button class="btn sm danger" @click="rotateHook">轮换 key</button>
          </div>
        </template>
      </div>
      <div v-else-if="cfg" class="card dim" style="font-size:13px">
        连接配置与语音设备来源由管理员维护（当前：{{ srcLabel(cfg.config.device_source) }}）。
      </div>

      <!-- 服务调用调试（管理员） -->
      <div v-if="isAdmin" class="card">
        <h3 style="margin:0 0 6px">服务调用（调试）</h3>
        <p class="dim" style="margin:0 0 10px;font-size:13px">
          直接调 HA 的任意服务（等价于 HA 开发者工具 → 服务）。仪表盘按键已经覆盖常用场景，这里是兜底——调亮度/色温/温度目标值等。
        </p>
        <div v-if="!services.length" class="ha-row">
          <button class="btn sm" :disabled="svcLoading" @click="loadServices">{{ svcLoading ? '载入中…' : '载入服务目录' }}</button>
        </div>
        <template v-else>
          <div class="ha-row">
            <select v-model="svcForm.domain" style="max-width:180px">
              <option v-for="d in svcDomains" :key="d" :value="d">{{ d }}</option>
            </select>
            <select v-model="svcForm.service" style="max-width:220px">
              <option v-for="s in svcServices" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <textarea v-model="svcForm.data" rows="3" class="ha-json" placeholder='服务数据 JSON，如 {"entity_id": "light.ceiling", "brightness": 128}'></textarea>
          <div class="ha-row" style="margin-top:8px">
            <button class="btn sm" :disabled="svcBusy" @click="runService">{{ svcBusy ? '执行中…' : '执行' }}</button>
            <span v-if="svcResult" :class="svcResult.ok ? 'dim' : 'ha-err'" style="font-size:12px">{{ svcResult.text }}</span>
          </div>
        </template>
      </div>

      <!-- 事件（SSE 实时 + webhook 流水） -->
      <div class="card">
        <div class="ha-toolbar">
          <h3 style="margin:0;font-size:15px">事件</h3>
          <label class="ha-radio"><input type="checkbox" v-model="liveOn" />实时推送{{ liveOn ? '' : '（关闭）' }}</label>
          <span style="flex:1"></span>
          <button class="btn sm" @click="loadHooklog">刷新流水</button>
        </div>
        <div v-if="!liveEvents.length && !hookEvents.length" class="dim" style="font-size:13px;padding:8px 0">
          还没有事件：状态变化（开了个灯、温度变了）会实时出现在这里；HA 自动化打 webhook 也会留一条流水。
        </div>
        <div v-for="ev in mergedEvents" :key="ev.k" class="ha-evt">
          <span class="ha-evt-time">{{ fmtTime(ev.ts) }}</span>
          <span class="ha-evt-tag" :class="ev.source">{{ ev.tag }}</span>
          <span style="flex:1">{{ ev.text }}</span>
        </div>
      </div>
    </template>

    <!-- ==================== 设备：分类管理 + 全部设备（同设备实体框在一起）+ 仪表盘可见/分类/别名 ==================== -->
    <template v-else>
      <!-- 设备分类（管理员）：名称 + 单色图标勾选；页签用图标 -->
      <div v-if="isAdmin" class="card">
        <div class="ha-toolbar">
          <h3 style="margin:0;font-size:15px">设备分类</h3>
          <span class="dim" style="font-size:12px">分类会变成仪表盘左侧的书签页签（只显图标，悬浮出名称）</span>
          <span style="flex:1"></span>
          <button class="btn sm" @click="addCat">＋ 新增分类</button>
          <button class="btn sm" :disabled="!catDirty || savingCats" @click="saveCats">{{ savingCats ? '保存中…' : catDirty ? '保存分类' : '已保存' }}</button>
        </div>
        <div v-if="!catDraft.length" class="dim" style="font-size:13px;padding:6px 0">还没有分类——新增几个（如「灯光」「窗帘」「摄像头」），再到下面给设备归类。</div>
        <div v-for="(c, i) in catDraft" :key="i" class="ha-cat-row">
          <button class="ha-cat-ic" :title="'换图标（当前 ' + c.icon + '）'" @click="iconPicker = iconPicker === i ? -1 : i">
            <span class="material-icons">{{ c.icon }}</span>
          </button>
          <input v-model="c.name" maxlength="16" placeholder="分类名称（1~16 字）" style="max-width:220px" />
          <span class="dim" style="font-size:12px">图标与名称确定后记得右上「保存分类」</span>
          <span style="flex:1"></span>
          <button class="btn sm danger" @click="delCat(i)">删除</button>
          <div v-if="iconPicker === i" class="ha-icon-grid">
            <button v-for="ic in CATEGORY_ICONS" :key="ic" type="button" :class="{ on: c.icon === ic }" :title="ic" @click="c.icon = ic; iconPicker = -1">
              <span class="material-icons">{{ ic }}</span>
            </button>
          </div>
        </div>
      </div>
      <div v-else-if="ents.cats && ents.cats.length" class="card dim" style="font-size:13px">
        设备分类由管理员维护，当前 {{ ents.cats.length }} 个：{{ ents.cats.map((c) => c.name).join('、') }}。
      </div>

      <!-- 全部设备：同一设备下的功能框在一起，不与其他设备混淆 -->
      <div class="card">
        <div class="ha-toolbar">
          <input v-model="devQ" placeholder="搜索设备 / 实体 / entity_id" style="flex:1;min-width:160px" />
          <select v-model="devArea">
            <option value="">全部区域</option>
            <option v-for="a in ents.areas" :key="a.area_id" :value="a.area_id">{{ a.name }}（{{ a.count }}）</option>
            <option value="__none__">未分区</option>
          </select>
          <label class="ha-radio"><input type="checkbox" v-model="devOnlyCtl" />只看可控</label>
          <span class="dim" style="font-size:13px">{{ devGroups.length }} 个{{ devOnlyCtl ? '可控' : '' }}设备/单实体 · {{ entCount }} 个实体</span>
          <span style="flex:1"></span>
          <button class="btn sm" :disabled="loading" @click="loadAll(true)">{{ loading ? '刷新中…' : '刷新' }}</button>
        </div>
        <div v-if="ents.degraded" class="dim" style="font-size:12px;margin-bottom:8px">
          注册表缓存为降级状态（WebSocket 拿不到区域清单，实体归「未分区」）——点右上「刷新」重试。
        </div>

        <div v-if="loading && !ents.entities.length" class="dim" style="text-align:center;padding:24px">正在拉取实体…</div>
        <div v-else-if="!ents.entities.length" class="dim" style="text-align:center;padding:24px">
          {{ cfg && cfg.has_token ? 'HA 里还没有实体' : '先到【配置】页（管理员）配置地址与令牌' }}
        </div>
        <div v-else-if="!devGroups.length" class="dim" style="text-align:center;padding:24px">没有匹配筛选条件的设备</div>

        <!-- 设备框：一个设备一个框（无设备归属的实体单独成框） -->
        <div v-else class="ha-devlist">
          <div v-for="b in devGroups" :key="b.key" class="ha-devbox">
            <div class="ha-devbox-head">
              <span class="material-icons ha-devbox-tag" :title="b.kind === 'dev' ? '同一设备的实体框在一起' : '无设备归属的单实体'">{{ b.kind === 'dev' ? 'device_hub' : 'widgets' }}</span>
              <b>{{ b.title }}</b>
              <span v-if="b.sub" class="dim" style="font-size:12px">{{ b.sub }}</span>
              <span class="ha-area-tag">{{ b.area }}</span>
              <span style="flex:1"></span>
              <template v-if="isAdmin">
                <label class="ha-radio" title="勾上后这个设备（及其全部实体）出现在仪表盘；默认不可见"><input type="checkbox" :checked="dashOf(b.key).visible" @change="setDash(b.key, { visible: $event.target.checked })" />仪表盘可见</label>
                <select :value="dashOf(b.key).cat" title="归入哪个分类（仪表盘左侧书签）" @change="setDash(b.key, { cat: $event.target.value })">
                  <option value="">（不分类）</option>
                  <option v-for="c in ents.cats" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </template>
              <span v-else-if="dashOf(b.key).visible" class="dim" style="font-size:12px">已在仪表盘{{ dashOf(b.key).cat ? ' · ' + catName(dashOf(b.key).cat) : '' }}</span>
            </div>
            <div v-for="r in b.rows" :key="r.entity_id" class="ha-crow" :class="{ hiddenRow: r.hidden }" @click="openDetail(r)">
              <span v-if="r.hidden" class="ha-hidden-tag">隐藏</span>
              <span class="material-icons ha-crow-ic">{{ iconOf(r) }}</span>
              <span class="ha-crow-name" :title="r.entity_id">{{ r.name }}</span>
              <span class="ha-crow-state" :class="{ on: r.on }">{{ r.online ? r.state_text : '不可用' }}<template v-if="r.unit"> · {{ r.unit }}</template></span>
              <input v-if="isAdmin && r.voice" class="ha-alias-in" :value="aliasOf(r.entity_id)" placeholder="语音别名"
                title="给数字人/智能板贾维斯起个好叫的名字（留空=用本名；别名登记后本名退出语音匹配）"
                @click.stop @change="saveAliasFor(r.entity_id, $event.target.value)" />
              <button v-if="r.controllable && r.online" class="ha-toggle sm" :class="{ on: r.on, busy: toggling[r.entity_id] }"
                :title="r.on ? '点击关闭' : '点击开启'" @click.stop="toggle(r)"><span></span></button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 实体详情弹层（三个子页共用） ==================== -->
    <div v-if="detail" class="ha-mask" @click.self="closeDetail">
      <div class="ha-modal">
        <div class="ha-modal-head">
          <b>{{ detail.e.name }}</b>
          <span class="dim" style="font-size:12px">{{ detail.e.entity_id }}</span>
          <span style="flex:1"></span>
          <button class="btn sm ghost" @click="closeDetail">关闭</button>
        </div>
        <div class="ha-modal-body">
          <!-- 摄像头详情：顶部直接给当前帧预览（v1.15.1 用户要求恢复监控预览截图） -->
          <div v-if="detail.e.domain === 'camera' && detail.e.online" class="ha-detail-cam">
            <img :src="camUrl(detail.e)" @error="detail.e.online = false" @click="camTick++" @dblclick="zoomCam = detail.e" alt="" />
            <div class="dim" style="font-size:12px;margin-top:4px">点图片刷新当前帧，双击放大{{ camAuto ? '（已开自动刷新，每 15 秒）' : '（自动刷新在【配置】页关闭着）' }}</div>
          </div>
          <div class="ha-kv"><span>状态</span><b :class="{ on: detail.e.on }">{{ detail.e.state_text }}</b></div>
          <div class="ha-kv"><span>区域</span><b>{{ detail.e.area }}</b></div>
          <div class="ha-kv"><span>类型</span><b>{{ detail.e.label }}（{{ detail.e.domain }}）</b></div>
          <div v-if="detail.e.device_name" class="ha-kv"><span>所属设备</span><b>{{ detail.e.device_name }}</b></div>
          <div class="ha-kv"><span>最后变化</span><b>{{ detail.e.last_changed ? new Date(detail.e.last_changed).toLocaleString() : '—' }}</b></div>
          <template v-if="isAdmin && detail.e.voice">
            <div class="ha-kv"><span>语音别名</span></div>
            <div class="ha-row">
              <input v-model="detail.alias" placeholder="给语音起个好叫的名字（留空=用本名）" style="flex:1" />
              <button class="btn sm" :disabled="detail.savingAlias" @click="saveAlias">{{ detail.savingAlias ? '保存中…' : '保存别名' }}</button>
            </div>
            <p class="dim" style="font-size:12px;margin:4px 0 0">别名登记后本名退出语音匹配（与米家设备共用一套别名表，数字人/智能板立即生效）。设备页里也能直接改。</p>
          </template>

          <h4 style="margin:14px 0 6px">近 24 小时</h4>
          <div v-if="detail.histLoading" class="dim" style="font-size:13px">加载中…</div>
          <svg v-else-if="detail.points && detail.points.length > 1" viewBox="0 0 280 64" class="ha-spark">
            <polyline :points="sparkPoints" fill="none" stroke="var(--accent, #4f8cff)" stroke-width="1.5" />
          </svg>
          <div v-else class="dim" style="font-size:13px">无历史记录</div>

          <h4 style="margin:14px 0 6px">属性</h4>
          <div class="ha-attrs">
            <div v-for="(v, k) in detail.e.attributes" :key="k" class="ha-attr">
              <span>{{ k }}</span><b>{{ attrText(v) }}</b>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 监控截图放大层（v1.16.11）：任何预览图双击放大，点击任意处关闭；自动刷新开着时放大图同样每 15 秒换帧 ==================== -->
    <div v-if="zoomCam" class="ha-zoom" title="点击任意处关闭" @click="zoomCam = null">
      <img :src="camUrl(zoomCam)" @error="zoomCam.online = false" alt="" />
      <div class="ha-zoom-cap">{{ zoomCam.name }}<span class="dim">（点击任意处关闭）</span></div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, inject } from 'vue';
import { api, rawUrl } from '../api';

// HA 实体域 → Material 图标（缺失的名字实测会渲染成一串字母，这几个都是常见字形）
const ICONS = {
  light: 'lightbulb', switch: 'power_settings_new', fan: 'air', climate: 'device_thermostat',
  cover: 'curtains', humidifier: 'water_drop', water_heater: 'hot_tub', media_player: 'speaker',
  input_boolean: 'toggle_on', lock: 'lock', scene: 'auto_awesome', script: 'code',
  automation: 'schedule', vacuum: 'cleaning_services', siren: 'notifications_active',
  button: 'smart_button', camera: 'photo_camera', sensor: 'sensors', binary_sensor: 'sensors',
  weather: 'partly_cloudy_day', person: 'person', device_tracker: 'location_on',
  alarm_control_panel: 'security', update: 'system_update', sun: 'wb_sunny', zone: 'place',
  timer: 'timer', calendar: 'calendar_month', todo: 'checklist', input_number: 'pin',
  input_select: 'checklist', input_text: 'text_fields',
};
// 分类图标白名单 —— 必须与 server/services/haDomains.js 的 CATEGORY_ICONS 逐项一致
// （check-ha-guards 断言两边相等：只改一边会出现「页面上勾不到」或「渲染成一串字母」）
const CATEGORY_ICONS = [
  'home', 'lightbulb', 'curtains', 'photo_camera', 'air', 'device_thermostat',
  'tv', 'speaker', 'lock', 'sensors', 'water_drop', 'hot_tub', 'power_settings_new',
  'cleaning_services', 'security', 'kitchen', 'garage', 'yard', 'directions_car', 'pets',
];
const SRC_LABELS = { mihome: '米家', ha: 'Home Assistant', both: '米家 + Home Assistant' };
const SRC_HINTS = {
  mihome: '行为与接入 HA 之前完全一致：语音只认米家设备。',
  ha: '语音只认 HA 实体（灯/开关/风扇/温控/窗帘/加湿器/热水器/播放器/虚拟开关），米家设备退出语音。',
  both: '两边设备合并成一张表，重名设备可用别名消歧；一边掉线另一边照常可用。',
};

// ---------- 子页签 + 整页放宽（wbMainFull，GeoPanel 先例） ----------
// v1.16.1（用户要求）：每次打开 HomeAssistant 页都落在【仪表盘】——原先按 localStorage 记忆上次子页签，
// 上次停在「配置」时再进来看到的还是配置页，仪表盘像是不见了。子页签仍可自由切换，只是不再跨次记忆。
const sub = ref('dash');
try { localStorage.removeItem('ha_sub'); } catch { /* 忽略 */ }
const mainFull = inject('wbMainFull', null);

const cfg = ref(null);
const isAdmin = ref(false);
const form = reactive({ url: '', url_external: '', token: '', device_source: 'mihome', cache_ttl_min: 5 });
const testing = ref(false), saving = ref(false);
const testResult = ref(null);
const err = ref(''), okMsg = ref('');
const loading = ref(false);
const ents = ref({ entities: [], areas: [], at: 0, degraded: false, devices: [], cats: [], dash: {} });
const toggling = reactive({});
// 摄像头自动刷新：全局开关（v1.15.1 从仪表盘挪进配置页）——要么都刷，要么都不刷；localStorage 记忆
const camTick = ref(0), camAuto = ref(localStorage.getItem('ha_cam_auto') !== '0');
const zoomCam = ref(null); // 监控截图放大层（v1.16.11）：双击预览图打开，点击关闭
watch(camAuto, (v) => localStorage.setItem('ha_cam_auto', v ? '1' : '0'));
let camTimer = null, cfgTimer = null, entTimer = null;

// 服务调试（配置页）
const services = ref([]), svcLoading = ref(false), svcBusy = ref(false);
const svcForm = reactive({ domain: '', service: '', data: '{}' });
const svcResult = ref(null);

// 事件（配置页；SSE 全局开着——仪表盘卡片的状态也靠它实时打补丁）
const liveOn = ref(true), liveEvents = ref([]), hookEvents = ref([]);
let es = null;
const detail = ref(null);

// 语音别名（设备页；did=entity_id，与米家共用一张表）
const aliasMap = ref({});
let aliasLoaded = false;

const wsOn = computed(() => !!(cfg.value && cfg.value.ws && cfg.value.ws.connected));
// 已连上但实际走的是外网地址（内网地址没通）——状态条如实说出来，别让用户猜「为什么内网还走域名」
const onExternal = computed(() => {
  const c = cfg.value;
  if (!c || !c.ws || !c.ws.connected) return false;
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '');
  const cur = norm(c.ws.url), inner = norm(c.config.url);
  return !!inner && !!cur && cur !== inner;
});
const hasCamera = computed(() => ents.value.entities.some((e) => e.domain === 'camera' && e.online)); // 供配置页开关提示等使用

function authUrl(path) {
  const t = localStorage.getItem('wb_token') || '';
  const u = rawUrl(path);
  return u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}
function camUrl(e) {
  return authUrl('/api/ha/camera/' + encodeURIComponent(e.entity_id)) + '&t=' + camTick.value;
}
function iconOf(e) { return ICONS[e.domain] || 'widgets'; }
function srcLabel(s) { return SRC_LABELS[s] || s; }
function srcHint(s) { return SRC_HINTS[s] || ''; }
function catName(id) { const c = (ents.value.cats || []).find((x) => x.id === id); return c ? c.name : ''; }
function flashOk(m) { okMsg.value = m; setTimeout(() => { if (okMsg.value === m) okMsg.value = ''; }, 4000); }

// ==================== 仪表盘 ====================
const dashTab = ref(''); // '' = 全部；否则分类 id（页签只显图标）
// 数值传感器（温度/湿度等）→ 卡片上大字显示（点击进详情看 24h 趋势图）
function isBigVal(e) {
  return e.domain === 'sensor' && e.online && String(e.state).trim() !== '' && Number.isFinite(Number(e.state));
}
function bigNum(e) { return String(Number(e.state)); }

// —— v1.16.2（用户要求）：仪表盘卡片按设备类别收敛内容，只留该类该显示的 ——
// 规则（用户原话）：① 监控类只显示预览图 + 开关按钮 ② 温度计类只显示温度/湿度/电池电量（电量可带图标）
// ③ 空调类只显示目标温度/目标湿度/当前室温/开关 ④ 灯光类主要显示开关
// ⑤ 窗帘类显示开关比例进度条 + 开关按钮 ⑥ 插座类显示开关 + 目前功耗/功率。
// 认不出类别的设备走 plain 分支（旧行为原样：大字数显 + 常规行），不会因为这次收敛而少控制项。
const ENV_ICONS = { temp: 'thermostat', humid: 'water_drop', batt: 'battery_full' };
function envKind(e) {
  if (!e.online || e.domain !== 'sensor') return '';
  const a = e.attributes || {};
  const dc = String(a.device_class || '').toLowerCase();
  const unit = String(a.unit_of_measurement || '');
  const nm = String(e.name || '');
  if (dc === 'battery' || /电量|电池/.test(nm) || /battery/i.test(nm)) return 'batt';
  if (dc === 'temperature' || /°[CF]|℃/.test(unit)) return 'temp';
  if (dc === 'humidity' || /湿度/.test(nm)) return 'humid';
  return '';
}
// 插座类的功率字段各家集成命名不一（米家/涂鸦/ESPHome 都不一样），按常见键取第一个有限值
const POWER_KEYS = ['current_power_w', 'current_power', 'power', 'active_power', 'instantaneous_power', 'load_power', 'apparent_power', 'power_consumption'];
function watts(e) {
  const a = (e && e.attributes) || {};
  for (const k of POWER_KEYS) { const n = Number(a[k]); if (Number.isFinite(n)) return n; }
  return null;
}
// 窗帘开合比例（HA 用 current_position，部分集成叫 position）
function posOf(e) {
  const a = (e && e.attributes) || {};
  for (const k of ['current_position', 'position']) {
    const n = Number(a[k]);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  }
  return null;
}
// 空调卡上的三个数：只显示设备真报上来的（HA 缺哪个就没哪个）；e=源实体，点击进详情
function climateNums(e) {
  const a = (e && e.attributes) || {};
  const out = [];
  for (const [k, label, unit] of [['temperature', '目标温度', '°C'], ['humidity', '目标湿度', '%'], ['current_temperature', '当前室温', '°C']]) {
    const n = Number(a[k]);
    if (Number.isFinite(n)) out.push({ icon: '', label, val: n, unit, e });
  }
  return out;
}
// 一张卡的内容清单（v1.16.9 二次收紧）：cams=预览图 / nums=数值块（e=源实体） / bar=开合比例 /
// sws=卡上要出的开关（类别域优先，没有才落到全部可控在线实体）；single=恰好一路可控 → 右上角单开关；
// hero=没有类别内容（无数值/进度条/预览）时中间的大图标+状态（灯光典型，卡不空）；primary=卡片代表实体（点名称进详情）。
function buildView(rows) {
  const ctl = rows.filter((r) => r.controllable && r.online);
  const swsOf = (pref) => {
    const hit = pref ? ctl.filter((r) => pref.includes(r.domain)) : ctl;
    return hit.length ? hit : ctl;
  };
  let v;
  const cams = rows.filter((r) => r.domain === 'camera' && r.online);
  if (cams.length) {
    // v1.16.11（用户要求）：监控类卡上只要一个「主开关」——switch 域优先取第一个可控实体，
    // 没有才落到第一个可控；其余可控开关一律不上卡（设备页/实体详情里都全量可操作）。
    v = { cls: 'camera', cams, nums: [], bar: null, sws: swsOf(['switch', 'input_boolean']).slice(0, 1) };
  } else if (rows.some((r) => r.domain === 'climate')) {
    v = { cls: 'climate', cams: [], nums: climateNums(rows.find((r) => r.domain === 'climate')), bar: null, sws: swsOf(['climate']) };
  } else if (rows.some((r) => r.domain === 'cover')) {
    const cov = rows.find((r) => r.domain === 'cover');
    const pct = posOf(cov);
    v = { cls: 'cover', cams: [], nums: [], bar: pct == null ? null : { pct }, sws: swsOf(['cover']) };
  } else if (rows.some((r) => r.domain === 'light')) {
    v = { cls: 'light', cams: [], nums: [], bar: null, sws: swsOf(['light', 'switch', 'input_boolean']) };
  } else if (rows.some((r) => watts(r) != null)) {
    const plugs = rows.filter((r) => watts(r) != null);
    v = {
      cls: 'plug', cams: [], bar: null, sws: swsOf(['switch', 'light', 'input_boolean']),
      nums: plugs.map((r) => ({ icon: 'bolt', label: plugs.length > 1 ? r.name : '功率', val: watts(r), unit: 'W', e: r })),
    };
  } else if (rows.some((r) => envKind(r))) {
    const env = rows.map((r) => ({ r, k: envKind(r) })).filter((x) => x.k);
    // 温度计类按规格不出开关：只显示温度/湿度/电池电量（电量带图标）
    v = { cls: 'env', cams: [], bar: null, sws: [], nums: env.map((x) => ({ icon: ENV_ICONS[x.k], label: x.r.name, val: Number(x.r.state), unit: x.r.unit || (x.k === 'batt' ? '%' : ''), e: x.r })) };
  } else {
    // 认不出类别的也收敛：只出开关 + 数值大字（旧的杂项信息行不上卡，设备页/详情里都有）
    v = { cls: 'plain', cams: [], bar: null, sws: ctl, nums: rows.filter((r) => isBigVal(r)).map((r) => ({ icon: '', label: r.name, val: Number(r.state), unit: r.unit || '', e: r })) };
  }
  v.single = v.sws.length === 1 ? v.sws[0] : null;
  v.hero = !v.cams.length && !v.nums.length && !v.bar && v.sws.length <= 1
    ? (v.single || ctl[0] || rows.find((r) => r.online) || rows[0] || null) : null;
  v.primary = v.cams[0] || v.single || ctl[0] || (v.nums[0] && v.nums[0].e) || rows[0] || null;
  return v;
}
function cardOf(k) {
  if (k.startsWith('dev:')) {
    const id = k.slice(4);
    const d = (ents.value.devices || []).find((x) => x.id === id);
    const rows = ents.value.entities.filter((e) => e.device_id === id && !e.hidden);
    return { kind: 'dev', key: k, title: (d && d.name) || (rows[0] && rows[0].device_name) || id, area: (d && d.area) || '', rows, view: buildView(rows) };
  }
  const e = ents.value.entities.find((x) => x.entity_id === k.slice(4));
  const rows = e && !e.hidden ? [e] : [];
  return { kind: 'ent', key: k, title: e ? e.name : k.slice(4), area: e ? e.area : '', rows, view: buildView(rows) };
}
const dashItems = computed(() => {
  const d = ents.value.dash || {};
  const out = Object.entries(d)
    .filter(([k, v]) => v && v.visible === true && (!dashTab.value || v.cat === dashTab.value))
    .map(([k, v]) => ({ ...cardOf(k), sort: v.sort || 0 }));
  out.sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : 1));
  return out;
});

// 拖动排序（手写 pointer 事件：鼠标/触屏通吃，零新依赖；升级链不跑 npm install）
// 思路：pointerdown 在把手上起拖 → move/up 挂 window（指针离开小把手也不断流；setPointerCapture
// 只作锦上添花）→ pointermove 用 elementFromPoint 找落点卡 → 数组内换位 →
// 松手把「当前页签的可见序列」写成 sort=下标*10 整表 PUT。
const dragKey = ref('');
let dragMoved = false;
function dragStart(k, ev) {
  if (!isAdmin.value || ev.button !== 0) return;
  dragKey.value = k;
  dragMoved = false;
  try { ev.currentTarget.setPointerCapture && ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 老浏览器 */ }
  window.addEventListener('pointermove', dragMove);
  window.addEventListener('pointerup', dragEnd);
  window.addEventListener('pointercancel', dragEnd);
}
function dragMove(ev) {
  const k = dragKey.value;
  if (!k) return;
  const over = document.elementFromPoint(ev.clientX, ev.clientY);
  const card = over && over.closest ? over.closest('[data-dk]') : null;
  if (!card || card.dataset.dk === k) return;
  if (reorderDash(k, card.dataset.dk)) dragMoved = true;
}
function dragEnd() {
  if (!dragKey.value) return;
  dragKey.value = '';
  window.removeEventListener('pointermove', dragMove);
  window.removeEventListener('pointerup', dragEnd);
  window.removeEventListener('pointercancel', dragEnd);
  if (dragMoved) persistDash();
}
function reorderDash(fromKey, toKey) {
  const cur = ents.value.dash || {};
  const keys = dashItems.value.map((i) => i.key);
  const from = keys.indexOf(fromKey), to = keys.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return false;
  keys.splice(to, 0, keys.splice(from, 1)[0]);
  keys.forEach((kk, i) => { if (cur[kk]) cur[kk].sort = i * 10; });
  return true;
}
// 任何仪表盘改动（拖动排序 / 可见性 / 归类）都整表 PUT——服务端全量校验后整表落库
async function persistDash() {
  if (!isAdmin.value) return;
  try {
    const r = await api.put('/ha/dashboard', { dashboard: ents.value.dash });
    ents.value.dash = r.dashboard;
  } catch (e) { err.value = e.message; }
}
function dashOf(key) { return (ents.value.dash || {})[key] || { visible: false, cat: '', sort: 0 }; }
async function setDash(key, patch) {
  if (!isAdmin.value) return;
  const d = ents.value.dash = ents.value.dash || {};
  d[key] = { visible: false, cat: '', sort: 99990, ...(d[key] || {}), ...patch };
  try {
    const r = await api.put('/ha/dashboard', { dashboard: d });
    ents.value.dash = r.dashboard;
    flashOk('已保存（仪表盘即时生效）');
  } catch (e) {
    err.value = e.message;
    loadEntities(false).catch(() => {}); // 保存失败回读服务端真值，别让本地脏状态看着像成功了
  }
}
// 一键把全部设备/单实体加进仪表盘（v1.15.1）：已配置过的只补「可见」不动分类与顺序，新条目按设备→单实体追加在末尾；
// 上限 500 条（服务端整表校验的同一口径），超了就停在新加的第 500 条——不静默吞条目也不发必被拒的包
const addingAll = ref(false);
async function showAllDash() {
  if (!isAdmin.value || addingAll.value) return;
  addingAll.value = true;
  try {
    const d = { ...(ents.value.dash || {}) };
    let next = Math.max(0, ...Object.values(d).map((v) => (v && v.sort) || 0)) + 10;
    const keys = [];
    for (const dev of ents.value.devices || []) {
      if (ents.value.entities.some((e) => e.device_id === dev.id && !e.hidden)) keys.push('dev:' + dev.id);
    }
    for (const e of ents.value.entities) {
      if (!e.device_id && !e.hidden) keys.push('ent:' + e.entity_id);
    }
    let added = 0;
    for (const k of keys) {
      if (Object.keys(d).length >= 500) break;
      if (d[k]) { d[k] = { ...d[k], visible: true }; continue; }
      d[k] = { visible: true, cat: '', sort: next };
      next += 10;
      added++;
    }
    const r = await api.put('/ha/dashboard', { dashboard: d });
    ents.value.dash = r.dashboard;
    flashOk(added ? `已全部加入仪表盘（新增 ${added} 项）` : '已把既有条目全部设为可见');
  } catch (e) { err.value = e.message; }
  finally { addingAll.value = false; }
}

// ==================== 设备页 ====================
const devQ = ref(''), devArea = ref(''), devOnlyCtl = ref(false);
const devGroups = computed(() => {
  const kw = devQ.value.trim().toLowerCase();
  const areaOk = (aid, aname) => {
    if (!devArea.value) return true;
    if (devArea.value === '__none__') return !aid || aname === '未分区';
    return aid === devArea.value;
  };
  const boxes = [];
  // 同一设备的实体框在一起（含隐藏实体，带「隐藏」标签——设备页就是看全量的地方）
  for (const d of ents.value.devices || []) {
    const rows = ents.value.entities.filter((e) => e.device_id === d.id);
    if (!rows.length) continue;
    if (!areaOk(d.area_id, d.area)) continue;
    if (devOnlyCtl.value && !rows.some((e) => e.controllable)) continue;
    if (kw && !(
      d.name.toLowerCase().includes(kw) || d.manufacturer.toLowerCase().includes(kw) || d.model.toLowerCase().includes(kw)
      || rows.some((e) => e.name.toLowerCase().includes(kw) || e.entity_id.toLowerCase().includes(kw))
    )) continue;
    boxes.push({ kind: 'dev', key: 'dev:' + d.id, title: d.name, sub: [d.manufacturer, d.model].filter(Boolean).join(' '), area: d.area, rows });
  }
  // 无设备归属的实体：每个单独成框（key 用 ent: 前缀，仪表盘上也是单实体卡）
  for (const e of ents.value.entities.filter((x) => !x.device_id)) {
    if (!areaOk(e.area_id, e.area)) continue;
    if (devOnlyCtl.value && !e.controllable) continue;
    if (kw && !(e.name.toLowerCase().includes(kw) || e.entity_id.toLowerCase().includes(kw))) continue;
    boxes.push({ kind: 'ent', key: 'ent:' + e.entity_id, title: e.name, sub: '', area: e.area, rows: [e] });
  }
  boxes.sort((a, b) => (a.area === b.area ? a.title.localeCompare(b.title, 'zh') : a.area.localeCompare(b.area, 'zh')));
  return boxes;
});
// 设备页计数同时给实体总数——设备框把同设备实体合在一起后，只报框数会被误读成「设备变少了」
const entCount = computed(() => devGroups.value.reduce((s, b) => s + b.rows.length, 0));

// ---------- 分类管理（管理员；整表替换语义，删除的分类由服务端清扫 dash 里的孤儿引用） ----------
const catDraft = ref([]);
const iconPicker = ref(-1);
const savingCats = ref(false);
watch(() => ents.value.cats, (v) => { catDraft.value = (v || []).map((c) => ({ id: c.id, name: c.name, icon: c.icon })); }, { immediate: true });
const catDirty = computed(() => JSON.stringify(catDraft.value) !== JSON.stringify((ents.value.cats || [])));
function addCat() { catDraft.value.push({ id: '', name: '', icon: 'home' }); iconPicker.value = catDraft.value.length - 1; }
function delCat(i) { catDraft.value.splice(i, 1); iconPicker.value = -1; }
async function saveCats() {
  savingCats.value = true;
  try {
    await api.put('/ha/categories', { categories: catDraft.value });
    flashOk('分类已保存');
    await loadEntities(false); // 重新拉 cats/dash（分类删除会清扫孤儿引用，本地不能自己猜）
  } catch (e) { err.value = e.message; }
  finally { savingCats.value = false; }
}

// ---------- 别名（与米家共用一张表；did=entity_id） ----------
async function loadAliases() {
  if (!isAdmin.value || aliasLoaded) return;
  aliasLoaded = true;
  try {
    const r = await api.get('/xiaozhi/devices');
    const m = {};
    for (const d of r.devices || []) if (d.alias) m[d.did] = d.alias;
    aliasMap.value = m;
  } catch { /* 未绑米家时接口可能报错：别名框留空 */ }
}
function aliasOf(id) { return aliasMap.value[id] || ''; }
async function saveAliasFor(id, v) {
  const t = String(v || '').trim();
  try {
    await api.put('/xiaozhi/device-alias', { did: id, alias: t });
    const m = { ...aliasMap.value };
    if (t) m[id] = t; else delete m[id];
    aliasMap.value = m;
    flashOk(t ? `已登记别名「${t}」` : '已清除别名');
  } catch (e) { err.value = e.message; }
}
watch(sub, (v) => { if (v === 'dev') loadAliases(); });

// ---------- 加载 ----------
// intoForm=false 只刷新状态条（后台轮询用）——正在编辑的表单值绝不能被覆盖
async function loadConfig(intoForm = true) {
  const r = await api.get('/ha/config');
  cfg.value = r;
  isAdmin.value = !!r.is_admin;
  if (!intoForm) return;
  form.url = r.config.url;
  form.url_external = r.config.url_external;
  form.device_source = r.config.device_source;
  form.cache_ttl_min = r.config.cache_ttl_min;
  form.token = '';
}
async function loadEntities(fresh, silent) {
  try {
    const r = await api.get('/ha/entities' + (fresh ? '?fresh=1' : ''));
    ents.value = { devices: [], cats: [], dash: {}, ...r };
  } catch (e) {
    if (silent) return; // 自愈轮询失败静默：状态条与下一轮兜底，不刷屏
    if (!ents.value.entities.length) err.value = e.message;
    else err.value = '刷新失败：' + e.message;
  }
}
async function loadHooklog() {
  try {
    const r = await api.get('/ha/hooklog?limit=30');
    hookEvents.value = r.events || [];
  } catch { /* 静默：事件流水非关键路径 */ }
}
async function loadAll(fresh) {
  err.value = '';
  loading.value = true;
  try { await Promise.all([loadConfig(), loadEntities(fresh), loadHooklog()]); }
  finally { loading.value = false; }
}
// ---------- v1.16.11 实体自愈：HA 重启/集成重载（如 xiaomi_miot 导入百余台设备）期间，实体是一批批注册进 HA 的，
// 服务端如实反映 HA 当时给的半份名单；页面若只在进页时拉一次，就会永远停在那份半成品上
// （用户报障：设备页十几分钟加载不全，手动刷新一次才多几个）。现在：
// ① 存活期间每 30s 静默重拉一次（页面可见才拉，HA 补一批页面就长一批）；
// ② 配置轮询看到 WS 从断到连的跳变（HA 刚回来）立即强拉全量（fresh 绕过服务端缓存）；
// ③ 拖拽排序/图标弹层/分类草稿未保存时跳过本轮（防打断编辑），下一轮再补。
let entBusy = false;
async function autoEntities(fresh) {
  if (entBusy || loading.value || dragKey.value || iconPicker.value !== -1 || catDirty.value) return;
  entBusy = true;
  try { await loadEntities(fresh, true); } catch { /* 静默 */ }
  finally { entBusy = false; }
}

// ---------- 配置保存 / 测试（配置页） ----------
async function doTest() {
  testing.value = true;
  testResult.value = null;
  try {
    const body = { url: form.url, url_external: form.url_external };
    if (form.token.trim()) body.token = form.token.trim();
    testResult.value = await api.post('/ha/test', body);
  } catch (e) { testResult.value = { ok: false, error: e.message }; }
  finally { testing.value = false; }
}
async function doSave() {
  saving.value = true;
  err.value = '';
  try {
    const body = { url: form.url, url_external: form.url_external, device_source: form.device_source, cache_ttl_min: form.cache_ttl_min };
    if (form.token.trim()) body.token = form.token.trim();
    await api.put('/ha/config', body);
    await loadConfig();
    await loadEntities(true);
    pollWsAfterSave(); // 保存后 WS 重连是异步的：盯着状态条自己翻绿，不阻塞保存按钮
    flashOk('已保存，并按新配置重连 Home Assistant');
  } catch (e) { err.value = e.message; }
  finally { saving.value = false; }
}
// 保存后 WS 重连要几秒：每 1.2s 拉一次配置直到翻绿（上限约 12s）——「未连接」不再赖着不走
function pollWsAfterSave(ms = 12000) {
  const t0 = Date.now();
  (async () => {
    while (Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 1200));
      try { await loadConfig(false); } catch { return; }
      if (wsOn.value) return;
    }
  })().catch(() => {});
}
async function rotateHook() {
  if (!confirm('轮换后旧 key 立即失效，HA 自动化里的地址要同步改。确定轮换？')) return;
  try {
    await api.put('/ha/config', { rotate_hook: true });
    await loadConfig();
    flashOk('已轮换——把新地址重新填进 HA 自动化');
  } catch (e) { err.value = e.message; }
}
function copyHook() {
  if (!cfg.value) return;
  navigator.clipboard?.writeText(cfg.value.hook_url).then(() => flashOk('已复制 webhook 地址'));
}

// ---------- 控制 ----------
async function toggle(e) {
  if (toggling[e.entity_id]) return;
  toggling[e.entity_id] = true;
  const before = e.on;
  e.on = !before; // 乐观更新，回执以服务端为准再纠偏
  try {
    const r = await api.post('/ha/control', { entity_id: e.entity_id, action: 'toggle' });
    if (!r.ok || r.verified === false) { err.value = r.message; }
    else flashOk(r.message);
  } catch (ex) { e.on = before; err.value = ex.message; }
  finally {
    delete toggling[e.entity_id];
    refreshOne(e.entity_id);
  }
}
async function refreshOne(entityId) {
  try {
    const st = await api.get('/ha/entity/' + encodeURIComponent(entityId));
    const e = ents.value.entities.find((x) => x.entity_id === entityId);
    if (e) {
      e.state = st.state;
      e.on = ['on', 'open', 'opening', 'playing'].includes(String(st.state).toLowerCase());
      e.state_text = { on: '开着', off: '关着', open: '开着', closed: '关着', opening: '正在开', closing: '正在关' }[String(st.state).toLowerCase()] || String(st.state);
    }
    if (detail.value && detail.value.e.entity_id === entityId) detail.value.e.state = st.state;
  } catch { /* 下一次全量刷新兜底 */ }
}

// ---------- 服务调试（配置页） ----------
const svcDomains = computed(() => [...new Set(services.value.map((s) => s.domain))].sort());
const svcServices = computed(() => {
  const d = services.value.find((s) => s.domain === svcForm.domain);
  return d ? Object.keys(d.services || {}) : [];
});
async function loadServices() {
  svcLoading.value = true;
  try {
    const r = await api.get('/ha/services');
    services.value = r.services || [];
    if (svcDomains.value.length) svcForm.domain = svcDomains.value.includes('light') ? 'light' : svcDomains.value[0];
  } catch (e) { err.value = e.message; }
  finally { svcLoading.value = false; }
}
watch(() => svcForm.domain, () => {
  const list = svcServices.value;
  svcForm.service = list.includes('turn_on') ? 'turn_on' : list[0] || '';
});
async function runService() {
  let data = {};
  try { data = svcForm.data.trim() ? JSON.parse(svcForm.data) : {}; }
  catch { svcResult.value = { ok: false, text: 'data 不是合法 JSON' }; return; }
  svcBusy.value = true;
  svcResult.value = null;
  try {
    const r = await api.post('/ha/service', { domain: svcForm.domain, service: svcForm.service, data });
    svcResult.value = { ok: true, text: '已执行' + (Array.isArray(r.result) && r.result.length ? `（影响 ${r.result.length} 个实体）` : '') };
    setTimeout(() => loadEntities(true), 600);
  } catch (e) { svcResult.value = { ok: false, text: e.message }; }
  finally { svcBusy.value = false; }
}

// ---------- 详情弹层 ----------
async function openDetail(e) {
  detail.value = { e, alias: '', points: null, histLoading: true, savingAlias: false };
  try {
    const r = await api.get('/ha/entity/' + encodeURIComponent(e.entity_id));
    e.attributes = r.attributes || {};
  } catch { /* 列表里已有的属性够看 */ }
  try {
    // 别名表在服务端（xiaozhi 配置）；详情里只给语音域设备登记
    if (e.voice) {
      await loadAliases();
      detail.value.alias = aliasOf(e.entity_id);
    }
  } catch { /* 未绑米家时接口可能报错：别名留空 */ }
  detail.value.histLoading = true;
  try {
    const r = await api.get('/ha/history/' + encodeURIComponent(e.entity_id) + '?hours=24');
    detail.value.points = r.points || [];
  } catch { detail.value.points = []; }
  detail.value.histLoading = false;
}
function closeDetail() { detail.value = null; }
async function saveAlias() {
  const d = detail.value;
  d.savingAlias = true;
  try {
    await saveAliasFor(d.e.entity_id, d.alias);
  } finally { d.savingAlias = false; }
}
// 历史点 → sparkline 坐标（数值型画曲线；开关型画 0/1 台阶）
const sparkPoints = computed(() => {
  const pts = detail.value && detail.value.points;
  if (!pts || pts.length < 2) return '';
  const nums = pts.map((p) => {
    const n = Number(p.state);
    if (Number.isFinite(n)) return n;
    const s = String(p.state).toLowerCase();
    return s === 'on' || s === 'open' || s === 'opening' || s === 'playing' ? 1 : 0;
  });
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  const t0 = new Date(pts[0].last_changed).getTime() || 0;
  const t1 = new Date(pts[pts.length - 1].last_changed).getTime() || 1;
  const spanT = t1 - t0 || 1;
  return pts.map((p, i) => {
    const x = ((new Date(p.last_changed).getTime() - t0) / spanT) * 276 + 2;
    const y = 60 - ((nums[i] - min) / span) * 54 - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
});
function attrText(v) {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
  return String(v).slice(0, 160);
}

// ---------- SSE 实时（状态变化直接打补丁进 ents——仪表盘/设备页/详情都吃到） ----------
function openSse() {
  closeSse();
  try {
    es = new EventSource(authUrl('/api/ha/events'));
    es.onmessage = (m) => {
      let p;
      try { p = JSON.parse(m.data); } catch { return; }
      if (p.type === 'state') {
        const e = ents.value.entities.find((x) => x.entity_id === p.entity_id);
        if (e) {
          e.state = p.state;
          e.on = ['on', 'open', 'opening', 'playing'].includes(String(p.state).toLowerCase())
            || (e.domain === 'climate' && !['off', 'unavailable', 'unknown'].includes(String(p.state).toLowerCase()));
          if (p.attributes && p.attributes.friendly_name) e.name = p.attributes.friendly_name;
        }
        if (liveEvents.value.length > 200) liveEvents.value.pop();
        liveEvents.value.unshift({ ts: Date.parse(p.last_changed) || Date.now(), source: 'state', tag: '状态', k: 's' + Math.random(), text: `${p.entity_id} → ${p.state}` });
      } else if (p.type === 'hook' || p.type === 'log') {
        if (liveEvents.value.length > 200) liveEvents.value.pop();
        liveEvents.value.unshift({ ts: p.ts || Date.now(), source: p.type, tag: p.type === 'hook' ? 'HA' : '控制', k: 'h' + Math.random(), text: [p.title, p.message].filter(Boolean).join('：') });
      }
    };
    es.onerror = () => { /* EventSource 自带重连；这里不弹错免噪音 */ };
  } catch { /* 老浏览器无 EventSource：静态列表照常 */ }
}
function closeSse() { if (es) { try { es.close(); } catch {} es = null; } }
watch(liveOn, (on) => (on ? openSse() : closeSse()));

// 事件流合并展示：SSE 实时（近几分钟）+ 落库流水（更早的）
const mergedEvents = computed(() => {
  const a = liveEvents.value.map((e) => ({ ...e }));
  const ids = new Set(a.map((e) => e.ts + e.text));
  const b = hookEvents.value.filter((e) => !ids.has(e.ts + [e.title, e.message].filter(Boolean).join('：')))
    .map((e) => ({ ts: e.ts, source: e.source, tag: e.source === 'hook' ? 'HA' : '控制', k: 'd' + e.id, text: [e.title, e.message].filter(Boolean).join('：') }));
  return [...a, ...b].sort((x, y) => y.ts - x.ts).slice(0, 60);
});
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 生命周期 ----------
onMounted(() => {
  if (mainFull) mainFull.value = true; // 整页不限宽（用户要求：仪表盘/配置/设备都按网页宽度自适配）
  loadAll(false);
  if (sub.value === 'dev') loadAliases();
  if (liveOn.value) openSse();
  camTimer = setInterval(() => { if (camAuto.value) camTick.value++; }, 15000);
  camTimer && camTimer.unref && camTimer.unref();
  // 状态条自刷新：WS 连没连是服务端的事（重连/断线随时发生），15s 拉一次配置；页面不可见时不拉。
  // v1.16.11：轮询里看到 WS 从断到连（HA 重启完回来了）→ 立即强拉全量实体，别让半份名单赖着不走。
  cfgTimer = setInterval(() => {
    if (document.hidden) return;
    const was = wsOn.value;
    loadConfig(false).then(() => { if (!was && wsOn.value) autoEntities(true); }).catch(() => {});
  }, 15000);
  cfgTimer && cfgTimer.unref && cfgTimer.unref();
  // 实体自愈轮询（v1.16.11）：30s 静默重拉——HA 半程时页面跟着长，见 autoEntities 注释
  entTimer = setInterval(() => { if (!document.hidden) autoEntities(false); }, 30000);
  entTimer && entTimer.unref && entTimer.unref();
});
onBeforeUnmount(() => {
  if (mainFull) mainFull.value = false;
  closeSse();
  if (camTimer) clearInterval(camTimer);
  if (cfgTimer) clearInterval(cfgTimer);
  if (entTimer) clearInterval(entTimer);
});
</script>

<style scoped>
.ha-panel { display: flex; flex-direction: column; gap: 12px; }
.dim { color: var(--text2); }
.ha-warn { color: #e6a23c; }

/* ---- 子页签 ---- */
.ha-sub { display: flex; gap: 8px; flex-wrap: wrap; }
.ha-sub button { padding: 7px 18px; border-radius: 9px; border: 1px solid var(--border, #3a3f4d); background: transparent; color: var(--text2); font-size: 14px; cursor: pointer; transition: all .15s; }
.ha-sub button.on { color: var(--text); border-color: var(--accent, #4f8cff); background: rgba(79, 140, 255, .14); font-weight: 600; }

/* ---- 仪表盘：左侧书签栏（只显图标）+ 卡片区 ---- */
.ha-dash-hint { font-size: 13px; padding: 2px 2px 0; }
.ha-dash-hint a { color: var(--accent, #4f8cff); }
.ha-dash-wrap { display: flex; gap: 14px; align-items: flex-start; }
.ha-rail { display: flex; flex-direction: column; gap: 6px; position: sticky; top: 12px; flex: none; }
.ha-rail-btn { width: 42px; height: 42px; border-radius: 11px; border: 1px solid var(--border, #3a3f4d); background: var(--bg2); color: var(--text2); cursor: pointer; display: grid; place-items: center; transition: all .15s; }
.ha-rail-btn .material-icons { font-size: 22px; }
.ha-rail-btn:hover { color: var(--text); }
.ha-rail-btn.on { color: var(--accent, #4f8cff); border-color: var(--accent, #4f8cff); background: rgba(79, 140, 255, .14); }
.ha-dash-main { flex: 1; min-width: 0; }

/* 设备卡里的摄像头预览（v1.15.1：监控截图回到卡上）与数值大字 */
.ha-camwrap { margin: 6px 0 2px; }
.ha-bigs { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; padding: 6px 0 2px; }
.ha-big { text-align: center; padding: 8px 2px 6px; border-radius: 8px; cursor: pointer; }
.ha-big:hover { background: rgba(127, 127, 127, .08); }
.ha-big b { display: block; font-size: 24px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.ha-big b i { font-style: normal; font-size: 12px; color: var(--text2); margin-left: 2px; }
.ha-big span { font-size: 11px; }
.ha-big.ent { padding: 14px 4px 10px; }
.ha-big.ent b { font-size: 30px; }
.ha-big-hint { display: block; margin-top: 4px; font-size: 10px; opacity: .8; }
/* 数值块里的小图标（插座功耗 bolt / 温度计类的温·湿·电量）——与数字同基线，别撑高整块 */
.ha-num-ic { font-size: 15px !important; vertical-align: 3px; margin-right: 2px; color: var(--text2); }
.ent-nums { padding-top: 2px; }
/* 窗帘类：开合比例进度条（细条 + 右侧百分比，卡片整宽） */
.ha-posbar { display: flex; align-items: center; gap: 8px; padding: 10px 2px 4px; }
.ha-posbar-track { flex: 1; height: 8px; border-radius: 4px; background: rgba(127, 127, 127, .22); overflow: hidden; }
.ha-posbar-fill { display: block; height: 100%; border-radius: 4px; background: var(--accent, #4f8cff); transition: width .25s; }
.ha-posbar-txt { font-size: 12px; color: var(--text2); font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
.ha-detail-cam img { width: 100%; border-radius: 8px; background: #000; cursor: pointer; display: block; }

/* v1.16.2（用户要求）：卡片按类别收敛内容后，同一行里的卡**等高对齐**（align-items:stretch），
   卡内部件纵向铺开（flex column）——横看一行齐平、竖看一列齐平，不会参差不齐。
   列宽下限 240px 随屏幕自适应，宽屏多列、窄屏单列，卡不横向溢出。 */
.ha-dcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; align-items: stretch; }
.ha-card-unit { position: relative; display: flex; flex-direction: column; border: 1px solid var(--border, #3a3f4d); border-radius: 12px; background: var(--bg2); padding: 10px 12px; transition: box-shadow .15s, opacity .15s; min-width: 0; }
.ha-card-unit:hover { box-shadow: 0 2px 12px rgba(0, 0, 0, .12); }
.ha-card-unit.dragging { opacity: .65; box-shadow: 0 4px 16px rgba(79, 140, 255, .25); }
.ha-card-unit.gone { opacity: .5; }
.ha-grip { position: absolute; top: 6px; left: 6px; font-size: 17px; color: var(--text2); cursor: grab; user-select: none; touch-action: none; padding: 2px; border-radius: 5px; z-index: 2; }
.ha-grip:hover { color: var(--text); background: rgba(127, 127, 127, .12); }
.ha-grip:active { cursor: grabbing; }
.ha-dcard-head { display: flex; align-items: baseline; gap: 8px; padding: 2px 46px 8px 20px; border-bottom: 1px dashed var(--border, #3a3f4d); margin-bottom: 4px; min-width: 0; }
.ha-dcard-head b { font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ha-dcard-head b:hover { color: var(--accent, #4f8cff); }
.ha-dcard-head .dim { font-size: 11px; flex: none; }

/* v1.16.9：卡身内容区——垂直居中铺满（flex:1），卡头 + 内容 + （一排开关）三段结构固定，
   同一行等高的卡看起来结构一致；右上角的单开关是卡片的固定件（absolute，不参与挤占）。 */
.ha-dbody { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 2px; min-height: 44px; }
/* 没有类别内容的卡（灯光典型）：中间大图标 + 开关状态，卡不空、与别的卡同构 */
.ha-hero { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 18px 0 14px; cursor: pointer; border-radius: 8px; }
.ha-hero:hover { background: rgba(127, 127, 127, .08); }
.ha-hero .material-icons { font-size: 38px; color: var(--text2); }
.ha-hero .material-icons.on, .ha-hero b.on { color: #34c759; }
.ha-hero b { font-size: 14px; font-weight: 500; color: var(--text2); }
/* 多路可控（双路开关/插线板等）：一排小开关各带名字（替代旧的整行实体），不占纵向大空间 */
.ha-swrow { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 10px 2px 4px; }
.ha-sw { display: flex; align-items: center; gap: 6px; cursor: pointer; max-width: 100%; }
.ha-sw-name { font-size: 12px; color: var(--text2); max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 卡内实体行（设备卡 / 设备页框共用） */
.ha-crow { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.ha-crow:hover { background: rgba(127, 127, 127, .08); }
.ha-crow-ic { font-size: 18px; color: var(--text2); flex: none; }
.ha-crow-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ha-crow-state { margin-left: auto; color: var(--text2); font-size: 12px; flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ha-crow-state.on { color: #34c759; }
.ha-crow.hiddenRow { opacity: .55; }

/* 单实体卡（照旧款：大图标/摄像头缩略图居中） */
.ha-ent-inner { position: relative; text-align: center; padding: 6px 4px 2px 20px; cursor: pointer; }
.ha-icon { font-size: 26px; color: var(--text2); }
.ha-cam { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 6px; background: #000; }
.ha-name { font-size: 13px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ha-state { font-size: 12px; color: var(--text2); margin-top: 2px; }
.ha-state.on { color: #34c759; }

/* ---- 配置页（沿用 v1.14.1 修复后的主题变量） ---- */
.ha-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; padding: 10px 14px; }
.ha-dot { width: 10px; height: 10px; border-radius: 50%; background: #999; display: inline-block; }
.ha-dot.on { background: #34c759; box-shadow: 0 0 6px #34c75988; }
.ha-form { display: flex; flex-direction: column; gap: 6px; max-width: 640px; }
.ha-form label { font-size: 12px; color: var(--text2); margin-top: 6px; }
.ha-form input { padding: 8px 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); }
.ha-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.ha-radio { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
.ha-hr { border: none; border-top: 1px solid var(--border, #eee); margin: 16px 0 12px; }
.ha-hook { flex: 1; min-width: 260px; padding: 7px 10px; font-size: 12px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); }
.ha-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ha-toolbar input[type="text"], .ha-toolbar input:not([type]) { padding: 7px 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); }
.ha-toolbar select { padding: 7px 8px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); }
.ha-json { width: 100%; max-width: 640px; font-family: monospace; font-size: 12px; padding: 8px 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); margin-top: 8px; }
.ha-err { color: #e5484d; }
.ha-evt { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px dashed var(--border, #f0f0f0); }
.ha-evt-time { color: var(--text2); font-variant-numeric: tabular-nums; }
.ha-evt-tag { font-size: 10px; border-radius: 4px; padding: 1px 5px; color: #fff; background: #7aa2ff; flex: none; }
.ha-evt-tag.hook { background: #ff9f0a; }
.ha-evt-tag.log { background: #34c759; }

/* ---- 设备页 ---- */
.ha-cat-row { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px dashed var(--border, #f0f0f0); }
.ha-cat-ic { width: 40px; height: 40px; border-radius: 9px; border: 1px solid var(--border, #3a3f4d); background: var(--bg); color: var(--accent, #4f8cff); cursor: pointer; display: grid; place-items: center; flex: none; }
.ha-cat-ic .material-icons { font-size: 22px; }
.ha-icon-grid { position: absolute; left: 0; top: 46px; z-index: 20; display: grid; grid-template-columns: repeat(10, 38px); gap: 6px; padding: 10px; border-radius: 10px; border: 1px solid var(--border, #3a3f4d); background: var(--bg2); box-shadow: 0 6px 22px rgba(0, 0, 0, .25); }
.ha-icon-grid button { width: 38px; height: 38px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--text2); cursor: pointer; display: grid; place-items: center; }
.ha-icon-grid button .material-icons { font-size: 20px; }
.ha-icon-grid button:hover { color: var(--text); background: rgba(127, 127, 127, .12); }
.ha-icon-grid button.on { color: var(--accent, #4f8cff); border-color: var(--accent, #4f8cff); background: rgba(79, 140, 255, .14); }

/* v1.16.1（用户要求）：设备框改成**瀑布流**——原先用等高行网格（grid auto-fill），一行的高度被该行
   最高的设备框撑住，实体少的框下面必然留一大片空白。多列布局里每个框各自往下排、不跨列断开，
   矮框后面的空间立刻被下一个框用掉。列宽仍是 340px，窄屏自动退成一列。 */
.ha-devlist { column-width: 340px; column-gap: 12px; }
.ha-devbox { border: 1px solid var(--border, #3a3f4d); border-radius: 12px; background: var(--bg2); padding: 10px 12px; margin: 0 0 12px; break-inside: avoid; -webkit-column-break-inside: avoid; page-break-inside: avoid; display: inline-block; width: 100%; vertical-align: top; }
.ha-devbox-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; border-bottom: 1px dashed var(--border, #3a3f4d); margin-bottom: 4px; }
.ha-devbox-head b { font-size: 13px; }
.ha-devbox-tag { font-size: 16px; color: var(--text2); }
.ha-devbox-head select { padding: 5px 6px; font-size: 12px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); }
.ha-area-tag { font-size: 10px; border-radius: 4px; padding: 1px 6px; color: var(--text2); background: rgba(127, 127, 127, .14); flex: none; }
.ha-alias-in { width: 110px; padding: 4px 8px; font-size: 12px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); flex: none; }
/* 窄屏（v1.16.1）：style.css 的移动端全局规则把输入框拉成 100% 宽（带 !important），
   而实体行里还挂着图标/状态/开关且不换行 → 整行横向溢出（420px 实测溢出 87px，改瀑布流前就有）。
   允许换行后输入框自己占一行，谁也不用挤谁。 */
@media (max-width: 720px) {
  .ha-crow { flex-wrap: wrap; }
  .ha-devbox { padding: 10px 10px; }
}
.ha-hidden-tag { position: absolute; left: 4px; font-size: 10px; background: #999; color: #fff; border-radius: 4px; padding: 1px 5px; }

/* ---- 开关（大小两档） ---- */
.ha-toggle { position: absolute; top: 8px; right: 8px; width: 34px; height: 20px; border-radius: 10px; border: none; background: #ccc; cursor: pointer; transition: background .2s; padding: 0; flex: none; }
.ha-toggle span { display: block; width: 16px; height: 16px; border-radius: 50%; background: #fff; margin: 2px; transition: transform .2s; }
.ha-toggle.on { background: #34c759; }
.ha-toggle.on span { transform: translateX(14px); }
.ha-toggle.busy { opacity: .6; pointer-events: none; }
.ha-toggle.sm { position: static; width: 30px; height: 18px; }
.ha-toggle.sm span { width: 14px; height: 14px; }
.ha-toggle.sm.on span { transform: translateX(12px); }
.ha-ent-inner .ha-toggle { top: 4px; right: 4px; }

/* ---- 详情弹层 ---- */
.ha-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); z-index: 50; display: flex; align-items: center; justify-content: center; }
/* 监控截图放大层（v1.16.11）：盖在实体详情弹层(.ha-mask z-50)之上 */
.ha-zoom { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, .85); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; cursor: zoom-out; }
.ha-zoom img { max-width: 94vw; max-height: 84vh; border-radius: 10px; background: #000; object-fit: contain; }
.ha-zoom-cap { color: #fff; font-size: 13px; text-shadow: 0 1px 3px rgba(0, 0, 0, .6); }
.ha-modal { background: var(--bg2); color: var(--text); border-radius: 12px; width: min(560px, 92vw); max-height: 84vh; display: flex; flex-direction: column; }
.ha-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border, #eee); }
.ha-modal-body { padding: 12px 16px; overflow-y: auto; }
.ha-kv { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 13px; border-bottom: 1px dashed var(--border, #f0f0f0); }
.ha-kv span { color: var(--text2); flex: none; }
.ha-kv b.on { color: #34c759; }
.ha-modal input { padding: 7px 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg); color: var(--text); }
.ha-spark { width: 100%; height: 64px; background: rgba(127, 127, 127, .06); border-radius: 6px; }
.ha-attrs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 12px; }
.ha-attr { display: flex; gap: 8px; padding: 3px 0; overflow: hidden; }
.ha-attr span { color: var(--text2); flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ha-attr b { font-weight: 500; word-break: break-all; }
</style>
