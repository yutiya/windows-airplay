'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// 所有可调项集中在此；设置面板写入用户数据目录下的 settings.json
// dev 分支：画面默认真正嵌入当前窗口（child），并增加投屏时的舞台背景色
const CONFIG_VERSION = 2;

const DEFAULTS = Object.freeze({
  configVersion: CONFIG_VERSION,
  engineType: 'qt',            // qt = uxplay-windows 2.0 便携版；cli = 独立 uxplay.exe
  uxplayPath: '',              // 自定义引擎路径，留空则自动探测 runtime/
  serverName: '免费投屏',       // iPhone 上「屏幕镜像」列表里显示的名字
  port: 7000,                  // UxPlay 的 TCP / UDP 起始端口
  resolution: '1920x1080',     // 向客户端请求的镜像分辨率
  videoSink: 'd3d11videosink', // Windows 上优先 D3D11，兼容老集显
  audioSink: 'wasapisink',     // 仅命令行引擎使用；Qt 引擎使用自带音频输出
  keepWindow: true,            // -nc：断开后保留视频窗口，避免反复嵌入
  noHostnameSuffix: false,     // 命令行引擎的 -nh
  autoStart: true,             // 应用启动后自动拉起接收端
  autoRestart: true,           // 引擎崩溃后自动重启
  alwaysOnTop: false,
  hideToolbar: false,
  toolbarHeight: 56,           // CSS 像素，视频 native 子窗口从此偏移开始
  dpiScale: 0,                 // 0 表示按显示器缩放自动计算
  embedMode: 'child',          // child = SetParent 真正嵌入当前窗口（默认，不会另开窗口）
                               // owned = 设 owner + 按屏幕定位（排查用，仍是顶层窗口）
                               // detached = 完全不干预（排查用，独立窗口）
  embedDelayMs: 600,           // 首帧保护：窗口出现后给引擎的自行显示时间，到点仍隐藏则主动显示并重绘
  streamBgColor: '#000000',    // 投屏中舞台背景色，画面居中留边后作为取景框突出共享内容
  extraArgs: ''                // 追加给引擎的额外参数
});

let cached = null;

function configFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// v0.0.1 的默认 owned 模式会让引擎的视频窗口以独立顶层窗口浮在应用上，
// 用户看到的「又开了一个新窗口」就是它。升级到 dev 时一次性迁移到 child。
// 只改旧默认值，不动用户显式选过的其它模式。
function migrate(raw) {
  const saved = raw && typeof raw === 'object' ? raw : {};
  const next = { ...DEFAULTS, ...saved };
  if (Number(saved.configVersion || 1) < CONFIG_VERSION) {
    if (!saved.embedMode || saved.embedMode === 'owned') next.embedMode = 'child';
    if (saved.embedDelayMs === undefined || Number(saved.embedDelayMs) === 1500) {
      next.embedDelayMs = DEFAULTS.embedDelayMs;
    }
  }
  next.configVersion = CONFIG_VERSION;
  return next;
}

function load() {
  if (cached) return cached;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (_) {
    // 首次运行或配置损坏时回落到默认值
  }
  cached = migrate(saved);
  return cached;
}

function save(patch) {
  const next = { ...load(), ...patch, configVersion: CONFIG_VERSION };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

module.exports = { DEFAULTS, CONFIG_VERSION, migrate, load, save };
