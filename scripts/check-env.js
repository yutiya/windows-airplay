'use strict';

// 运行：npm run check
// 只做只读检查，不会启动投屏、不会修改系统设置。

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

function ps(command) {
  return execFileSync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', timeout: 20000, windowsHide: true
  }).trim();
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node.js', nodeMajor >= 18, 'v' + process.versions.node);

let electronVersion = '未安装';
try {
  electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
} catch (_) { /* 依赖未装 */ }
const electronBinary = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const hasBinary = fs.existsSync(electronBinary);
check(
  'Electron',
  electronVersion !== '未安装' && hasBinary,
  hasBinary ? electronVersion + '（二进制已就绪）' : electronVersion + '，但 dist/electron.exe 缺失，请执行 node node_modules/electron/install.js'
);

// 默认引擎：uxplay-windows 2.0 便携版（CPU 可移植，不需要 AVX2）
const qtExe = path.join(root, 'runtime', 'qt', 'uxplay-windows.exe');
const hasQt = fs.existsSync(qtExe);
check('Qt 引擎（默认）', hasQt, hasQt ? 'runtime/qt/uxplay-windows.exe' : '缺失，请执行 scripts/prepare-runtime.ps1');

const qtPluginDir = path.join(root, 'runtime', 'qt', 'lib', 'gstreamer-1.0');
const qtPlugins = fs.existsSync(qtPluginDir) ? fs.readdirSync(qtPluginDir).filter((f) => f.toLowerCase().endsWith('.dll')) : [];
check('Qt GStreamer 插件', qtPlugins.length > 0, qtPlugins.length ? qtPlugins.length + ' 个插件' : '未找到 ' + qtPluginDir);
if (qtPlugins.length) {
  for (const [label, keyword] of [['D3D11 视频输出', 'd3d11'], ['WASAPI2 音频输出', 'wasapi'], ['FFmpeg 解码', 'libav']]) {
    const hit = qtPlugins.find((item) => item.toLowerCase().includes(keyword));
    check(label, Boolean(hit), hit || '缺失');
  }
}

// 可选引擎：独立 uxplay.exe（需要 AVX2/BMI，旧 CPU 用不了）
const cliExe = path.join(root, 'runtime', 'bin', 'uxplay.exe');
check(
  '命令行引擎（可选）',
  fs.existsSync(cliExe) ? true : null,
  fs.existsSync(cliExe) ? 'runtime/bin/uxplay.exe（需 AVX2 CPU）' : '未安装，可忽略；Qt 引擎已足够'
);

try {
  const status = ps('(Get-Service "Bonjour Service" -ErrorAction SilentlyContinue).Status');
  check('Bonjour 服务', status === 'Running' ? true : null, status === 'Running' ? '运行中' : (status || '未安装') + '（AirPlay 服务发现依赖它）');
} catch (_) {
  check('Bonjour 服务', null, '无法检测，请确认 Bonjour Service 正在运行');
}

check('托盘图标', fs.existsSync(path.join(root, 'assets', 'tray.png')), 'assets/tray.png');

try {
  const winembed = require(path.join(root, 'src', 'main', 'winembed.js'));
  const windows = winembed.windowsOfPid(process.pid);
  check('Win32 窗口嵌入', true, 'koffi 调用正常，枚举到 ' + windows.length + ' 个窗口');
} catch (err) {
  check('Win32 窗口嵌入', false, String(err.message || err).split('\n')[0]);
}

try {
  const category = ps('(Get-NetConnectionProfile | Select-Object -First 1 -ExpandProperty NetworkCategory)');
  check(
    '网络类型',
    category === 'Private' ? true : null,
    category === 'Private' ? '专用网络' : category + '（AirPlay 需要「专用」，请在系统设置里改）'
  );
} catch (_) {
  check('网络类型', null, '无法检测，请手动确认是「专用网络」');
}

console.log('\n  免费投屏 · 环境自检\n');
for (const item of results) {
  const mark = item.ok === true ? '[正常]' : item.ok === false ? '[异常]' : '[注意]';
  console.log('  ' + mark + '  ' + item.name.padEnd(20, ' ') + '  ' + item.detail);
}
const failed = results.filter((item) => item.ok === false).length;
console.log('\n  ' + (failed ? failed + ' 项异常，请先处理再启动。' : '关键项检查通过，可以执行 npm start。') + '\n');
process.exit(failed ? 1 : 0);
