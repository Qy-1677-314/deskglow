'use strict';
/**
 * PowerShell 调用封装。所有脚本通过文件交换 JSON（避免中文编码问题）。
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PS_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

const PS_DIR = path.join(__dirname, 'ps');

/** 打包成 exe 后脚本在 app.asar.unpacked 里，PowerShell 读不到 asar 内部文件 */
function scriptFile(scriptName) {
  const bundled = path.join(PS_DIR, scriptName);
  const unpacked = bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
  return bundled;
}

function runScript(scriptName, args = [], { timeout = 180000 } = {}) {
  const scriptPath = scriptFile(scriptName);
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: String(stderr || err.message || err).slice(0, 800), stdout: stdout || '' });
          return;
        }
        resolve({ ok: true, stdout: (stdout || '').trim(), stderr: stderr || '' });
      }
    );
  });
}

async function runJson(scriptName, args = [], opts) {
  const r = await runScript(scriptName, args, opts);
  if (!r.ok) return { ok: false, error: r.error };
  const raw = r.stdout;
  if (!raw) return { ok: false, error: 'empty output' };
  try {
    const line = raw.split(/\r?\n/).filter(Boolean).pop();
    return { ok: true, data: JSON.parse(line) };
  } catch (e) {
    return { ok: false, error: 'bad json: ' + raw.slice(0, 300) };
  }
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `dg-${process.pid}-${Date.now()}-${name}`);
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

module.exports = { runScript, runJson, tmpFile, readJsonFile, PS_DIR };
