'use strict';
/**
 * DeskGlow 启动器
 *
 * 职责很简单：把 Electron 以「正常模式 / 兼容模式」拉起来，然后自己立刻退出，
 * 让调用它的控制台窗口一闪即关（真正的应用进程独立存活）。
 *
 * - 兼容模式标记保存在项目根的 .compat 文件里；
 * - 运行时若再次遇到 GPU 进程崩溃，主进程会自己写入该标记并以 --no-sandbox 重启；
 * - 所有输出写入 logs/launch.log，启动失败时可直接查看。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const compatFlag = path.join(root, '.compat');
const logDir = path.join(root, 'logs');
const logFile = path.join(logDir, 'launch.log');

function log(line) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    try {
      if (fs.statSync(logFile).size > 512 * 1024) fs.truncateSync(logFile, 0);
    } catch (_) { /* 文件不存在 */ }
    fs.appendFileSync(logFile, `[${new Date().toLocaleString()}] ${line}\r\n`);
  } catch (_) { /* 静默失败，不影响启动 */ }
}

if (!fs.existsSync(exe)) {
  log(`ERROR 未找到 Electron 运行时: ${exe}`);
  console.error('[DeskGlow] 未找到 Electron 运行时。\n请先双击运行「安装依赖.bat」。');
  process.exit(1);
}

const compat = fs.existsSync(compatFlag) || process.argv.includes('--compat');
const args = [root];
if (compat) args.push('--no-sandbox', '--disable-gpu-shader-disk-cache');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

log(`START ${exe} ${args.join(' ')} (compat=${compat})`);

let child;
try {
  child = spawn(exe, args, {
    cwd: root,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
} catch (err) {
  log('ERROR spawn 失败: ' + (err && err.stack || err));
  console.error('[DeskGlow] 启动失败: ' + (err && err.message ? err.message : err));
  process.exit(1);
}

child.on('error', (err) => {
  log('ERROR 子进程异常: ' + (err && err.stack || err));
});
child.on('exit', (code) => {
  log(`EXIT code=${code}`);
});

child.unref();
log('SPAWNED pid=' + child.pid);
process.exit(0);
