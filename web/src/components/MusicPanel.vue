<template>
  <div class="mc">
    <!-- ============ 根目录未配置：引导（管理员直接进本页设置，v1.17.0 起音乐设置不再去系统设置页） ============ -->
    <div v-if="!cfg.root_ok && view !== 'settings'" class="card mc-empty">
      <div class="ph">
        <span class="material-icons big-ic">music_note</span> 音乐<br>
        <b>{{ cfg.root ? '音乐目录不可访问：' + cfg.root : '尚未配置音乐路径' }}</b>
        <div style="font-size:12px">
          {{ isAdmin ? '点下方「音乐设置」填写音乐目录，保存后点「重新扫描」即可听歌' : '请联系管理员在音乐页右上角「设置」里配置音乐目录' }}
        </div>
        <div v-if="isAdmin" style="margin-top:12px">
          <button class="primary" @click="openSettings"><span class="material-icons ic-sm">settings</span> 音乐设置</button>
        </div>
      </div>
    </div>

    <!-- ============ 主界面：左（统计卡 + 目录树）+ 右（歌曲多列卡片 / 音乐设置） ============ -->
    <div v-else class="mc-body">
      <div class="mc-head">
        <span class="cur"><span class="material-icons">music_note</span> 音乐</span>
        <!-- 视图切换（v1.16.1 建 / v1.17.0 改）：音乐库 / 收藏（原「我的收藏」按要求改名）+ 管理员「设置」（右栏整框切成音乐设置） -->
        <button class="small vtab" :class="{ pri: view === 'lib' }" @click="view = 'lib'">音乐库</button>
        <button class="small vtab" :class="{ pri: view === 'fav' }" @click="openFavView">
          <span class="material-icons ic-sm">favorite</span> 收藏（{{ favTracks.length }}）
        </button>
        <button v-if="isAdmin" class="small vtab" :class="{ pri: view === 'settings' }" @click="openSettings">
          <span class="material-icons ic-sm">settings</span> 设置
        </button>
        <span class="muted" style="font-size:12px">共 {{ stats.total }} 首 · 点击歌曲即播</span>
        <span class="grow"></span>
        <button v-if="isAdmin" class="small" :disabled="scanning" @click="rescan">
          <span class="material-icons ic-sm">refresh</span> {{ scanning ? '扫描中…' : '重新扫描' }}
        </button>
      </div>
      <div class="mc-main">
        <!-- 左栏：四张统计卡 + 目录树（照视频中心的展开结构） -->
        <div class="mc-left">
          <div class="mc-stats">
            <div class="mc-stat"><b>{{ stats.total }}</b><span>歌曲数量</span></div>
            <div class="mc-stat"><b>{{ stats.covers }}</b><span>已有封面</span></div>
            <div class="mc-stat warn"><b>{{ stats.nocover }}</b><span>未匹配封面</span></div>
            <div class="mc-stat warn"><b>{{ stats.pending }}</b><span>待处理</span></div>
          </div>
          <!-- 浏览方式切换（v1.16.7）：目录（默认，照视频中心）/ 歌手（左歌手 · 右专辑） -->
          <div class="mc-modes">
            <button class="small vtab" :class="{ pri: mode === 'dir' }" @click="setMode('dir')">
              <span class="material-icons ic-sm">folder</span> 目录
            </button>
            <button class="small vtab" :class="{ pri: mode === 'artist' }" @click="setMode('artist')">
              <span class="material-icons ic-sm">person</span> 歌手
            </button>
          </div>
          <!-- 目录模式：目录树（照视频中心的展开结构） -->
          <div v-if="mode === 'dir'" class="tree card grow">
            <div class="tree-root" :class="{ sel: curDir === '' }" @click="openDir('')"><span class="material-icons ic-sm">library_music</span> 全部音乐</div>
            <div class="tree-children">
              <McTreeNode v-for="e in rootEntries" :key="e.name" :entry="e" parent="" :selected="curDir" @select="openDir" />
              <div v-if="!rootEntries.length && !treeLoading" class="muted ld">（目录为空）</div>
            </div>
          </div>
          <!-- 歌手模式：歌手清单（点歌手 → 右侧出他的专辑；再点专辑 → 出歌） -->
          <div v-else class="tree card grow mc-artists">
            <div v-if="artLoading" class="muted ld">加载中…</div>
            <template v-else>
              <div class="tree-root" :class="{ sel: curArtist === null }" @click="openArtist(null)">
                <span class="material-icons ic-sm">queue_music</span> 全部歌手（{{ artists.length }}）
              </div>
              <div class="ar-row" v-for="a in artists" :key="a.name" :class="{ sel: curArtist === a.name }"
                   :title="a.name || '未知歌手'" @click="openArtist(a.name)">
                <span class="ar-name">{{ a.name || '未知歌手' }}</span>
                <span class="ar-num">{{ a.tracks }} 首 · {{ a.albums.length }} 张</span>
              </div>
              <div v-if="!artists.length" class="muted ld">（曲库里还没有歌手信息，点右上角「重新扫描」试试）</div>
            </template>
          </div>
        </div>

        <!-- 右栏：音乐库（当前目录歌曲卡片）/ 我的收藏（v1.16.1 收藏夹独立入口） -->
        <div class="card zone">
          <div class="zone-head">
            <span class="muted" style="font-size:12px">
              <span class="material-icons ic-sm">{{ zoneIcon }}</span>
              {{ zoneTitle }}
            </span>
            <span class="muted" style="font-size:12px">{{ zoneCount }}</span>
            <span v-if="msg" class="muted" style="font-size:12px">{{ msg }}</span>
            <span class="grow"></span>
            <button v-if="view !== 'settings' && curList.length" class="small" @click="playAll"><span class="material-icons ic-sm">play_arrow</span> 全部播放</button>
            <button v-if="view === 'settings'" class="small" @click="closeSettings"><span class="material-icons ic-sm">arrow_back</span> 返回音乐库</button>
            <button v-else-if="view === 'fav'" class="small" @click="view = 'lib'"><span class="material-icons ic-sm">queue_music</span> 回音乐库</button>
            <button v-else-if="albumOpen || (mode === 'artist' && curArtist !== null)" class="small" @click="backFromArtist">
              <span class="material-icons ic-sm">arrow_upward</span> {{ albumOpen ? '返回专辑' : '全部专辑' }}
            </button>
            <button v-else-if="curDir" class="small" @click="openDir('')"><span class="material-icons ic-sm">arrow_upward</span> 返回根目录</button>
          </div>

          <!-- 我的收藏：列表行（播放 / 加入待播 / 从收藏移除） -->
          <template v-if="view === 'fav'">
            <div v-if="favTracks.length" class="mc-favlist">
              <div v-for="(t, i) in favTracks" :key="t.id" class="fav-row" :class="{ playing: curId === t.id }" @click="playFavTrack(i)">
                <span class="fav-no">{{ i + 1 }}</span>
                <span class="fav-name" :title="t.title">{{ t.title }}</span>
                <span class="fav-art" :title="t.artist">{{ t.artist || '未知歌手' }}</span>
                <span class="fav-alb" :title="t.album">{{ t.album || '' }}</span>
                <span class="fav-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
                <button class="fav-act" title="加入待播（排到当前曲之后）" @click.stop="addQueue(t)">
                  <span class="material-icons ic-sm">playlist_add</span>
                </button>
                <button class="fav-act danger" title="从我的收藏移除" @click.stop="unfav(t)">
                  <span class="material-icons ic-sm">delete</span>
                </button>
              </div>
            </div>
            <div v-else class="ph">
              还没有收藏<br>
              <span style="font-size:12px">在音乐库里点歌曲卡片右下角的心形，或播放时点播放条上的心形，就会出现在这里</span>
            </div>
          </template>

          <!-- 音乐设置（v1.17.0）：右栏整框切换——系统设置页里那三张卡（音乐路径/音乐海报/歌词API）全搬进这里，
               另加封面刮削（渠道勾选+测连通+后台任务）与悬浮歌词（桌面代理下载/字体/设备清单）。仅管理员。 -->
          <template v-else-if="view === 'settings'">
            <div class="mc-set">
              <!-- ① 音乐路径（原系统设置页的卡，v1.17.0 搬进音乐页） -->
              <div class="card set-sec">
                <h3><span class="material-icons ic-sm">folder</span> 音乐路径</h3>
                <div class="tip">NAS 上填短路径（如 <code>/音乐</code>，自动试 /vol2/1000、/vol1/1000 前缀）；Windows 直跑填本机路径（如 <code>D:\音乐</code>）</div>
                <div class="sc-row">
                  <input v-model="setRoot" class="grow" placeholder="/音乐" :disabled="setSaving" @keyup.enter="saveRoot" />
                  <button class="small" :disabled="setSaving" @click="saveRoot">
                    <span class="material-icons ic-sm">save</span> {{ setSaving ? '保存中…' : '保存' }}
                  </button>
                </div>
                <div v-if="cfg.root" class="tip">当前：{{ cfg.root_ok ? '✅ ' : '⚠️ ' }}{{ cfg.resolved || cfg.root }}{{ cfg.root_ok ? '' : '（不可访问）' }}</div>
                <div class="sc-row">
                  <button class="small" :disabled="scanning" @click="rescan">
                    <span class="material-icons ic-sm">refresh</span> {{ scanning ? '扫描中…' : '重新扫描' }}
                  </button>
                  <span v-if="scannedAtText" class="tip">上次扫描：{{ scannedAtText }}</span>
                </div>
              </div>

              <!-- ② 封面刮削：渠道勾选（勾选顺序=优先级）+ 每渠道地址输入框（v1.17.1，itunes 保留现有模式不出框）+ 测连通 + 后台任务 -->
              <div class="card set-sec">
                <h3><span class="material-icons ic-sm">image_search</span> 封面刮削</h3>
                <div class="tip">给没有封面的歌（统计卡「未匹配封面」那些）从公开渠道补封面；勾选顺序就是优先级，第一家没刮到才试下一家。地址留空用内置默认，填了推荐地址就以填的为准（保存后「实际请求」一栏会亮出真打的端点）</div>
                <div v-for="ch in scrape.channels" :key="ch.id" class="sc-ch">
                  <label class="sc-chk" :title="'拖动排序=优先级（越靠上越先用）'">
                    <input v-model="scrapeOn" type="checkbox" :value="ch.id" />
                    <b>{{ ch.name }}</b>
                  </label>
                  <span class="sc-desc">{{ ch.desc }}</span>
                  <button class="small" :disabled="scrapeTests[ch.id] === 'testing'" @click="testChannel(ch.id)">
                    {{ scrapeTests[ch.id] === 'testing' ? '测试中…' : scrapeTests[ch.id] === 'ok' ? '✅ 通' : scrapeTests[ch.id] === 'bad' ? '❌ 不通' : '测连通' }}
                  </button>
                  <template v-if="!ch.no_url">
                    <div class="sc-row sc-url">
                      <input v-model="scrapeUrls[ch.id]" class="grow" :disabled="setSaving" :placeholder="'默认：' + ch.rec" @keyup.enter="saveScrape" />
                      <button class="small" :disabled="setSaving" title="把下面的推荐地址填进输入框" @click="scrapeUrls[ch.id] = ch.rec">填入推荐</button>
                    </div>
                    <div class="tip sc-rec">推荐地址：{{ ch.rec }}（不想手抄就点「填入推荐」）· 实际请求：{{ ch.effective }}</div>
                  </template>
                </div>
                <div class="sc-row">
                  <button class="small" :disabled="setSaving" @click="saveScrape"><span class="material-icons ic-sm">save</span> 保存勾选与地址</button>
                  <button v-if="!scrape.running" class="small primary" :disabled="setSaving || scanning" @click="startScrape">
                    <span class="material-icons ic-sm">cloud_download</span> 开始刮削（{{ scrape.pending }} 首待补）
                  </button>
                  <button v-else class="small danger" @click="stopScrape"><span class="material-icons ic-sm">stop</span> 停止（{{ scrape.done }}/{{ scrape.total }}）</button>
                </div>
                <div v-if="scrape.running || scrape.finished_at" class="tip">
                  {{ scrape.running ? `正在处理：${scrape.current || '…'}（已刮到 ${scrape.found} 张）` : `上次任务：${scrape.found}/${scrape.total} 张刮到封面（失败 ${scrape.failed}）` }}
                </div>
                <div v-if="scrape.log && scrape.log.length" class="sc-log">
                  <div v-for="(l, i) in scrape.log.slice(-8)" :key="i">{{ l }}</div>
                </div>
              </div>

              <!-- ③ 音乐海报（原系统设置页的卡） -->
              <div class="card set-sec">
                <h3><span class="material-icons ic-sm">photo_library</span> 音乐海报</h3>
                <div class="tip">目录封面文件名（逗号分隔）与封面来源优先级、全屏播放页背景</div>
                <div class="lab">目录封面文件名</div>
                <div class="sc-row">
                  <input v-model="poster.names" class="grow" :placeholder="cfg.poster ? cfg.poster.cover_names_default : 'cover.jpg, folder.jpg…'" :disabled="setSaving" />
                </div>
                <div class="lab">封面优先级</div>
                <div class="opt">
                  <label><input type="radio" value="embed" v-model="poster.priority" /> 内嵌封面优先（歌里带的图）</label>
                  <label><input type="radio" value="dir" v-model="poster.priority" /> 目录封面优先（文件夹里的 cover.jpg）</label>
                </div>
                <div class="lab">全屏播放页背景</div>
                <div class="opt">
                  <label><input type="radio" value="color" v-model="poster.bg" /> 封面主色渐变（默认）</label>
                  <label><input type="radio" value="dark" v-model="poster.bg" /> 纯深色</label>
                </div>
                <div class="sc-row"><button class="small" :disabled="setSaving" @click="savePoster"><span class="material-icons ic-sm">save</span> 保存</button></div>
              </div>

              <!-- ④ 歌词 API（原系统设置页的卡） -->
              <div class="card set-sec">
                <h3><span class="material-icons ic-sm">lyrics</span> 歌词 API</h3>
                <div class="tip">LRCLIB 兼容服务（{{ lyr.sourceText }}），已缓存 {{ lyr.cached }} 首；改地址后可清缓存重挑歌词</div>
                <div class="sc-row">
                  <input v-model="lyr.api" class="grow" placeholder="https://lrclib.net" :disabled="setSaving" />
                  <button class="small" :disabled="setSaving" @click="saveLyr"><span class="material-icons ic-sm">save</span> 保存</button>
                  <button class="small" :disabled="lyrTesting" @click="testLyr">{{ lyrTesting ? '测试中…' : '测连通' }}</button>
                  <button class="small danger" :disabled="setSaving" @click="clearLyr">清空缓存</button>
                </div>
                <div v-if="lyr.testMsg" class="tip" :class="{ ok: lyr.testOk, bad: !lyr.testOk }">{{ lyr.testMsg }}</div>
              </div>

              <!-- ⑤ 悬浮歌词：桌面代理安装包（含字体）/ 字体字号 / 设备清单 -->
              <div class="card set-sec">
                <h3><span class="material-icons ic-sm">desktop_windows</span> 悬浮歌词</h3>
                <div class="tip">在 Windows 电脑桌面悬浮显示正在播放的一句歌词，唱到的字变红、其余白字带灰阴影；播放暂停/网页关闭 15 秒后自动消失。仅 Windows（macOS 未提供）。</div>
                <div class="sc-row">
                  <label class="sc-chk"><input type="checkbox" v-model="desk.on" @change="saveDeskOn" /> 播放音乐时显示桌面歌词（总开关）</label>
                </div>
                <div class="lab">字体</div>
                <div class="sc-row">
                  <select v-model="desk.family" :disabled="setSaving">
                    <option v-for="f in (cfg.desk ? cfg.desk.font_options : [])" :key="f.v" :value="f.v">{{ f.n }}</option>
                  </select>
                  <input v-model.number="desk.size" type="number" min="12" max="96" style="width:80px" :disabled="setSaving" />
                  <span class="tip">px</span>
                  <button class="small" :disabled="setSaving" @click="saveDeskFont"><span class="material-icons ic-sm">save</span> 保存</button>
                </div>
                <div class="tip">{{ cfg.desk && cfg.desk.font_included ? '安装包自带思源黑体（SIL OFL 1.1，可再分发）' : '⚠️ 服务器缺字体文件，安装包将回退系统微软雅黑' }}</div>
                <div class="sc-row">
                  <button class="small primary" :disabled="pkgBusy" @click="downloadPkg"><span class="material-icons ic-sm">{{ pkgBusy ? 'hourglass_empty' : 'download' }}</span> {{ pkgBusy ? '正在打包下载…别重复点' : '下载 Windows 安装包' + (cfg.desk && cfg.desk.font_included ? '（含字体）' : '') }}</button>
                  <button class="small" :disabled="pkgBusy" @click="downloadPkg('uninstall')"><span class="material-icons ic-sm">delete</span> 下载卸载包（轻量）</button>
                  <button class="small danger" title="轮换后所有已装设备立即失联，需重新下载安装包" @click="rotateKey"><span class="material-icons ic-sm">key</span> 轮换设备密钥</button>
                </div>
                <div class="tip">安装包自带 卸载.cmd（双击即卸载）；上面的「下载卸载包」是给安装包已删/只想要卸载的场景准备的小包。</div>
                <div class="lab">已安装的电脑（{{ agents.length }} 台{{ agents.filter((a) => a.online).length ? '，' + agents.filter((a) => a.online).length + ' 台在线' : '' }}）</div>
                <div v-if="agents.length" class="ag-list">
                  <div v-for="a in agents" :key="a.id" class="ag-row">
                    <span class="ag-dot" :class="{ on: a.online }" :title="a.online ? '在线（2 秒一心跳）' : '离线'"></span>
                    <input v-model="a._name" class="ag-name" :placeholder="a.computer || a.id" @keyup.enter="renameAgent(a)" @blur="renameAgent(a)" />
                    <span class="ag-sub">{{ a.computer || a.id }} · {{ fmtAgo(a.last_seen) }} · 轮询 {{ a.polls }} 次</span>
                    <label class="sc-chk" title="只关这一台的桌面歌词"><input type="checkbox" :checked="a.show" @change="toggleAgentShow(a)" /> 显示</label>
                    <button class="small danger" title="从清单移除（电脑再上线会重新登记）" @click="delAgent(a)"><span class="material-icons ic-sm">delete</span></button>
                  </div>
                </div>
                <div v-else class="tip">还没有电脑安装——下载上面的安装包，在要显示歌词的电脑上双击「安装.cmd」即可</div>
              </div>
            </div>
          </template>

          <!-- 歌手模式·专辑层（v1.16.7）：还没点进某张专辑时，右栏放专辑卡片；点卡片进歌单 -->
          <template v-else-if="mode === 'artist' && !albumOpen">
            <div v-if="curAlbums.length" class="mc-grid">
              <div v-for="al in curAlbums" :key="al.artist + '\u0000' + al.name" class="mc-card" @click="openAlbum(al.artist, al.name)">
                <div class="mc-cover">
                  <img v-if="al.cover_id" :src="coverUrl(al.cover_id)" loading="lazy" alt="" />
                  <span v-else class="mc-noimg material-icons">album</span>
                  <button class="mc-add mc-add-queue" title="整张专辑加入待播" @click.stop="queueAlbum(al)">
                    <span class="material-icons">playlist_add</span>
                  </button>
                  <button class="mc-add" title="播放整张专辑" @click.stop="playAlbum(al)">
                    <span class="material-icons">play_arrow</span>
                  </button>
                </div>
                <div class="mc-title" :title="al.name">{{ al.name || '未知专辑' }}</div>
                <div class="mc-meta">
                  <span class="mc-dur">{{ al.tracks }} 首</span>
                  <span class="mc-artist" :title="al.artist">{{ al.artist || '未知歌手' }}</span>
                </div>
                <div class="mc-album">{{ fmtTime(al.duration_ms / 1000) }}</div>
              </div>
            </div>
            <div v-else class="ph">
              <span class="material-icons big-ic">album</span>
              {{ curArtist === null ? '曲库里还没有专辑信息' : '这位歌手没有别的信息了' }}<br>
              <span style="font-size:12px">专辑信息来自歌曲文件的内嵌标签（mp3/flac/m4a 都能读）；没有标签时会退到文件名与所在目录</span>
            </div>
          </template>

          <!-- 音乐库：当前目录歌曲多列卡片（歌手模式下点进专辑后复用同一套卡片） -->
          <template v-else>
            <div v-if="libLoading" class="muted ld">加载中…</div>
            <div v-else-if="libError" class="muted ld err">{{ libError }}</div>
            <template v-else>
              <!-- 子目录快捷（点击即切过去，与左侧树等价） -->
              <div v-if="lib.subdirs.length" class="mc-subdirs">
                <button v-for="d in lib.subdirs" :key="d.path" class="small" @click="openDir(d.path)">
                  <span class="material-icons ic-sm">folder</span> {{ d.name }}
                </button>
              </div>
              <div v-if="lib.tracks.length" class="mc-grid">
                <div v-for="(t, i) in lib.tracks" :key="t.id" class="mc-card" :class="{ playing: curId === t.id }" @click="playTrack(i)">
                  <div class="mc-cover">
                    <img v-if="t.has_cover" :src="coverUrl(t.id)" loading="lazy" alt="" @error="t.has_cover = 0" />
                    <span v-else class="mc-noimg material-icons">music_note</span>
                    <span v-if="curId === t.id && music.playing" class="mc-eq"><i></i><i></i><i></i></span>
                    <button class="mc-add" :class="{ on: isFav(t.id) }" :title="isFav(t.id) ? '取消收藏' : '加入我的收藏'" @click.stop="favCard(t)">
                      <span class="material-icons">{{ isFav(t.id) ? 'favorite' : 'favorite_border' }}</span>
                    </button>
                    <button class="mc-add mc-add-queue" title="加入播放列表待播" @click.stop="addQueue(t)">
                      <span class="material-icons">playlist_add</span>
                    </button>
                  </div>
                  <div class="mc-title" :title="t.title">{{ t.title }}</div>
                  <div class="mc-meta" :title="(t.artist || '未知歌手') + ' · ' + fmtTime(t.duration_ms / 1000)">
                    <span class="mc-dur">{{ fmtTime(t.duration_ms / 1000) }}</span>
                    <span class="mc-artist">{{ t.artist || '未知歌手' }}</span>
                  </div>
                  <div class="mc-album" :title="t.album">{{ t.album || ' ' }}</div>
                </div>
              </div>
              <div v-else class="ph">
                <span class="material-icons big-ic">folder_off</span> 这个目录里没有歌曲<br>
                <span style="font-size:12px">试试左侧的其它目录，或点「重新扫描」拉取新增文件</span>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 音乐中心面板（v1.16.0，v1.16.1 打磨）：人工智能页「音乐」tab。左 = 四张统计卡 + 目录树（McTreeNode 懒加载），
