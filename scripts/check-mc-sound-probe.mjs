// check-mc-sound-probe：悬浮歌词「本机在不在出声」探针的独立验证（v1.18.7 新增）。
//   背景：服务端那份「正在播放」是全家共享的，一台电脑放歌时所有装了歌词代理的电脑都弹；
//   v1.18.7 让代理探本机输出设备的峰值表（Core Audio IAudioMeterInformation），没出声就不显示。
//   本检查把 mcLyricsAgent.SOUND_PROBE_CS 原样编译成 C#，在真机上量三拍：
//     ① 静音：峰值应 < 0.001（若这台机器本来就在放声音，这一拍自动跳过）
//     ② 放一个系统提示音（SoundPlayer.PlayLooping）：峰值应 ≥ 0.001
//     ③ 停掉后：应回到 < 0.001（说明不是「一旦响过就永远算响」）
//   只操作本进程自己 new 的 SoundPlayer + 临时脚本，不碰任何用户音频会话。
//   node scripts/check-mc-sound-probe.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const mcAgent = require_(path.join(ROOT, 'server/services/mcLyricsAgent.js'));

const THRESHOLD = 0.001; // 与 PS 模板 Update-SoundState 里的阈值一致

let pass = 0, fail = 0, skip = 0;
const ok = (c, n, e) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  <<< ' + String(e || '')}`); };
const sk = (n, why) => { skip++; console.log(`  - ${n}（跳过：${why}）`); };

// 系统提示音：优先 Alarm01.wav（约 3 秒，够 PlayLooping 稳定被采到）
const WAVS = ['Alarm01.wav', 'Ring01.wav', 'chimes.wav', 'Windows Notify.wav'];
const wav = WAVS.map((f) => path.join('C:\\Windows\\Media', f)).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!wav) {
  console.log('  - 找不到 C:\\Windows\\Media 下的提示音，探针播放段无法验证');
  console.log('\n跳过：1 项（无可用音频样本）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-soundprobe-'));
const ps1 = path.join(tmp, 'probe.ps1');
const ps = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  String(mcAgent.SOUND_PROBE_CS),
  "'@",
  `$wav = '${wav.replace(/'/g, "''")}'`,
  '$ci = [System.Globalization.CultureInfo]::InvariantCulture',
  '$idle = [WbSoundProbe]::MaxPeak()',
  "Write-Output ('IDLE=' + $idle.ToString('R', $ci))",
  '$sp = New-Object System.Media.SoundPlayer $wav',
  '$sp.PlayLooping()',
  'Start-Sleep -Milliseconds 1200',
  '$peak = [WbSoundProbe]::MaxPeak()',
  "Write-Output ('PLAY=' + $peak.ToString('R', $ci))",
  '$sp.Stop()',
  'Start-Sleep -Milliseconds 1500',
  '$after = [WbSoundProbe]::MaxPeak()',
  "Write-Output ('STOP=' + $after.ToString('R', $ci))",
].join('\r\n');
fs.writeFileSync(ps1, '\uFEFF' + ps, 'utf8');

let out = '';
try {
  // 注意：不要 -ExecutionPolicy Bypass（本机 CurrentUser = RemoteSigned，直接跑即可；
  // Bypass 会被安全策略拦）。ps1 放在独立临时目录，路径全程绝对。
  out = execFileSync('powershell.exe', ['-NoProfile', '-File', ps1], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
} catch (e) {
  console.log('  ✗ powershell 执行失败：' + String(e.message || e).slice(0, 400));
  console.log(String(e.stdout || '').slice(0, 400));
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
}

if (!out) {
  console.log('  ✗ 探针没有输出（C# 编译或 COM 初始化失败）');
  process.exitCode = 1;
} else {
  const val = (k) => {
    // 必须带指数：静音时峰值常是 float 最小正数，ToString('R') 给 "2.3283064E-10"
    const m = out.match(new RegExp('^' + k + '=(-?[0-9.]+(?:[Ee][-+]?[0-9]+)?)', 'm'));
    return m ? parseFloat(m[1]) : NaN;
  };
  const idle = val('IDLE');
  const play = val('PLAY');
  const stop = val('STOP');
  console.log(`  实测：IDLE=${idle}  PLAY=${play}  STOP=${stop}  （阈值 ${THRESHOLD}）`);

  ok(Number.isFinite(idle), 'C# 编译通过且第一次取样有数值', out.slice(0, 300));
  ok(Number.isFinite(play) && Number.isFinite(stop), '三次取样都有数值', out.slice(0, 300));

  if (idle >= THRESHOLD) {
    sk('静音段峰值 < 阈值', `本机当前就在放声音（IDLE=${idle}），静音断言不可判`);
  } else if (idle === -1) {
    sk('静音段峰值 < 阈值', '这台机器没有可用输出设备（探针回 -1 = 代理退回旧行为）');
  } else {
    ok(idle >= 0 && idle < THRESHOLD, '静音段峰值 < 阈值（没声音就不弹歌词）', `IDLE=${idle}`);
  }

  ok(play >= THRESHOLD, '播放提示音时峰值 ≥ 阈值（正在出声 → 显示歌词）', `PLAY=${play}`);
  ok(play > idle, '播放段峰值显著高于静音段（探针真的跟着声音走）', `IDLE=${idle} PLAY=${play}`);

  if (stop === -1) {
    sk('停播后峰值 < 阈值', '停播后设备枚举失败（不影响线上：代理只把 -1 当「有声音」）');
  } else {
    ok(stop < THRESHOLD, '停播后峰值 < 阈值（没有「响过一次就永远算响」）', `STOP=${stop}`);
  }
}

console.log(`\n${fail === 0 ? '全绿' : '有失败'}：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exitCode = fail ? 1 : 0;
