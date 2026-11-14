'use strict';

// 冒烟测试：短暂启动 AirPlay 引擎，确认它持续运行、没有非法指令崩溃，
// 并用 mDNS 查询验证 _airplay._tcp 服务已注册（等价于「iPhone 能搜到」）。
// 运行：
//   node scripts/smoke-test.js          测默认 Qt 便携引擎
//   node scripts/smoke-test.js --cli   测命令行引擎（需 AVX2 CPU）

const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const useCli = process.argv.includes('--cli');
const exe = useCli
  ? path.join(root, 'runtime', 'bin', 'uxplay.exe')
  : path.join(root, 'runtime', 'qt', 'uxplay-windows.exe');
const pluginDir = useCli
  ? path.join(root, 'runtime', 'lib', 'gstreamer-1.0')
  : path.join(root, 'runtime', 'qt', 'lib', 'gstreamer-1.0');
const argsFile = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'leapbtw', 'uxplay-windows', 'arguments.txt'
);

if (!fs.existsSync(exe)) {
  console.error('未找到引擎：' + exe);
  console.error('请先执行 scripts/prepare-runtime.ps1。');
  process.exit(1);
}

const env = { ...process.env };
env.PATH = path.dirname(exe) + path.delimiter + (env.PATH || '');
if (fs.existsSync(pluginDir)) env.GST_PLUGIN_PATH = pluginDir;

const cliArgs = [
  '-n', 'FreeCastSmokeTest', '-nh', '-p', '47000', '-s', '1280x720',
  '-vs', 'd3d11videosink', '-as', 'wasapisink', '-nc'
];
const qtArgsText = '-n FreeCastSmokeTest -nh -p 47000 -s 1280x720 -vs d3d11videosink -nc';

let argsBackup = null;
if (!useCli) {
  if (fs.existsSync(argsFile)) argsBackup = fs.readFileSync(argsFile, 'utf8');
  fs.mkdirSync(path.dirname(argsFile), { recursive: true });
  fs.writeFileSync(argsFile, qtArgsText, 'utf8');
}

// 先清掉可能残留的同名实例，避免 Qt 引擎的单实例锁让测试进程立刻退出
try {
  spawn('taskkill', ['/IM', useCli ? 'uxplay.exe' : 'uxplay-windows.exe', '/F'],
    { windowsHide: true, stdio: 'ignore' });
} catch (_) { /* 无残留 */ }

function dnsName(name) {
  const parts = name.split('.').filter(Boolean).map((p) =>
    Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'ascii')]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

const queryHeader = Buffer.alloc(12);
queryHeader.writeUInt16BE(1, 4); // QDCOUNT = 1
const qtail = Buffer.alloc(4);
qtail.writeUInt16BE(12, 0); // PTR
qtail.writeUInt16BE(1, 2);  // IN
const query = Buffer.concat([queryHeader, dnsName('_airplay._tcp.local.'), qtail]);

let mdnsHit = false;
let mdnsError = '';
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('error', (err) => { mdnsError = err.code || err.message; });
sock.on('message', (msg) => {
  if (msg.includes(Buffer.from('deviceid=')) || msg.includes(Buffer.from('model=AppleTV'))) mdnsHit = true;
});
sock.bind(5353, () => {
  try {
    sock.addMembership('224.0.0.251');
    sock.setMulticastTTL(255);
  } catch (err) { mdnsError = err.message; }
});
const mdnsTimer = setInterval(() => {
  try { sock.send(query, 5353, '224.0.0.251'); } catch (_) { /* 忽略 */ }
}, 900);

console.log('引擎：' + exe);
console.log(useCli ? '参数：' + cliArgs.join(' ') : '配置：' + qtArgsText);
console.log('采集 9 秒（含 mDNS 探测）…\n');

setTimeout(() => {
  const child = spawn(exe, useCli ? cliArgs : [], {
    cwd: path.dirname(exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const collect = (chunk) => { output += chunk.toString('utf8'); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (err) => { output += '[错误] ' + err.message + '\n'; });

  setTimeout(() => {
    clearInterval(mdnsTimer);
    try { sock.close(); } catch (_) { /* 已关闭 */ }

    console.log('--- 引擎输出 ---');
    console.log(output.trim() || '（无终端输出；Qt 引擎为 GUI 程序，属正常）');
    console.log('--- 判断 ---');

    const alive = child.exitCode === null;
    const illegal = child.exitCode === 3221225501 || child.exitCode === -1073741795;
    console.log('引擎持续运行：' + (alive ? '是' : '否，退出码 ' + child.exitCode + (illegal ? ' (0xC000001D)' : '')));
    console.log('AirPlay 服务注册：' + (mdnsHit ? '已检测到 _airplay._tcp 应答' : '未检测到' + (mdnsError ? '（' + mdnsError + '）' : '')));

    const problems = [];
    if (!alive) problems.push('引擎提前退出');
    if (illegal) problems.push('STATUS_ILLEGAL_INSTRUCTION：该二进制需要 AVX2/BMI，本机 CPU 不支持，请在设置里切回 Qt 便携版');
    if (/failed to load plugin|no such element|plugin.*not found/i.test(output)) problems.push('GStreamer 插件加载失败');

    if (problems.length) {
      for (const item of problems) console.log('  [可疑] ' + item);
    } else {
      console.log('  引擎启动正常' + (mdnsHit ? '，局域网内可被 iPhone 发现' : ''));
    }
    console.log('\n提示：本测试不传输真实画面；投屏画面/声音/窗口嵌入需 iPhone 实际操作验证。');

    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {
      try { child.kill(); } catch (_) { /* 已退出 */ }
    }
    if (argsBackup !== null) {
      fs.writeFileSync(argsFile, argsBackup, 'utf8');
    }
    setTimeout(() => process.exit(problems.length ? 1 : 0), 400);
  }, 9000);
}, 1200);