// 右 = 当前目录歌曲多列卡片（封面/歌名/时长/歌手/专辑 + 收藏心形 + 加入待播）。点歌即播 → 底部浮出 MusicBar。
// 整页不限宽（wbMainFull，GeoPanel/AiChat 先例）——大屏多列铺开。
// v1.16.1：① 顶部「音乐库 / 我的收藏（N）」视图切换——收藏夹有了独立入口，行内能播/加待播/删
//          ② 卡片右上角心形即时收藏 ③ 全部图标改 Material Icons 单色字体（原彩色 emoji 太跳）。
// v1.16.7：左栏加「目录 / 歌手」切换——歌手模式左栏列歌手、右栏列该歌手的专辑、点专辑出歌单
//          （数据全来自 mc_tracks 的 artist/album 列，服务端 GROUP BY，没有新表）。
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import McTreeNode from './McTreeNode.vue';
import {
  musicState as music, playList, enqueue, coverUrl, fmtTime, loadFavs, isFav, toggleFav, loadMcCfg,
} from '../musicState';

const mainFull = inject('wbMainFull', null);
const isAdmin = (() => { try { return (JSON.parse(localStorage.getItem('wb_user') || '{}') || {}).role === 'admin'; } catch { return false; } })();

const cfg = ref({ root: '', root_ok: false, stats: { total: 0, covers: 0, nocover: 0, pending: 0 } });
const stats = computed(() => cfg.value.stats || { total: 0, covers: 0, nocover: 0, pending: 0 });
const rootEntries = ref([]);
const treeLoading = ref(false);
const scanning = ref(false);

