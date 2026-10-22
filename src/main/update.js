'use strict';
/**
 * 离线更新包。用户选一个 .dgupdate，核对清单和哈希后，
 * 等本进程退出，再把 resources 覆盖到安装目录并重新打开。
 * 不改用户数据目录。
 */
const { app, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function box(parent, opts) {
  if (parent && !parent.isDestroyed()) return dialog.showMessageBox(parent, opts);
  return dialog.showMessageBox(opts);
}

function parseVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVersion(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  }
  return 0;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** 只允许换 asar 和拆出来的脚本，避免更新包改到别的位置。 */
function safeRel(p) {
  const norm = String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!norm || norm.includes(':')) return null;
  const parts = norm.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return null;
  if (norm !== 'resources/app.asar' && !norm.startsWith('resources/app.asar.unpacked/')) return null;
  return norm;
}

function listZip(zip) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(TAR, ['-tf', zip], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const names = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const norm = name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || norm.endsWith('/')) continue;
    if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
      throw new Error('更新包里有不允许的路径：' + name);
    }
  }
  return names;
}

function findManifest(root) {
  const direct = path.join(root, 'manifest.json');
  if (fs.existsSync(direct)) return { file: direct, base: root };
  for (const name of fs.readdirSync(root)) {
    const base = path.join(root, name);
    try {
      if (!fs.statSync(base).isDirectory()) continue;
    } catch (_) { continue; }
    const nested = path.join(base, 'manifest.json');
    if (fs.existsSync(nested)) return { file: nested, base };
  }
  return null;
}

function writeBom(file, text) {
  const body = String(text).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(body, 'utf8'),
  ]));
}

function applyScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$root = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$raw = Get-Content -LiteralPath (Join-Path $root 'meta.json') -Raw -Encoding UTF8",
    "$raw = $raw.TrimStart([char]0xFEFF)",
    "$meta = $raw | ConvertFrom-Json",
    "$log = Join-Path $env:TEMP 'DeskGlow-update.log'",
    "function Log([string]$m) {",
    "  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m",
    "  Add-Content -LiteralPath $log -Value $line -Encoding UTF8",
    "}",
    "Log 'start'",
    "$targetPid = [int]$meta.pid",
    "$deadline = (Get-Date).AddSeconds(45)",
    "while ($true) {",
    "  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue",
    "  if (-not $proc) { break }",
    "  if ((Get-Date) -gt $deadline) {",
    "    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue",
    "    Start-Sleep -Milliseconds 600",
    "    break",
    "  }",
    "  Start-Sleep -Milliseconds 200",
    "}",
    "Start-Sleep -Milliseconds 400",
    "$srcRes = Join-Path $root 'payload\\resources'",
    "$destRes = Join-Path $meta.dest 'resources'",
    "$ok = $false",
    "$errText = ''",
    "for ($i = 0; $i -lt 40; $i++) {",
    "  try {",
    "    if (-not (Test-Path -LiteralPath $destRes)) {",
    "      New-Item -ItemType Directory -Force -Path $destRes | Out-Null",
    "    }",
    "    Copy-Item -LiteralPath (Join-Path $srcRes 'app.asar') -Destination (Join-Path $destRes 'app.asar') -Force",
    "    $unpackedSrc = Join-Path $srcRes 'app.asar.unpacked'",
    "    $unpackedDst = Join-Path $destRes 'app.asar.unpacked'",
    "    if (Test-Path -LiteralPath $unpackedDst) {",
    "      Remove-Item -LiteralPath $unpackedDst -Recurse -Force",
    "    }",
    "    if (Test-Path -LiteralPath $unpackedSrc) {",
    "      Copy-Item -LiteralPath $unpackedSrc -Destination $unpackedDst -Recurse -Force",
    "    }",
    "    $ok = $true",
    "    break",
    "  } catch {",
    "    $errText = $_.Exception.Message",
    "    Log $errText",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "}",
    "Add-Type -AssemblyName System.Windows.Forms",
    "if (-not $ok) {",
    "  Log 'failed'",
    "  [System.Windows.Forms.MessageBox]::Show(\"更新没有写完，将重新打开原来的版本。`n$errText`n详情：$env:TEMP\\DeskGlow-update.log\", 'DeskGlow') | Out-Null",
    "  Start-Process -FilePath $meta.exe",
    "  exit 1",
    "}",
    "Log 'copied'",
    "Start-Process -FilePath $meta.exe",
    "Log 'relaunched'",
  ].join('\n');
}

