(function () {
'use strict';

// 全部放进函数作用域：contextBridge 会在隔离世界注入名为 api 的绑定，
// 若在全局再 const 一个 api 会触发 "Identifier 'api' has already been declared"。
const $ = (selector) => document.querySelector(selector);
const api = window.api;

const STATUS = {
  stopped: ['接收端未运行', 'stopped'],
  starting: ['正在启动引擎…', 'waiting'],
  waiting: ['等待 iPhone 连接', 'waiting'],
  streaming: ['正在投屏', 'streaming'],
  error: ['引擎异常', 'error']
};

const FIELDS = [
  'uxplayPath', 'engineType', 'embedMode', 'serverName', 'port', 'resolution', 'videoSink',
  'audioSink', 'toolbarHeight', 'dpiScale', 'embedDelayMs', 'extraArgs'
];
const CHECKS = ['keepWindow', 'noHostnameSuffix', 'autoStart', 'autoRestart'];

let state = null;
let panel = null;
let toastTimer = null;

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

function setPanel(next) {
  panel = next;
  $('#settings').classList.toggle('hidden', next !== 'settings');
  $('#logs').classList.toggle('hidden', next !== 'logs');
  api.setPanelOpen(Boolean(next));
  if (next === 'settings') fillSettings();
  if (next === 'logs') renderLogs();
}

function renderPlaceholder(s) {
  const engine = s.engine;
  const title = $('#ph-title');
  const desc = $('#ph-desc');
  const warn = $('#ph-warn');
  const steps = $('#steps');

  $('#ph-name').textContent = s.settings.serverName || '免费投屏';
  warn.classList.add('hidden');
  steps.classList.remove('hidden');

  if (!engine.exists) {
    title.textContent = '缺少 AirPlay 引擎';
    desc.textContent = '还没有找到 uxplay.exe，先准备运行时才能开始投屏。';
    steps.classList.add('hidden');
    warn.className = 'warn danger';
    warn.textContent = '请在「设置」中选择 uxplay.exe，或按 README 的步骤把运行时放进 runtime/ 目录。';
    warn.classList.remove('hidden');
    return;
  }
  if (engine.state === 'error') {
    title.textContent = '引擎启动失败';
    desc.textContent = engine.lastError || '请打开「日志」查看详情。';
    steps.classList.add('hidden');
    warn.className = 'warn danger';
    warn.textContent = '常见原因：缺少 GStreamer 插件、端口被占用、防火墙拦截，或 uxplay.exe 版本不兼容。';
    warn.classList.remove('hidden');
    return;
  }
  if (engine.state === 'stopped') {
    title.textContent = '接收端已停止';
    desc.textContent = '点击右上角「启动」，让这台电脑出现在 iPhone 的屏幕镜像列表里。';
    return;
  }
  if (engine.state === 'starting') {
    title.textContent = '正在启动 AirPlay 服务';
    desc.textContent = '首次启动需要初始化 GStreamer 插件，请稍候几秒。';
    return;
  }
  title.textContent = '等待 iPhone 连接';
  desc.textContent = '手机与电脑需要在同一局域网，且电脑网络类型为「专用」。';
}

function render(s) {
  state = s;
  const cfg = s.settings;
  const engine = s.engine;
  const [text, cls] = STATUS[engine.state] || STATUS.stopped;

  $('#status').className = 'status ' + cls;
  $('#status-text').textContent = text;
  $('#btn-start').textContent = engine.running ? '停止' : '启动';
  $('#btn-fullscreen').classList.toggle('active', s.fullScreen);
  $('#btn-ontop').classList.toggle('active', s.alwaysOnTop);
  $('#btn-toolbar').textContent = cfg.hideToolbar ? '显示栏' : '隐藏栏';

  document.documentElement.style.setProperty('--toolbar-h', String(cfg.toolbarHeight || 0) + 'px');
  document.body.classList.toggle('no-toolbar', Boolean(cfg.hideToolbar));

  if (engine.state === 'streaming') {
    $('#placeholder').classList.add('hidden');
  } else {
    $('#placeholder').classList.remove('hidden');
    renderPlaceholder(s);
  }
}

function appendLog(line) {
  const view = $('#log-view');
  view.textContent += line + '\n';
  if (panel === 'logs') view.scrollTop = view.scrollHeight;
}

function renderLogs() {
  const view = $('#log-view');
  view.textContent = (state && state.logs ? state.logs : []).join('\n') + '\n';
  view.scrollTop = view.scrollHeight;
}

function fillSettings() {
  if (!state) return;
  const cfg = state.settings;
  for (const id of FIELDS) $('#' + id).value = cfg[id] !== undefined && cfg[id] !== null ? cfg[id] : '';
  for (const id of CHECKS) $('#' + id).checked = Boolean(cfg[id]);
}

function collectSettings() {
  const patch = {};
  for (const id of FIELDS) patch[id] = String($('#' + id).value).trim();
  patch.port = Number(patch.port) || 7000;
  patch.toolbarHeight = Number(patch.toolbarHeight) || 0;
  patch.dpiScale = Number(patch.dpiScale) || 0;
  patch.embedDelayMs = Number(patch.embedDelayMs) || 1500;
  for (const id of CHECKS) patch[id] = $('#' + id).checked;
  return patch;
}

function bind() {
  $('#btn-start').onclick = async () => {
    if (state.engine.running) {
      await api.stop();
      toast('接收端已停止');
    } else {
      const result = await api.start();
      if (!result.ok) toast(result.error || '启动失败');
    }
  };
  $('#btn-restart').onclick = () => { api.restart(); toast('正在重启接收端…'); };
  $('#btn-reembed').onclick = async () => { await api.reembed(); toast('已重新嵌入画面'); };
  $('#btn-fullscreen').onclick = () => api.toggleFullscreen();
  $('#btn-ontop').onclick = () => api.toggleAlwaysOnTop();
  $('#btn-toolbar').onclick = () => api.toggleToolbar();
  $('#btn-settings').onclick = () => setPanel('settings');
  $('#btn-logs').onclick = () => setPanel('logs');
  $('#btn-minimize').onclick = () => api.minimize();
  $('#btn-settings-close').onclick = () => setPanel(null);
  $('#btn-logs-close').onclick = () => setPanel(null);

  $('#btn-pick').onclick = async () => {
    const picked = await api.pickUxplay();
    if (picked) $('#uxplayPath').value = picked;
  };
  $('#btn-save').onclick = async () => {
    await api.saveSettings(collectSettings());
    setPanel(null);
    await api.restart();
    toast('设置已保存，接收端正在重启');
  };
  $('#btn-save-only').onclick = async () => {
    await api.saveSettings(collectSettings());
    setPanel(null);
    toast('设置已保存');
  };
  $('#btn-clear-logs').onclick = () => { $('#log-view').textContent = ''; };
  $('#btn-open-userdata').onclick = () => api.openUserdata();
  $('#btn-open-log').onclick = () => api.openLog();

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel) setPanel(null);
    if (event.altKey && String(event.key).toLowerCase() === 't') {
      event.preventDefault();
      api.toggleToolbar();
    }
  });
}

api.onState(render);
api.onLog(appendLog);
api.onNotice(toast);
bind();
api.getState().then(render).catch(() => toast('无法读取应用状态'));
})();