const curDir = ref('');
const lib = ref({ tracks: [], subdirs: [] });
const libLoading = ref(false);
const libError = ref('');
const msg = ref(''); // 扫描结果等一句话提示（6 秒自动消失）
const curId = computed(() => (music.index >= 0 ? music.queue[music.index]?.id : 0));

// 视图（v1.16.1 建 / v1.17.0 扩）：lib = 音乐库（目录歌曲卡片）/ fav = 收藏（原「我的收藏」）
// / settings = 音乐设置（右栏整框切换，仅管理员——系统设置页里那三张卡搬到这里）
const view = ref('lib');
const favTracks = computed(() => music.favTracks); // v1.17.0 起共享一份（musicState），底部条收藏了这里计数同步动
const curList = computed(() => (view.value === 'fav' ? favTracks.value : lib.value.tracks)); // 「全部播放」按当前视图取表

// 浏览方式（v1.16.7）：dir = 目录树（默认，照视频中心）/ artist = 歌手 → 专辑 → 歌曲（需求原话见 mcRoutes.js）
// 三级状态：curArtist（null = 全部歌手）/ curAlbum（null = 专辑层；'' 是「未知专辑」那一档，故意与 null 区分）
// / albumOpen 一算，整块右栏与返回按钮全靠它分叉
const mode = ref('dir');
const artists = ref([]);
const artLoading = ref(false);
const curArtist = ref(null);
const curAlbum = ref(null);
const albumOpen = computed(() => curAlbum.value !== null);
// 右栏专辑层要显示的那一批：全部歌手 = 各歌手的专辑摊平（卡片上带歌手名便于区分）
const curAlbums = computed(() => {
  if (curArtist.value === null) return artists.value.flatMap((a) => a.albums.map((al) => ({ ...al, artist: a.name })));
  const box = artists.value.find((x) => x.name === curArtist.value);
  return (box ? box.albums : []).map((al) => ({ ...al, artist: curArtist.value }));
});
const zoneIcon = computed(() => (view.value === 'settings' ? 'settings' : view.value === 'fav' ? 'favorite' : mode.value === 'artist' ? (albumOpen.value ? 'album' : 'person') : 'folder'));
const zoneTitle = computed(() => {
  if (view.value === 'settings') return '音乐设置';
  if (view.value === 'fav') return '收藏';
  if (mode.value === 'artist') {
    const who = curArtist.value === null ? '全部歌手' : (curArtist.value || '未知歌手');
    return albumOpen.value ? `${who} · ${curAlbum.value || '未知专辑'}` : `${who} 的专辑`;
  }
  return curDir.value || '根目录';
});
const zoneCount = computed(() => {
  if (view.value === 'settings') return `曲库共 ${stats.value.total} 首`;
  if (view.value === 'fav') return `${favTracks.value.length} 首`;
  if (mode.value === 'artist') return albumOpen.value ? `${lib.value.tracks.length} 首` : `${curAlbums.value.length} 张专辑`;
  return `${lib.value.tracks.length} 首`;
});

