'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// 所有可调项集中在此；设置面板写入用户数据目录下的 settings.json
const DEFAULTS = Object.freeze({
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
  embedMode: 'owned',          // owned = 设 owner + 按屏幕定位（默认，不换父窗口）
                               // child = SetParent 嵌入；detached = 完全不干预，窗口独立显示
  embedDelayMs: 1500,          // 视频窗口出现后等待多久再嵌入（首次连接黑屏时调大）
  extraArgs: ''                // 追加给引擎的额外参数
});

let cached = null;

function configFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cached) return cached;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (_) {
    // 首次运行或配置损坏时回落到默认值
  }
  cached = { ...DEFAULTS, ...saved };
  return cached;
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

module.exports = { DEFAULTS, load, save };
