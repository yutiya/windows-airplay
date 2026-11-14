'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function projectRoot() {
  return path.join(__dirname, '..', '..');
}

function firstExisting(list) {
  for (const item of list) {
    if (item && fs.existsSync(item)) return item;
  }
  return null;
}

// uxplay-windows 2.0 从 %APPDATA%\leapbtw\uxplay-windows\arguments.txt 读取 UxPlay 参数
function qtArgumentsFile() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'leapbtw', 'uxplay-windows', 'arguments.txt');
}

function resolveExecutable(cfg = {}) {
  const custom = String(cfg.uxplayPath || '').trim();
  if (custom) return fs.existsSync(custom) ? custom : null;

  const root = projectRoot();
  const qt = firstExisting([
    path.join(root, 'runtime', 'qt', 'uxplay-windows.exe'),
    path.join(root, 'runtime', 'uxplay-windows.exe')
  ]);
  const cli = firstExisting([
    path.join(root, 'runtime', 'bin', 'uxplay.exe'),
    path.join(root, 'runtime', 'uxplay.exe')
  ]);
  if (!cli) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const item = path.join(dir, 'uxplay.exe');
      if (fs.existsSync(item)) return item;
    }
  }

  const preferred = cfg.engineType === 'cli' ? cli : qt;
  return preferred || cli || qt || null;
}

function engineKind(exe) {
  return /uxplay-windows\.exe$/i.test(exe || '') ? 'qt' : 'cli';
}

// 把用户填的额外参数拆成 argv，支持单双引号包裹含空格的参数
function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return out;
}

// 命令行引擎：直接拼 argv
function buildArgs(cfg, kind) {
  if (kind === 'qt') return [];
  const args = [
    '-n', String(cfg.serverName || '免费投屏'),
    '-p', String(cfg.port || 7000),
    '-s', String(cfg.resolution || '1920x1080'),
    '-vs', String(cfg.videoSink || 'd3d11videosink'),
    '-as', String(cfg.audioSink || 'wasapisink')
  ];
  // 不加 -pin / -pw：自用场景免得每次连接都要在 iPhone 上输 PIN
  if (cfg.noHostnameSuffix) args.push('-nh');
  if (cfg.keepWindow) args.push('-nc');
  const extra = String(cfg.extraArgs || '').trim();
  if (extra) args.push(...tokenize(extra));
  return args;
}

// Qt 引擎：参数写入 arguments.txt（实测命令行传参会触发单实例/解析问题）
// 注意：该便携包只有 libgstwasapi2.dll，传 -as wasapisink 会让引擎崩溃，因此不指定 -as。
function buildQtArguments(cfg) {
  const parts = [
    '-n', String(cfg.serverName || '免费投屏'),
    '-nh',
    '-p', String(cfg.port || 7000),
    '-s', String(cfg.resolution || '1920x1080'),
    '-vs', String(cfg.videoSink || 'd3d11videosink')
  ];
  if (cfg.keepWindow) parts.push('-nc');
  const extra = String(cfg.extraArgs || '').trim();
  if (extra) parts.push(...tokenize(extra));
  return parts;
}

function writeQtArguments(cfg) {
  const file = qtArgumentsFile();
  const content = buildQtArguments(cfg).join(' ');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { file, content };
}

// GStreamer 的插件与 DLL 常和 exe 不在同一层，补齐环境变量
function buildEnv(exe) {
  const base = path.dirname(exe);
  const env = { ...process.env };
  const pluginCandidates = [
    path.join(base, 'lib', 'gstreamer-1.0'),
    path.join(base, 'gstreamer-1.0'),
    path.join(path.dirname(base), 'lib', 'gstreamer-1.0')
  ];
  const plugins = pluginCandidates.find((item) => fs.existsSync(item));
  if (plugins) env.GST_PLUGIN_PATH = plugins;
  const extraPath = [base, path.join(base, 'bin'), path.join(base, 'lib')].filter((item) => fs.existsSync(item));
  if (extraPath.length) env.PATH = [...extraPath, env.PATH || ''].join(path.delimiter);
  return env;
}