onMounted(async () => {
  if (mainFull) mainFull.value = true; // 整页不限宽
  loadFavs();
  loadMcCfg();
  await loadCfg();
  loadTree();
  openDir('');
});
onBeforeUnmount(() => {
  if (mainFull) mainFull.value = false;
  stopTimers();
});
// 顶部按钮直接 view='lib'（不经 closeSettings），靠 watch 统一收定时器
watch(view, (v) => { if (v !== 'settings') stopTimers(); });

// config 回包 → 面板状态（loadCfg 与每次保存的回包共用；保存后表单与服务器回包不脱节）
function applyCfg(c) {
  cfg.value = c;
  setRoot.value = c.root || '';
  const p = c.poster || {};
  poster.value = { names: p.cover_names || '', priority: p.cover_priority || 'embed', bg: p.full_bg || 'color' };
  const l = c.lyrics || {};
  lyr.value = { ...lyr.value, api: l.api_source === 'setting' ? (l.api_custom || '') : '', sourceText: sourceLabel(l.api_source), cached: l.cached || 0 };
  const sc = c.scrape || {};
  scrape.value = { ...scrape.value, ...sc };
  if (Array.isArray(sc.on)) scrapeOn.value = sc.on.slice();
  // v1.17.1 渠道地址输入框：itunes(no_url) 不出框；回填服务器存的自定义地址（空=默认）
  const urls = {};
  for (const ch of (sc.channels || [])) if (!ch.no_url) urls[ch.id] = ch.url || '';
  scrapeUrls.value = urls;
  const d = c.desk || {};
  desk.value = { on: d.on !== false, family: d.font_family || '', size: d.font_size || 36 };
}
function sourceLabel(s) {
  return s === 'setting' ? '当前地址来自本设置页' : s === 'env' ? '当前地址来自环境变量 MC_LRCLIB_BASE' : '内置默认 lrclib.net（免费无 Key）';
}
async function loadCfg() {
  try {
    applyCfg(await api.get('/mc/config'));
  } catch (e) {
    applyCfg({ root: '', root_ok: false, stats: { total: 0, covers: 0, nocover: 0, pending: 0 } });
  }
}

