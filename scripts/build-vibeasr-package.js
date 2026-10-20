#!/usr/bin/env node
// 客户端引擎四件套修复包：只装 vibeasr/win-x64 的 4 个文件（约 5.6MB），用于把
// 「服务器没有下发 Windows 引擎二进制」修好，不覆盖任何前端/服务端代码（除非 --extra）。
//
// 背景（2026-10-20）：生产 cc.in1912.cc 的 <app>/vibeasr/win-x64 一直是空的——基础镜像
// 打于该目录入仓之前，而 v1.18.x 全走差分/最小包，两个打包器都不带 vibeasr/。Windows
// 客户端 setup.ps1 拉不到引擎，装到一半就 FATAL 停下。此后 build-full/min/diff 三个
// 打包器默认都带四件套，本脚本是给「已经在跑的旧生产」补一次的服务端补丁包。
//
// 用法：node scripts/build-vibeasr-package.js [版本号，默认取 package.json] [--extra <仓库相对路径>]...
//   --extra 可多次。建议带上 server/routes/upgradeRoutes.js —— 它会把 vibeasr/ 镜像进
//   持久卷 <data>/vibeasr/，容器重建后仍在（不带的包只在可写层生效）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildZip } = require('../server/services/zipService');
const { collectVibeasrWinEntries } = require('./vibeasr-files');

const ROOT = path.join(__dirname, '..');
const version = String(process.argv[2] || require('../package.json').version).trim();
if (!/^[\w.-]+$/.test(version)) { console.error('用法：node scripts/build-vibeasr-package.js [版本号] [--extra <路径>]...'); process.exit(1); }
const extras = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--extra') extras.push(String(process.argv[++i] || ''));
}

const entries = [];
const files = [];
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const addFile = (abs, name) => {
  const data = fs.readFileSync(abs);
  entries.push({ name, data });
  files.push({ path: name, size: data.length, hash: hashBuf(data) });
};

for (const f of collectVibeasrWinEntries()) addFile(f.abs, f.rel);
for (const rel of extras) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.error('--extra 文件不存在：' + rel); process.exit(1); }
  addFile(abs, rel.replace(/\\/g, '/'));
}

const meta = {
  version,
  title: `客户端引擎四件套修复包 ${version}（vibeasr/win-x64）`,
  content: '只带 Windows 客户端转写引擎四件套（asr_stream_server.exe + 三个 MinGW 运行时 DLL）。'
    + '用于修复服务端 <app>/vibeasr/win-x64 为空导致客户端 setup.ps1 报「服务器没有下发 Windows 引擎二进制」。'
    + 'apply 为合并覆盖语义，不动其它文件。',
  dist: null,
  files,
  dist_files: 0,
  created_at: new Date().toISOString(), created_by: 'admin',
};
entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2) });

const buf = buildZip(entries);
const pkgDir = path.join(ROOT, 'data', 'upgrades');
if (!fs.existsSync(pkgDir)) fs.mkdirSync(pkgDir, { recursive: true });
const ts = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const out = path.join(pkgDir, `${ts}_${version}-vibeasr-win.zip`);
fs.writeFileSync(out, buf);
console.log('== 客户端引擎修复包已生成 ==');
console.log(`  文件：${path.basename(out)}（${(buf.length / 1048576).toFixed(2)} MB，${entries.length} 个条目）`);
for (const f of files) console.log(`    ${f.path}  ${(f.size / 1024).toFixed(0)} KB  ${f.hash.slice(0, 12)}`);
if (extras.length) console.log(`  extra：${extras.join(', ')}`);
