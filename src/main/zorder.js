'use strict';
/**
 * 把窗口压到桌面之上、其它可见窗口之下。
 * 常驻一个 PowerShell，避免每次调整层级都重新启动进程。
 *
 * 已冻结。没有用户明确要求改 Win+D / 显示桌面时，不要改本文件或 zorder.ps1。
 * 约定：AGENTS.md，以及 .cursor/skills/deskgow-show-desktop/SKILL.md。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

function scriptPath() {
  const bundled = path.join(__dirname, 'ps', 'zorder.ps1');
  const unpacked = bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
  return bundled;
}

let child = null;
let ready = false;
const queue = [];
let modeListener = null;
let lastMode = '';

function onMode(fn) {
  modeListener = fn;
}

function ensure() {
  // 进程自己退出后 killed 仍是 false。只看 killed 会把死进程当成还活着，层级再也不更新。
  if (child && child.exitCode == null && !child.killed) return;
  const file = scriptPath();
  try {
    prepareScript(file);
  } catch (err) {
    console.error('[zorder] ' + (err && err.message ? err.message : err));
    return;
  }
  ready = false;
  const proc = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = proc;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!ready) {
        if (line === 'READY') {
          ready = true;
          const pending = queue.splice(0);
          for (const h of pending) write(h);
        }
        continue;
      }
      if (line !== 'DESKTOP' && line !== 'APP') continue;
      if (line === lastMode) continue;
      lastMode = line;
      if (modeListener) modeListener(line);
    }
  });
  proc.on('exit', () => {
    if (child === proc) {
      child = null;
      ready = false;
      lastMode = '';
    }
  });
}

function write(hwnd) {
  try {
    if (child && child.stdin.writable) child.stdin.write(hwnd + '\n');
  } catch (_) { /* ignore */ }
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
  return String(buf.readUInt32LE(0));
}

let timer = null;
let pendingWin = null;

const CONTRACT = [
  'SeatAboveDesktop',
  'PinToDesktop',
  'SHELLDLL_DefView',
  'HWND_NOTOPMOST',
  'guard++ < 4000',
];

/** PowerShell 5 没有 BOM 时会把中文注释读坏，辅助进程秒退。缺了就补上。 */
function prepareScript(file) {
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) {
    throw new Error('zorder.ps1 不是 UTF-8，拒绝启动');
  }
  for (const mark of CONTRACT) {
    if (!text.includes(mark)) throw new Error('zorder.ps1 缺少冻结标记 ' + mark + '，拒绝启动');
  }
  if (text.includes('AtTopOfNormalBand')) {
    throw new Error('zorder.ps1 含有已否决的 AtTopOfNormalBand，拒绝启动');
  }
  if (!hasBom) fs.writeFileSync(file, '\uFEFF' + text, 'utf8');
}

function sink(win) {
  if (!win || win.isDestroyed()) return;
  pendingWin = win;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const target = pendingWin;
    pendingWin = null;
    if (!target || target.isDestroyed()) return;
    try {
      ensure();
      const h = hwndOf(target);
      if (ready) write(h);
      else queue.push(h);
    } catch (_) { /* ignore */ }
  }, 40);
}

function stop() {
  try { if (child) child.kill(); } catch (_) { /* ignore */ }
  child = null;
  ready = false;
}

module.exports = { sink, stop, onMode };
