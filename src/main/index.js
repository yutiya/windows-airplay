'use strict';

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const geometry = require('./geometry');
const embedguard = require('./embedguard');
const { UxPlayEngine, resolveExecutable } = require('./uxplay');
const winembed = require('./winembed');

let win = null;
let tray = null;
let engine = null;
let stopWatch = null;
let embedded = null;
let quitting = false;
let panelOpen = false;
let cfg = null;
let nudgeTimers = [];
let sourceAspect = 0;   // 视频源宽高比，发现窗口时记录，用于居中留边
let lastWindowBg = '';

const ICON_FILE = path.join(__dirname, '..', '..', 'assets', 'tray.png');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');
const IDLE_BG = '#0b0e13';
const STAGE_PADDING = 10;   // CSS 像素：画面四周留出的背景色取景框
const VERIFY_INTERVAL = 200;

function logFilePath() {
  return path.join(app.getPath('userData'), 'engine.log');
}

function persistLog(line) {
  try {
    fs.appendFileSync(logFilePath(), new Date().toISOString().slice(11, 23) + ' ' + line + '\n', 'utf8');
  } catch (_) { /* 日志写入失败不影响运行 */ }
}

function validColor(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : '#000000';
}

function streamBg() {
  return validColor(cfg && cfg.streamBgColor);
}

function parentHwnd() {
  if (!win || win.isDestroyed()) return 0;
  const buf = win.getNativeWindowHandle();
  if (!buf || !buf.length) return 0;
  try {
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch (_) {
    return 0;
  }
}

function scaleFactor() {
  if (cfg && cfg.dpiScale > 0) return Number(cfg.dpiScale);
  try {
    return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  } catch (_) {
    return 1;
  }
}

function paddingPx() {
  return Math.round(STAGE_PADDING * scaleFactor());
}

// native 子窗口坐标是父窗口客户区的物理像素，而 getContentSize() 给的是 DIP
function stageClientRect() {
  if (!win || win.isDestroyed()) return null;
  const [width, height] = win.getContentSize();
  const factor = scaleFactor();
  const top = cfg.hideToolbar ? 0 : Math.round(Number(cfg.toolbarHeight) * factor);
  return {
    x: 0,
    y: top,
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor) - top)
  };
}

function videoRect() {
  const stage = stageClientRect();
  return stage ? geometry.fitRect(stage, sourceAspect, paddingPx()) : null;
}

// 覆盖模式用：把 Electron 客户区换算成屏幕物理像素坐标
function videoScreenRect() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getContentBounds();
  const factor = scaleFactor();
  const top = cfg.hideToolbar ? 0 : Math.round(Number(cfg.toolbarHeight) * factor);
  const stage = {
    x: Math.round(bounds.x * factor),
    y: Math.round(bounds.y * factor) + top,
    width: Math.max(1, Math.round(bounds.width * factor)),
    height: Math.max(1, Math.round(bounds.height * factor) - top)
  };
  return geometry.fitRect(stage, sourceAspect, paddingPx());
}

function currentRect() {
  return embedded && embedded.mode === 'owned' ? videoScreenRect() : videoRect();
}

function syncVideoRect() {
  // 面板打开时视频窗口被刻意隐藏，别因为 resize 又把它显示出来
  if (panelOpen || !embedded || !embedded.hwnd) return;
  try {
    if (embedded.mode === 'owned') winembed.repositionOwned(embedded.hwnd, videoScreenRect(), false);
    else if (embedded.mode === 'child') winembed.move(embedded.hwnd, videoRect());
  } catch (_) { /* 窗口可能已销毁 */ }
}