class UxPlayEngine extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.config = null;
    this.logs = [];
    this.state = 'stopped'; // stopped | starting | waiting | streaming | error
    this.lastError = '';
    this._intentionalStop = false;
    this._restarts = 0;
    this._startedAt = 0;
  }

  get pid() {
    return this.child ? this.child.pid : null;
  }

  get running() {
    return this.child !== null;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  start(cfg) {
    if (this.child) return { ok: true, already: true };
    this.config = { ...cfg };
    const exe = resolveExecutable(cfg);
    if (!exe) {
      this.lastError = '未找到 AirPlay 引擎，请在「设置」里指定路径，或先准备 runtime/ 目录。';
      this.setState('error');
      this.emit('log', `[错误] ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }

    const kind = engineKind(exe);
    const args = buildArgs(cfg, kind);
    this._intentionalStop = false;
    this._startedAt = Date.now();
    this.setState('starting');
    this.emit('log', `[引擎] ${kind === 'qt' ? 'Qt 便携版' : '命令行版'}：${exe}`);

    if (kind === 'qt') {
      try {
        const written = writeQtArguments(cfg);
        this.emit('log', `[配置] ${written.file}`);
        this.emit('log', `[配置] ${written.content}`);
        this.emit('log', '[配置] Qt 引擎使用自带音频输出（未指定 -as）');
      } catch (err) {
        this.lastError = '无法写入引擎配置文件：' + String(err.message || err);
        this.setState('error');
        this.emit('log', '[错误] ' + this.lastError);
        return { ok: false, error: this.lastError };
      }
    } else {
      this.emit('log', `[启动] ${args.join(' ')}`);
    }

    try {
      this.child = spawn(exe, args, {
        cwd: path.dirname(exe),
        env: buildEnv(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      this.lastError = String(err.message || err);
      this.setState('error');
      this.emit('log', `[错误] 无法启动引擎：${this.lastError}`);
      return { ok: false, error: this.lastError };
    }

    const child = this.child;
    this._pipe(child.stdout);
    this._pipe(child.stderr);

    child.on('error', (err) => {
      this.lastError = String(err.message || err);
      this.setState('error');
      this.emit('log', `[错误] ${this.lastError}`);
    });

    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.emit('log', `[退出] 引擎退出，代码 ${code}`);
      this.setState('stopped');
      this.emit('exit', { code });

      // 0xC000001D：预编译命令行二进制用了本机 CPU 不支持的指令集
      if (code === 3221225501 || code === -1073741795) {
        this._intentionalStop = true;
        this.lastError = '引擎以「非法指令」退出：该命令行版二进制需要 AVX2/BMI 指令集，本机 CPU 不支持。请在「设置 → AirPlay 引擎」切回 Qt 便携版。';
        this.setState('error');
        this.emit('log', '[错误] ' + this.lastError);
        return;
      }

      if (this._intentionalStop || !this.config || this.config.autoRestart === false) return;
      if (Date.now() - this._startedAt > 10000) this._restarts = 0;
      if (this._restarts >= 5) {
        this.lastError = '引擎反复退出，已停止自动重启，请查看日志或检查运行时依赖。';
        this.setState('error');
        this.emit('log', `[错误] ${this.lastError}`);
        return;
      }
      this._restarts += 1;
      this.emit('log', `[守护] 1.5 秒后第 ${this._restarts} 次自动重启`);
      setTimeout(() => {
        if (!this._intentionalStop && !this.child) this.start(this.config);
      }, 1500);
    });

    // 引擎起来后进入等待连接状态；真正「投屏中」由视频窗口出现来判定
    setTimeout(() => {
      if (this.child === child && this.state === 'starting') {
        this.setState('waiting');
        if (kind === 'qt') {
          this.emit('log', '[就绪] AirPlay 服务已启动，请在 iPhone 控制中心 → 屏幕镜像里选择接收端');
        }
      }
    }, 1600);

    return { ok: true, exe, args, kind };
  }

  _pipe(stream) {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) this._onLine(line);
    });
    stream.on('end', () => {
      if (buffer.trim()) this._onLine(buffer);
    });
  }

  _onLine(raw) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!line.trim()) return;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', line);

    const lower = line.toLowerCase();
    // GStreamer 真正开始推流的信号：此时视频窗口已完成创建，适合校正嵌入
    if (/begin streaming to gstreamer video pipeline|starting video pipeline/i.test(lower)) {
      this.emit('pipeline-ready', line);
    }
    if (/connection from|client connected|accepted connection|new client|connected from|start mirroring/i.test(lower)) {
      this.emit('client-hint', 'connected');
    } else if (/disconnected|connection closed|client disconnected|teardown|stopped mirroring/i.test(lower)) {
      this.emit('client-hint', 'disconnected');
    }
    if (/gstreamer|error:|failed to|cannot|unable to|not found/i.test(lower)) {
      this.emit('problem', line);
    }
  }

  stop() {
    this._intentionalStop = true;
    if (!this.child) {
      this.setState('stopped');
      return;
    }
    const child = this.child;
    this.child = null;
    this.emit('log', '[停止] 正在结束 AirPlay 引擎');
    try {
      // Windows 上连带结束子进程树，避免残留
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {
      try { child.kill(); } catch (_) { /* 已退出 */ }
    }
    this.setState('stopped');
  }

  restart(cfg) {
    this.stop();
    // Qt 引擎有单实例锁，等旧进程完全释放端口再启动
    setTimeout(() => this.start(cfg), 1600);
  }
}

module.exports = {
  UxPlayEngine, resolveExecutable, buildArgs, buildQtArguments,
  qtArgumentsFile, engineKind, tokenize
};
