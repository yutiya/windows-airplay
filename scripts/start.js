'use strict';

// 启动入口：绕开宿主环境可能遗留的 Electron/Node 变量。
// 若从另一个 Electron 应用（例如 WorkBuddy）的终端里启动，环境会带
// ELECTRON_RUN_AS_NODE=1，导致 electron.exe 退化成纯 Node，
// 主进程 require('electron') 拿不到 app / BrowserWindow 而直接报错。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
let electron;
try {
  electron = require(path.join(root, 'node_modules', 'electron'));
} catch (err) {
  console.error('未找到 Electron，请先执行 npm install。');
  console.error(String(err.message || err));
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
  console.error('Electron 二进制缺失，请执行：node node_modules/electron/install.js');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(electron, ['.'], { cwd: root, env, stdio: 'inherit', windowsHide: false });
child.on('error', (err) => {
  console.error('启动 Electron 失败：' + err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code === null ? 0 : code));