function statePayload() {
  const exe = cfg ? resolveExecutable(cfg) : null;
  return {
    settings: cfg,
    engine: {
      path: exe || '',
      exists: Boolean(exe),
      running: engine ? engine.running : false,
      pid: engine ? engine.pid : null,
      state: engine ? engine.state : 'stopped',
      lastError: engine ? engine.lastError : ''
    },
    logs: engine ? engine.logs.slice(-200) : [],
    embedded: Boolean(embedded),
    alwaysOnTop: win && !win.isDestroyed() ? win.isAlwaysOnTop() : false,
    fullScreen: win && !win.isDestroyed() ? win.isFullScreen() : false,
    version: app.getVersion()
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', statePayload());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function applyWindowBackground(state) {
  if (!win || win.isDestroyed()) return;
  const color = state === 'streaming' ? streamBg() : IDLE_BG;
  if (color === lastWindowBg) return;
  lastWindowBg = color;
  try { win.setBackgroundColor(color); } catch (_) { /* 老版本 Electron 忽略 */ }
}

function clearNudgeTimers() {
  for (const timer of nudgeTimers) clearTimeout(timer);
  nudgeTimers = [];
}

// 管线开始推流 / 首次嵌入完成后，温和校正窗口：只重发几何并请求重绘，
// 不换父窗口，避免打断 D3D 的 swapchain。
// 注意：管线信号常早于窗口出现，所以这里即使还没嵌入也先把定时器排上。
function scheduleNudges(reason) {
  clearNudgeTimers();
  engine.emit('log', `[画面] ${reason}，正在校正视频窗口`);
  for (const delay of [250, 900, 2000]) {
    nudgeTimers.push(setTimeout(() => {
      if (quitting || !embedded || !embedded.hwnd || panelOpen) return;
      try {
        if (embedded.mode === 'child') winembed.nudge(embedded.hwnd, videoRect());
        else if (embedded.mode === 'owned') winembed.repositionOwned(embedded.hwnd, videoScreenRect(), false);
      } catch (_) { /* 窗口已销毁 */ }
    }, delay));
  }
}

// 每次轮询都做的连续校验：这是「第一次投屏就有画面」的核心保障。
// 引擎可能不主动显示隐藏窗口、可能重建父子关系、可能把窗口挪回原始尺寸，
// 这里逐项确认并就地修复，不需要用户断开重连第二次。
function verifyEmbedded(rec) {
  return embedguard.verifyEmbedded({
    quitting,
    panelOpen,
    streaming: Boolean(engine && engine.state === 'streaming'),
    embedded,
    hwnd: rec.hwnd,
    parentHwnd: parentHwnd(),
    currentRect,
    aspect: sourceAspect,
    winembed,
    log: (line) => engine.emit('log', line),
    onAspectChanged: (ratio) => { sourceAspect = ratio; }
  });
}

function stopWatching() {
  clearNudgeTimers();
  if (stopWatch) {
    try { stopWatch(); } catch (_) { /* 忽略清理异常 */ }
    stopWatch = null;
  }
  embedded = null;
}

function startWatching(pid) {
  if (!pid) return;
  stopWatching();
  const mode = cfg.embedMode || 'child';
  const grace = Math.max(0, Math.min(5000, Number(cfg.embedDelayMs) || 0));
  engine.emit('log', `[画面] 嵌入模式 = ${mode}${mode === 'child' ? '（当前窗口内显示）' : ''}，首帧保护 ${grace}ms`);
  stopWatch = winembed.watch(pid, {
    interval: VERIFY_INTERVAL,
    settleMs: 0,               // 窗口一出现就嵌入，不给它变成独立窗口的机会
    verify: verifyEmbedded,
    release: (hwnd, previous) => {
      if (mode === 'owned') winembed.detachOwned(hwnd, previous);
      else if (mode === 'child') winembed.detach(hwnd, previous);
    },
    onCandidate: (found, waited, all) => {
      if (waited === 0) {
        const list = (all || []).map((w) => `${w.hwnd}/${w.cls}/${w.width}x${w.height}/vis=${w.visible}/"${w.title}"`).join(', ');
        engine.emit('log', `[画面] 候选窗口 ${(all || []).length} 个：${list}`);
        engine.emit('log', `[画面] 选中 hwnd=${found.hwnd} class=${found.cls} ${found.width}x${found.height} visible=${found.visible}，立即嵌入当前窗口`);
      }
    },
    onFound: (found, waited) => {
      const parent = parentHwnd();
      if (!parent) return null;
      sourceAspect = geometry.aspectOf(found) || sourceAspect;
      try {
        let previous = 0;
        if (mode === 'child') {
          // 先只建立父子关系、保持隐藏；显示交给引擎或首帧保护
          previous = winembed.embed(found.hwnd, parent, videoRect(), { show: false });
          if (winembed.getParent(found.hwnd) !== parent) {
            winembed.embed(found.hwnd, parent, videoRect(), { show: false });
          }
          if (winembed.getParent(found.hwnd) !== parent) {
            engine.emit('log', '[错误] SetParent 未生效，下一轮重试');
            return null;
          }
        } else if (mode === 'owned') {
          previous = winembed.attachAsOwned(found.hwnd, parent, videoScreenRect());
        } else {
          winembed.show(found.hwnd, true);
        }
        embedded = {
          hwnd: found.hwnd,
          originalStyle: previous,
          mode,
          showAfter: Date.now() + (mode === 'child' ? grace : 0)
        };
        engine.emit('log', `[画面] 已${mode === 'detached' ? '发现（独立窗口）' : '嵌入当前窗口'}（${waited}ms，源 ${found.width}x${found.height}，宽高比 ${sourceAspect.toFixed(3)}）`);
        if (panelOpen && mode !== 'detached') winembed.show(found.hwnd, false);
        engine.setState('streaming');
        broadcast();
        scheduleNudges('首次嵌入完成');
        return previous;
      } catch (err) {
        engine.emit('log', `[错误] 嵌入视频窗口失败：${err.message}`);
        return null;
      }
    },
    onLost: () => {
      embedded = null;
      if (engine.running && engine.state === 'streaming') engine.setState('waiting');
      broadcast();
    }
  });
}

// 手动「重新嵌入」：彻底 detach 再挂一次 watcher，用于自动校正仍无效时兜底
function reembed() {
  if (!engine.running || !engine.pid) {
    engine.emit('log', '[画面] 接收端未运行，无法重新嵌入');
    return false;
  }
  engine.emit('log', '[画面] 手动重新嵌入视频窗口');
  startWatching(engine.pid);
  return true;
}

function startEngine() {
  const result = engine.start(cfg);
  // 正常启动 / 自动重启都会由 engine 的 'started' 事件挂上 watcher
  broadcast();
  return result;
}

function stopEngine() {
  stopWatching();
  engine.stop();
  broadcast();
}

function restartEngine() {
  stopEngine();
  // Qt 引擎有单实例锁，等旧进程释放端口后再拉起
  setTimeout(() => {
    if (!quitting) startEngine();
  }, 1800);
}

// 工具栏隐藏后靠托盘菜单或 Alt+T 唤回，避免出现「关掉就找不回来」的死角
function toggleToolbar() {
  cfg = config.save({ hideToolbar: !cfg.hideToolbar });
  syncVideoRect();
  broadcast();
  refreshTray();
  if (cfg.hideToolbar) {
    send('notice', '工具栏已隐藏：按 Alt+T，或右键托盘图标选「显示工具栏」即可恢复。');
  } else {
    send('notice', '工具栏已显示。');
  }
  return cfg.hideToolbar;
}

function wireEngine() {
  engine.on('log', (line) => { persistLog(line); send('log', line); });
  engine.on('state', (state) => {
    applyWindowBackground(state);
    // 断开后隐藏画面，让占位提示重新可见；重新投屏时由连续校验负责显示回来
    if (embedded && embedded.hwnd && state !== 'streaming') {
      try { winembed.show(embedded.hwnd, false); } catch (_) { /* 窗口可能已销毁 */ }
    }
    broadcast();
  });
  engine.on('started', ({ pid }) => { if (!quitting) startWatching(pid); });
  engine.on('problem', (line) => send('notice', line));
  engine.on('pipeline-ready', () => {
    engine.emit('log', '[画面] 检测到 GStreamer 视频管线开始推流');
    if (engine.running && embedded && engine.state !== 'streaming') engine.setState('streaming');
    scheduleNudges('视频管线开始推流');
  });
  engine.on('client-hint', (kind) => {
    if (kind === 'disconnected' && engine.running && engine.state === 'streaming') {
      engine.setState('waiting');
    } else if (kind === 'connected' && engine.running && embedded && engine.state !== 'streaming') {
      engine.setState('streaming');
    }
    broadcast();
  });
  engine.on('exit', () => {
    stopWatching();
    broadcast();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: IDLE_BG,
    title: '免费投屏 · AirPlay 接收端',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenu(null);
  win.loadFile(RENDERER);
  lastWindowBg = IDLE_BG;

  // 主进程层拦截快捷键：工具栏隐藏、渲染层按钮不可见时依然有效
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.alt && !input.control && !input.meta
        && String(input.key).toLowerCase() === 't') {
      event.preventDefault();
      toggleToolbar();
    }
  });

  win.on('resize', syncVideoRect);
  win.on('move', syncVideoRect);
  win.on('enter-full-screen', () => { broadcast(); setTimeout(syncVideoRect, 150); });
  win.on('leave-full-screen', () => { broadcast(); setTimeout(syncVideoRect, 150); });
  win.on('closed', () => { win = null; });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    send('notice', '主窗口已隐藏到托盘，点击托盘图标可恢复。');
  });
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const template = [
    { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
    { type: 'separator' },
    { label: engine.running ? '重启接收端' : '启动接收端', click: () => restartEngine() },
    { label: '停止接收端', enabled: engine.running, click: () => stopEngine() },
    { label: '重新嵌入画面（黑屏时用）', click: () => reembed() },
    { label: cfg.hideToolbar ? '显示工具栏' : '隐藏工具栏', click: () => toggleToolbar() },
    { type: 'separator' },
    {
      label: '全屏', type: 'checkbox', checked: win ? win.isFullScreen() : false,
      click: (item) => { if (win) win.setFullScreen(item.checked); broadcast(); }
    },
    {
      label: '窗口置顶', type: 'checkbox', checked: win ? win.isAlwaysOnTop() : false,
      click: (item) => { if (win) win.setAlwaysOnTop(item.checked, 'floating'); broadcast(); }
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  if (!fs.existsSync(ICON_FILE)) {
    console.warn('[托盘] 缺少 assets/tray.png，托盘图标不可用');
    return;
  }
  tray = new Tray(nativeImage.createFromPath(ICON_FILE));
  tray.setToolTip('免费投屏 · AirPlay 接收端');
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  refreshTray();
}

function registerIpc() {
  ipcMain.handle('app:state', () => statePayload());

  ipcMain.handle('app:start', () => startEngine());
  ipcMain.handle('app:stop', () => { stopEngine(); return true; });
  ipcMain.handle('app:restart', () => { restartEngine(); return true; });
  ipcMain.handle('app:reembed', () => reembed());

  ipcMain.handle('app:settings', (_event, patch) => {
    cfg = config.save(patch || {});
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'alwaysOnTop') && win) {
      win.setAlwaysOnTop(Boolean(patch.alwaysOnTop), 'floating');
    }
    syncVideoRect();
    lastWindowBg = '';
    applyWindowBackground(engine.state);
    // 切换嵌入模式后立即用新模式重新处理窗口，无需重启引擎
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'embedMode') && engine.running && engine.pid) {
      setTimeout(() => reembed(), 60);
    }
    broadcast();
    refreshTray();
    return cfg;
  });

  ipcMain.handle('app:fullscreen', () => {
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    broadcast();
    refreshTray();
    return win.isFullScreen();
  });

  ipcMain.handle('app:always-on-top', () => {
    if (!win) return false;
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next, 'floating');
    cfg = config.save({ alwaysOnTop: next });
    broadcast();
    refreshTray();
    return next;
  });

  ipcMain.handle('app:toolbar', () => toggleToolbar());

  ipcMain.handle('app:pick-uxplay', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择 uxplay.exe',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('app:panel', (_event, open) => {
    panelOpen = Boolean(open);
    if (embedded && embedded.hwnd) {
      try {
        winembed.show(embedded.hwnd, !panelOpen);
        if (!panelOpen) syncVideoRect();
      } catch (_) { /* 窗口可能已销毁 */ }
    }
    return panelOpen;
  });

  ipcMain.handle('app:minimize', () => { if (win) win.minimize(); return true; });
  ipcMain.handle('app:hide', () => { if (win) win.hide(); return true; });
  ipcMain.handle('app:open-userdata', () => { shell.openPath(app.getPath('userData')); return true; });
  ipcMain.handle('app:open-log', () => {
    const file = logFilePath();
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    shell.openPath(file);
    return file;
  });
  ipcMain.handle('app:open-external', (_event, url) => { shell.openExternal(url); return true; });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); return true; });

  engine.on('state', refreshTray);
  engine.on('exit', refreshTray);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    cfg = config.load();
    persistLog('===== 应用启动，引擎模式 ' + cfg.embedMode + ' =====');
    engine = new UxPlayEngine();
    wireEngine();
    createWindow();
    createTray();
    registerIpc();
    if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    if (cfg.autoStart) startEngine();
    // 页面加载完成后补发一次完整状态；若上次是隐藏工具栏，提示恢复方式
    win.webContents.on('did-finish-load', () => {
      broadcast();
      if (cfg.hideToolbar) {
        send('notice', '工具栏当前是隐藏状态：按 Alt+T 或右键托盘图标选「显示工具栏」即可恢复。');
      }
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不随最后一个窗口退出
  });

  app.on('before-quit', () => {
    quitting = true;
    stopWatching();
    if (engine) engine.stop();
  });
}