async function applyFromDialog(parent) {
  let tmp = null;
  let keep = false;
  try {
    if (!app.isPackaged) {
      await box(parent, {
        type: 'info',
        title: '安装更新包',
        message: '开发目录里不能套用更新包',
        detail: '更新包只覆盖已经安装的 DeskGlow。请先运行安装包，再在安装后的程序里选择 .dgupdate。改源码直接保存即可。',
      });
      return { ok: false, reason: 'dev' };
    }

    const installRoot = path.dirname(process.execPath);
    const installedAsar = path.join(installRoot, 'resources', 'app.asar');
    if (!fs.existsSync(installedAsar)) {
      throw new Error('安装目录里没有 resources\\app.asar。');
    }

    const picked = await dialog.showOpenDialog(parent && !parent.isDestroyed() ? parent : undefined, {
      title: '选择 DeskGlow 更新包',
      filters: [{ name: 'DeskGlow 更新包', extensions: ['dgupdate', 'zip'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: 'cancel' };

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgupdate-'));
    const zip = path.join(tmp, 'update.zip');
    fs.copyFileSync(picked.filePaths[0], zip);
    listZip(zip);
    const extracted = path.join(tmp, 'out');
    fs.mkdirSync(extracted);
    const { execFileSync } = require('child_process');
    execFileSync(TAR, ['-xf', zip, '-C', extracted], { windowsHide: true });

    const found = findManifest(extracted);
    if (!found) throw new Error('这不是 DeskGlow 更新包（没有 manifest.json）。');
    const manifest = JSON.parse(fs.readFileSync(found.file, 'utf8').replace(/^\uFEFF/, ''));
    if (!manifest || manifest.product !== 'deskglow' || !Array.isArray(manifest.files)) {
      throw new Error('更新包清单无法识别。');
    }

    const current = app.getVersion();
    const next = String(manifest.version || '');
    const order = cmpVersion(next, current);
    if (!next || order < 0) {
      await box(parent, {
        type: 'info',
        title: '安装更新包',
        message: '这个更新包比当前版本旧',
        detail: '当前是 ' + current + '，更新包是 ' + (next || '未知') + '。没有改任何文件。',
      });
      return { ok: false, reason: 'older' };
    }

    const staged = path.join(tmp, 'payload');
    fs.mkdirSync(path.join(staged, 'resources'), { recursive: true });
    let sawAsar = false;
    for (const entry of manifest.files) {
      const rel = safeRel(entry && entry.path);
      if (!rel) throw new Error('更新包包含不允许的文件：' + (entry && entry.path));
      const from = path.join(found.base, ...rel.split('/'));
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
        throw new Error('更新包缺少文件：' + rel);
      }
      const digest = sha256(from);
      const expect = String(entry.sha256 || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expect) || digest !== expect) {
        throw new Error('文件校验不一致：' + rel);
      }
      const dest = path.join(staged, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(from, dest);
      if (rel === 'resources/app.asar') sawAsar = true;
    }
    if (!sawAsar) throw new Error('更新包里没有 resources/app.asar。');

    const ask = await box(parent, {
      type: 'question',
      buttons: ['安装并重启', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '安装更新包',
      message: order > 0
        ? ('将从 ' + current + ' 更新到 ' + next)
        : ('更新包也是 ' + current + '，要覆盖安装吗？'),
      detail: '只替换程序文件。配置、图标缓存和任务栏备份都留在原来的目录。程序会关掉再自己打开。',
    });
    if (ask.response !== 0) return { ok: false, reason: 'cancel' };

    const meta = {
      pid: process.pid,
      dest: installRoot,
      exe: process.execPath,
    };
    writeBom(path.join(tmp, 'meta.json'), JSON.stringify(meta));
    writeBom(path.join(tmp, 'apply.ps1'), applyScript());

    const child = spawn(PS_EXE, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tmp, 'apply.ps1'),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    keep = true;
    setTimeout(() => {
      app.isQuiting = true;
      app.quit();
    }, 400);
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await box(parent, {
      type: 'error',
      title: '安装更新包',
      message: '更新包没有装上',
      detail: message,
    });
    return { ok: false, message };
  } finally {
    if (tmp && !keep) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 临时目录留着也没关系 */ }
    }
  }
}

module.exports = { applyFromDialog };