// ---------- 音乐设置（v1.17.0）：路径 / 封面刮削 / 海报 / 歌词API / 悬浮歌词 ----------
const setRoot = ref('');
const setSaving = ref(false);
const poster = ref({ names: '', priority: 'embed', bg: 'color' });
const lyr = ref({ api: '', sourceText: '', cached: 0, testMsg: '', testOk: false });
const lyrTesting = ref(false);
const scrapeOn = ref([]);            // 勾选的渠道 id（顺序 = 刮削优先级）
const scrapeUrls = ref({});          // v1.17.1 渠道地址 { netease:'https://…', … }（空串=用默认；itunes 无此项）
const scrapeTests = ref({});         // { netease: 'testing'|'ok'|'bad' }
const scrape = ref({ channels: [], on: [], pending: 0, scraped: 0, running: false, done: 0, total: 0, found: 0, failed: 0, current: '', log: [], finished_at: 0 });
const desk = ref({ on: true, family: '', size: 36 });
const agents = ref([]);
// 安装包 8.4MB（含字体），公网下载要几十秒——不锁按钮会被连点出一排重复下载
const pkgBusy = ref(false);
let scrapeTimer = null;
let agentTimer = null;

const scannedAtText = computed(() => {
  const t = cfg.value.scanned_at || 0;
  if (!t) return '';
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
});

