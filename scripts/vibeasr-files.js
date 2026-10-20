// 客户端转写引擎「Windows 四件套」的唯一清单（各打包脚本共用）。
//
// 为什么单列出来：客户端安装包 setup.ps1 只能从工作台 /api/vibe/client-download 拿
// **服务器上已有**的文件；生产容器镜像打于 vibeasr/ 入仓之前，而 v1.18.x 的差分/最小包
// 又从来不带它 —— 2026-10-20 实测客户端装到一半报「服务器没有下发 Windows 引擎二进制，
// 缺 asr_stream_server.exe、libgcc_s_seh-1.dll、libstdc++-6.dll、libwinpthread-1.dll」。
// 从此以后全量包带整个 vibeasr/，最小包/差分包默认也带这四件套（约 5.6MB）。
//
// 本模块只做两件事：① 四件套缺一件就 throw（打包当场失败，不发废包）；② 给出条目清单。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WIN_ENGINE_FILES = ['asr_stream_server.exe', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'];
const WIN_DIR = path.join(ROOT, 'vibeasr', 'win-x64');

// 返回 [{ rel, abs, name, size }]；rel 用正斜杠（zip 条目名统一）
function collectVibeasrWinEntries() {
  const missing = WIN_ENGINE_FILES.filter((n) => !fs.existsSync(path.join(WIN_DIR, n)));
  if (missing.length) {
    throw new Error(
      'vibeasr/win-x64 缺客户端引擎文件：' + missing.join('、') +
      ' —— 工作区不完整（这四件套是 Windows 客户端安装包的引擎来源），先恢复后再打包'
    );
  }
  return WIN_ENGINE_FILES.map((n) => {
    const abs = path.join(WIN_DIR, n);
    return { rel: `vibeasr/win-x64/${n}`, abs, name: n, size: fs.statSync(abs).size };
  });
}

module.exports = { WIN_ENGINE_FILES, WIN_DIR, collectVibeasrWinEntries };