function openSettings() {
  view.value = 'settings';
  loadAgents();
  startTimers();
}
function closeSettings() {
  view.value = 'lib';
  stopTimers();
}
// 刮削任务进度 2s 一拉、设备在线状态 5s 一刷（只在设置视图活着）
function startTimers() {
  stopTimers();
  scrapeTimer = setInterval(async () => {
    if (view.value !== 'settings') return;
    try { scrape.value = { ...scrape.value, ...(await api.get('/mc/scrape/status')) }; } catch { /* 静默 */ }
  }, 2000);
  agentTimer = setInterval(() => { if (view.value === 'settings') loadAgents(); }, 5000);
}
function stopTimers() {
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  if (agentTimer) { clearInterval(agentTimer); agentTimer = null; }
}
async function saveRoot() {
  setSaving.value = true;
  try { applyCfg(await api.post('/mc/settings', { root: setRoot.value.trim() })); flash('音乐路径已保存'); }
  catch (e) { flash('保存失败：' + e.message); }
  setSaving.value = false;
}
async function saveScrape() {
  setSaving.value = true;
  // 勾选与地址一次保存（服务端先验后写：地址不合法整体 400，不会落半套）
  const patch = { scrape_on: scrapeOn.value };
  const trimmed = {};
  for (const [k, v] of Object.entries(scrapeUrls.value)) trimmed[k] = String(v || '').trim();
  patch.scrape_urls = trimmed;
  try {
    applyCfg(await api.post('/mc/settings', patch));
    flash('刮削渠道已保存（勾选顺序即优先级；地址留空=用默认）');
  } catch (e) { flash('保存失败：' + e.message); }
  setSaving.value = false;
}
async function testChannel(id) {
  scrapeTests.value = { ...scrapeTests.value, [id]: 'testing' };
  try {
    const r = await api.post('/mc/scrape/test', { channel: id });
    scrapeTests.value = { ...scrapeTests.value, [id]: r.ok ? 'ok' : 'bad' };
    flash(r.ok ? `「${r.channel}」连通：${r.ms}ms 拿到 ${r.bytes}B 封面图` : `「${r.channel}」不通：${r.error}`);
  } catch (e) {
    scrapeTests.value = { ...scrapeTests.value, [id]: 'bad' };
    flash('测试失败：' + e.message);
  }
}
async function startScrape() {
  try {
    const r = await api.post('/mc/scrape/start');
    if (r.ok) {
      flash(`刮削已开始：共 ${r.total} 首（进度见下方）`);
      scrape.value = { ...scrape.value, ...(await api.get('/mc/scrape/status')) };
    }
  } catch (e) { flash(e.message); }
}
async function stopScrape() {
  try { await api.post('/mc/scrape/stop'); flash('已发停止指令（当前这首处理完即停）'); }
  catch (e) { flash(e.message); }
}
async function savePoster() {
  setSaving.value = true;
  try {
    applyCfg(await api.post('/mc/settings', { cover_names: poster.value.names, cover_priority: poster.value.priority, full_bg: poster.value.bg }));
    loadMcCfg(); // 全屏播放页的背景模式缓存同步刷一份
    flash('海报设置已保存');
  } catch (e) { flash('保存失败：' + e.message); }
  setSaving.value = false;
}
async function saveLyr() {
  setSaving.value = true;
  try { applyCfg(await api.post('/mc/settings', { lyrics_api: lyr.value.api.trim() })); flash('歌词 API 已保存'); }
  catch (e) { flash('保存失败：' + e.message); }
  setSaving.value = false;
}
async function testLyr() {
  lyrTesting.value = true;
  try {
    const r = await api.post('/mc/lyrics/test', { api: lyr.value.api.trim() });
    lyr.value.testOk = !!r.ok;
    lyr.value.testMsg = r.ok ? `✅ 连通（${r.ms}ms，检索命中 ${r.hits} 条）` : `❌ ${r.error}`;
  } catch (e) { lyr.value.testOk = false; lyr.value.testMsg = '❌ ' + e.message; }
  lyrTesting.value = false;
}
async function clearLyr() {
  try {
    const r = await api.post('/mc/lyrics/clear');
    flash(`已清空 ${r.cleared} 首歌词缓存（下次播放重新联网匹配）`);
    await loadCfg();
  } catch (e) { flash('清空失败：' + e.message); }
}
async function saveDeskOn() {
  try { applyCfg(await api.post('/mc/settings', { desk_on: desk.value.on })); }
  catch (e) { flash('保存失败：' + e.message); desk.value.on = !desk.value.on; }
}
async function saveDeskFont() {
  setSaving.value = true;
  try { applyCfg(await api.post('/mc/settings', { font_family: desk.value.family || '', font_size: Number(desk.value.size) || 36 })); flash('字体设置已保存（各设备约 2 秒后生效）'); }
  catch (e) { flash('保存失败：' + e.message); }
  setSaving.value = false;
}
async function downloadPkg(mode) {
  if (pkgBusy.value) return;
  pkgBusy.value = true;
  try {
    if (mode === 'uninstall') await api.download('/mc/agent/package?mode=uninstall', '悬浮歌词卸载包.zip');
    else await api.download('/mc/agent/package', '悬浮歌词安装包.zip');
  }
  catch (e) { flash('下载失败：' + e.message); }
  pkgBusy.value = false;
}
async function rotateKey() {
  if (!confirm('轮换密钥后所有已安装的电脑立即失联，需要重新下载安装包并重装。确定轮换？')) return;
  try { await api.post('/mc/agent/rotate-key'); flash('密钥已轮换——请重新下载安装包并在各电脑重装'); }
  catch (e) { flash('轮换失败：' + e.message); }
}
async function loadAgents() {
  try {
    const r = await api.get('/mc/agents');
    agents.value = (r.agents || []).map((a) => ({ ...a, _name: a.name || '' }));
  } catch { agents.value = []; }
}
async function renameAgent(a) {
  const v = String(a._name || '').trim();
  if (v === (a.name || '')) return;
  try { await api.put('/mc/agents/' + encodeURIComponent(a.id), { name: v }); a.name = v; }
  catch (e) { flash('改名失败：' + e.message); }
}
async function toggleAgentShow(a) {
  const to = !a.show;
  try { await api.put('/mc/agents/' + encodeURIComponent(a.id), { show: to }); a.show = to; }
  catch (e) { flash('保存失败：' + e.message); }
}
async function delAgent(a) {
  if (!confirm(`从清单移除「${a.name || a.computer || a.id}」？（电脑再上线会重新登记；要彻底停用请在那台电脑上双击卸载.cmd）`)) return;
  try { await api.del('/mc/agents/' + encodeURIComponent(a.id)); agents.value = agents.value.filter((x) => x.id !== a.id); }
  catch (e) { flash('删除失败：' + e.message); }
}
function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
async function loadTree() {
  treeLoading.value = true;
  try {
    const r = await api.get('/mc/tree');
    rootEntries.value = r.entries || [];
  } catch { rootEntries.value = []; }
  treeLoading.value = false;
}
async function openDir(dir) {
  curDir.value = dir;
  libLoading.value = true;
  libError.value = '';
  try {
    const r = await api.get('/mc/library?dir=' + encodeURIComponent(dir));
    lib.value = { tracks: r.tracks || [], subdirs: r.subdirs || [] };
  } catch (e) { libError.value = e.message; }
  libLoading.value = false;
}
function playTrack(i) {
  playList(lib.value.tracks, i);
  music.barOpen = true; // 点歌浮出底部播放条
}

// ---------- 歌手 / 专辑（v1.16.7）----------
// 数据全来自曲库已有的 artist/album 列（服务端 GROUP BY，无新表）；这一层只做「谁 → 哪张 → 哪些歌」的走位
async function loadArtists() {
  artLoading.value = true;
  try { const r = await api.get('/mc/artists'); artists.value = r.artists || []; } catch { artists.value = []; }
  artLoading.value = false;
}
async function setMode(m) {
  if (mode.value === m) return;
  mode.value = m;
  if (m === 'artist') {
    if (!artists.value.length) await loadArtists();
  } else {
    curArtist.value = null;
    curAlbum.value = null;
    await openDir(curDir.value); // 从专辑层切回目录时，右栏得重新拉回该目录的歌
  }
}
async function openArtist(name) {
  curArtist.value = name;
  curAlbum.value = null;
  if (!artists.value.length) await loadArtists();
  // 重新扫描后这个歌手可能整个消失了——别让左栏高亮停在一个不存在的名字上
  if (curArtist.value !== null && !artists.value.some((a) => a.name === curArtist.value)) curArtist.value = null;
}
async function openAlbum(artist, album) {
  curArtist.value = artist;   // 从「全部专辑」点进某张时左栏跟着选中该歌手，层级不会打架
  curAlbum.value = album;
  libLoading.value = true;
  libError.value = '';
  try {
    const r = await api.get(`/mc/album-tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
    lib.value = { tracks: r.tracks || [], subdirs: [] };
  } catch (e) { libError.value = e.message; }
  libLoading.value = false;
}
function backFromArtist() {
  if (albumOpen.value) { curAlbum.value = null; return; } // 返回该歌手的专辑层
  curArtist.value = null;                                 // 再退一层 = 全部歌手的专辑
  lib.value = { tracks: [], subdirs: [] };
}
async function playAlbum(al) {
  await openAlbum(al.artist, al.name);
  if (lib.value.tracks.length) { playList(lib.value.tracks, 0); music.barOpen = true; }
}
async function queueAlbum(al) {
  try {
    const r = await api.get(`/mc/album-tracks?artist=${encodeURIComponent(al.artist)}&album=${encodeURIComponent(al.name)}`);
    const list = r.tracks || [];
    if (!list.length) return;
    music.barOpen = true;
    if (!music.playing && music.index < 0) { playList(list, 0); return; } // 队列空时直接从头播
    for (const t of list) enqueue(t);
    flash(`已把「${al.name || '未知专辑'}」${list.length} 首加入待播`);
  } catch (e) { flash('加入待播失败：' + e.message); }
}
function playFavTrack(i) {
  playList(favTracks.value, i);
  music.barOpen = true;
}
function playAll() { if (view.value === 'fav') playFavTrack(0); else playTrack(0); }
function addQueue(t) {
  music.barOpen = true;
  if (!music.playing && music.index < 0) { playList([t], 0); return; } // 队列空时直接播这首
  enqueue(t);
  flash(`已把「${t.title}」加入待播`);
}

// ---------- 收藏（v1.16.1）：卡片心形即时收藏/取消；收藏夹视图里能播、能加待播、能删 ----------
// v1.17.0 起列表本身就是 musicState 共享份（loadFavs 一次拉 ids+完整行），不再单独 fetch。
async function openFavView() {
  view.value = 'fav';
  await loadFavs();
}
async function favCard(t) {
  const on = await toggleFav(t);
  loadFavs();
  flash(on ? `已收藏「${t.title}」` : `已取消收藏「${t.title}」`);
}
async function unfav(t) {
  await toggleFav(t);
  await loadFavs();
  flash(`已从收藏移除「${t.title}」`);
}
function flash(text) {
  msg.value = text;
  setTimeout(() => { if (msg.value === text) msg.value = ''; }, 2500);
}
async function rescan() {
  scanning.value = true;
  try {
    const r = await api.post('/mc/scan');
    await loadCfg();
    loadTree();
    // 扫描后当前视图要重新对齐：目录模式回该目录；歌手模式重拉歌手表（刚消失的歌手要让左栏高亮落地）
    if (mode.value === 'artist') {
      await loadArtists();
      if (curArtist.value !== null && !artists.value.some((a) => a.name === curArtist.value)) { curArtist.value = null; curAlbum.value = null; }
      if (albumOpen.value) await openAlbum(curArtist.value, curAlbum.value);
    } else await openDir(curDir.value);
    if (r.ok) {
      const parts = [];
      if (r.added) parts.push(`新增 ${r.added}`);
      if (r.updated) parts.push(`更新 ${r.updated}`);
      if (r.removed) parts.push(`移除 ${r.removed}`);
      msg.value = `扫描完成：共 ${r.total} 首` + (parts.length ? '（' + parts.join('，') + '）' : '，无变化');
    } else msg.value = r.error || '扫描失败';
  } catch (e) { msg.value = '扫描失败：' + e.message; }
  scanning.value = false;
  setTimeout(() => { if (msg.value.startsWith('扫描')) msg.value = ''; }, 6000);
}
</script>

<style scoped>
.mc { display: flex; flex-direction: column; gap: 12px; }
.mc-empty { padding: 44px; }
.mc-empty .ph { text-align: center; color: var(--muted); line-height: 2; }
.mc-empty .ph b { color: var(--text); font-size: 15px; }
.mc-head { display: flex; align-items: center; gap: 10px; }
.mc-head .cur { font-size: 15px; font-weight: 600; }
.grow { flex: 1; }
.mc-main { display: flex; gap: 12px; align-items: stretch; min-height: 420px; }
.mc-left { width: 250px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; }
/* 四张统计卡（目录树上方，两列两行） */
.mc-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mc-stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.mc-stat b { font-size: 20px; }
.mc-stat span { font-size: 11.5px; color: var(--muted); }
.mc-stat.warn b { color: #e0a23c; }
/* 目录树（照视频中心样式） */
.tree { padding: 10px; overflow: auto; }
.tree-root { font-size: 13.5px; font-weight: 600; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.tree-root:hover { background: var(--bg3); }
.tree-root.sel { background: rgba(79, 124, 247, 0.18); }
.tree-children { margin-left: 10px; border-left: 1px dashed var(--border); padding-left: 4px; }
.ld { padding: 6px; font-size: 12.5px; }
.ld.err { color: var(--red); }
/* 浏览方式切换「目录 / 歌手」（v1.16.7）：两个等宽按钮，选中态沿用 .vtab.pri */
.mc-modes { display: flex; gap: 6px; }
.mc-modes .vtab { flex: 1; justify-content: center; }
/* 歌手清单（左栏，接替目录树的位置；同样自带滚动） */
.mc-artists { display: flex; flex-direction: column; gap: 1px; padding: 8px; }
.ar-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.ar-row:hover { background: var(--bg3); }
.ar-row.sel { background: rgba(79, 124, 247, 0.18); }
.ar-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-num { font-size: 11px; color: var(--muted); flex-shrink: 0; }
/* 右侧内容框 */
.zone { flex: 1; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.zone-head { display: flex; align-items: center; gap: 10px; }
.mc-subdirs { display: flex; flex-wrap: wrap; gap: 6px; }
.ph { text-align: center; color: var(--muted); padding: 40px 0; line-height: 2; }
/* 歌曲多列卡片 */
.mc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; align-content: start; overflow-y: auto; }
.mc-card { cursor: pointer; border-radius: 10px; padding: 8px; border: 1px solid transparent; }
.mc-card:hover { background: var(--bg3); }
.mc-card.playing { border-color: rgba(79, 124, 247, 0.55); background: rgba(79, 124, 247, 0.08); }
.mc-cover { position: relative; width: 100%; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--bg3); margin-bottom: 8px; }
.mc-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mc-noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 34px; }
/* 卡片上的两个圆钮（v1.16.1）：收藏心形 + 加入待播；平时隐藏，hover/已收藏时露出 */
.mc-add { position: absolute; right: 6px; bottom: 6px; width: 26px; height: 26px; border-radius: 50%; border: none;
  background: rgba(20, 22, 28, 0.72); color: #fff; font-size: 15px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .15s;
  display: inline-flex; align-items: center; justify-content: center; }
.mc-add .material-icons { font-size: 16px; }
.mc-add-queue { right: 38px; }
.mc-add.on { opacity: 1; color: #ff6b81; }  /* 已收藏：心形常驻并点亮 */
.mc-card:hover .mc-add, .mc-add:focus-visible { opacity: 1; }
/* 我的收藏列表行 */
.mc-favlist { display: flex; flex-direction: column; overflow-y: auto; flex: 1; min-height: 0; }
.fav-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.fav-row:hover { background: var(--bg3); }
.fav-row.playing { background: rgba(79, 124, 247, 0.1); }
.fav-no { width: 22px; text-align: center; color: var(--muted); font-size: 12px; flex-shrink: 0; }
.fav-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.fav-art { width: 130px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.fav-alb { width: 150px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.fav-dur { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.fav-act { background: transparent; border: none; color: var(--muted); padding: 2px 5px; cursor: pointer; flex-shrink: 0; opacity: .6; }
.fav-act:hover { opacity: 1; background: var(--bg2); border-radius: 6px; }
.fav-act.danger:hover { color: var(--red, #e04b4b); }
/* 音乐设置（v1.17.0）：右栏整框切换的设置视图——五段卡片纵向排，自身滚动 */
.mc-set { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; flex: 1; min-height: 0; padding-right: 2px; }
.set-sec { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.set-sec h3 { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; margin: 0; }
.set-sec h3 .material-icons { color: #4f7cf7; }
.tip { font-size: 12px; color: var(--muted); line-height: 1.7; }
.tip.ok { color: #3fae62; }
.tip.bad { color: var(--red, #e04b4b); }
.lab { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.opt { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.opt label, .sc-chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
.sc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sc-row input[type='text'], .sc-row input:not([type]), .sc-row select { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; color: var(--text); font-size: 13px; min-width: 0; }
/* 全局 select{width:100%} 会把字体下拉撑满整行（实测 930px），字号框/保存按钮被挤去第二行——
   行内下拉改为吃剩余空间，不再独占 */
.sc-row select { flex: 1 1 180px; width: auto; }
.sc-ch { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; flex-wrap: wrap; }
.sc-url { flex: 1 1 100%; padding-left: 24px; }   /* 地址输入框独占一行，左缘与渠道名对齐 */
.sc-url input.grow { font-size: 12px; }
.sc-rec { flex: 1 1 100%; padding-left: 24px; word-break: break-all; }
.sc-ch:hover { background: var(--bg3); }
.sc-chk b { font-size: 13px; }
.sc-desc { flex: 1; min-width: 0; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-log { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--muted); max-height: 130px; overflow-y: auto; line-height: 1.8; font-family: var(--mono, monospace); }
/* 已安装设备清单 */
.ag-list { display: flex; flex-direction: column; gap: 4px; }
.ag-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; background: var(--bg2); border: 1px solid var(--border); }
.ag-dot { width: 8px; height: 8px; border-radius: 50%; background: #7a8090; flex-shrink: 0; }
.ag-dot.on { background: #3fae62; box-shadow: 0 0 5px rgba(63, 174, 98, 0.7); }
.ag-name { width: 130px; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; color: var(--text); font-size: 13px; }
.ag-name:hover, .ag-name:focus { border-color: var(--border); background: var(--bg3); outline: none; }
.ag-sub { flex: 1; min-width: 0; font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 图标（Material Icons 单色字体，v1.16.1 全模块统一，不再用彩色 emoji） */
.ic-sm { font-size: 15px; vertical-align: -3px; }
.big-ic { font-size: 40px; display: block; margin: 0 auto 6px; color: var(--muted); }
.mc-head .cur .material-icons { font-size: 19px; vertical-align: -4px; }
.vtab { display: inline-flex; align-items: center; gap: 3px; }
.vtab.pri { color: #4f7cf7; border-color: #4f7cf7; }
.mc-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-top: 2px; }
.mc-dur { flex-shrink: 0; background: var(--bg3); border-radius: 4px; padding: 0 5px; }
.mc-artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-album { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; min-height: 15px; }
/* 正在播的小均衡器动画 */
.mc-eq { position: absolute; left: 8px; bottom: 8px; display: flex; align-items: flex-end; gap: 2px; height: 14px; }
.mc-eq i { width: 3px; background: #4f7cf7; border-radius: 1px; animation: mceq .9s ease-in-out infinite; }
.mc-eq i:nth-child(2) { animation-delay: .25s; }
.mc-eq i:nth-child(3) { animation-delay: .5s; }
@keyframes mceq { 0%, 100% { height: 4px; } 50% { height: 14px; } }
/* 窄屏：左右上下堆叠 */
@media (max-width: 860px) {
  .mc-main { flex-direction: column; }
  .mc-left { width: auto; }
  .tree { max-height: 220px; }
}
</style>
