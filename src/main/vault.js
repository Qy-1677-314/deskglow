'use strict';
/**
 * DeskGlow 软件文件夹
 * 结构：
 *   %USERPROFILE%\DeskGlow\
 *     ├─ 快捷方式\    （桌面快捷方式被收进这里，Dock 从这里读取）
 *     └─ 文件收纳\    （拖进「文件合集」的文件会移动到这里）
 */
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

let ROOT = null;

function root() {
  if (ROOT) return ROOT;
  let base = '';
  try { base = app.getPath('home'); } catch (_) { /* ignore */ }
  if (!base) { try { base = app.getPath('userData'); } catch (_) { base = process.cwd(); } }
  ROOT = path.join(base, 'DeskGlow');
  return ROOT;
}

function dirs() {
  const r = root();
  return {
    root: r,
    shortcuts: path.join(r, '快捷方式'),
    archive: path.join(r, '文件收纳'),
  };
}

function ensure() {
  const d = dirs();
  for (const k of ['root', 'shortcuts', 'archive']) {
    try { fs.mkdirSync(d[k], { recursive: true }); } catch (_) { /* ignore */ }
  }
  return d;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i++;
    if (i > 999) break;
  }
  return p;
}

const SHORTCUT_EXT = new Set(['.lnk', '.url']);

function isShortcutName(name) {
  return SHORTCUT_EXT.has(path.extname(name).toLowerCase());
}

function samePath(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function explainMoveError(e) {
  const code = e && e.code;
  if (code === 'EPERM' || code === 'EACCES') return '没有权限移走';
  if (code === 'EBUSY') return '文件被占用';
  if (code === 'ENOSPC') return '磁盘空间不够';
  if (code === 'ENOENT') return '文件已经不在了';
  return '移动失败';
}

/** Windows 只读的 .lnk 删不掉，先清掉只读属性 */
function clearReadonly(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.mode & 0o200) return;
    fs.chmodSync(p, st.mode | 0o200);
  } catch (_) {}
}

function removeSource(p) {
  clearReadonly(p);
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  } catch (_) {}
  clearReadonly(p);
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 个人桌面 + 公用桌面。
 * 安装程序经常把快捷方式放到 C:\Users\Public\Desktop，资源管理器会合并显示。
 * 面板扫描两边都能读到，收进文件夹也要两边都收。
 */
function desktopRoots() {
  const out = [];
  const push = (d) => {
    if (!d || !fs.existsSync(d)) return;
    if (out.some((x) => samePath(x, d))) return;
    out.push(d);
  };
  try { push(app.getPath('desktop')); } catch (_) {}
  push(path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'));
  return out;
}

/**
 * Dirent.isFile() 不能用来判断快捷方式。
 * OneDrive「按需文件」和部分系统上的 .lnk 带重解析点，isFile() 为 false，
 * 面板用 stat 仍能列出来，于是出现「面板看得到、收不进文件夹」。
 */
function entryIsDirectory(ent, full) {
  if (ent.isDirectory()) return true;
  if (ent.isFile()) return false;
  try { return fs.statSync(full).isDirectory(); } catch (_) { return false; }
}

/** depth 0 只看这一层；1 再看下一层子文件夹。与面板扫描范围一致。 */
function collectShortcutPaths(dir, depth, skipDirs, failed) {
  const found = [];
  if (!dir || depth < 0) return found;
  if (skipDirs.some((s) => samePath(s, dir))) return found;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (failed) failed.push({ name: path.basename(dir) || dir, error: '读不到这个文件夹' });
    return found;
  }
  for (const ent of ents) {
    const name = ent.name;
    if (!name || name.startsWith('.') || name.startsWith('~$')) continue;
    if (name.toLowerCase() === 'desktop.ini') continue;
    const full = path.join(dir, name);
    if (isShortcutName(name) && !entryIsDirectory(ent, full)) {
      found.push(full);
      continue;
    }
    if (depth > 0 && entryIsDirectory(ent, full)) {
      found.push(...collectShortcutPaths(full, depth - 1, skipDirs, failed));
    }
  }
  return found;
}

/** 把 src 移动进 dir，返回新路径（跨盘或云盘占位时复制后删除） */
function moveInto(dir, src) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const dest = uniquePath(dir, path.basename(src));
  clearReadonly(src);
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch (_) { /* 跨盘、占用、云盘占位 */ }
  // .lnk / .url 永远按文件搬。lstat 跟着重解析点走时，不能把快捷方式当成目录复制。
  let isDir = false;
  if (!isShortcutName(path.basename(src))) {
    try { isDir = fs.lstatSync(src).isDirectory(); } catch (_) {}
  }
  try {
    if (isDir) fs.cpSync(src, dest, { recursive: true });
    else fs.copyFileSync(src, dest);
    removeSource(src);
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
  return dest;
}

/**
 * 把桌面上的 .lnk / .url 收进「快捷方式」文件夹。
 * opts.roots / opts.target / opts.depth 只给自检用，平时不传。
 */
function importDesktopShortcuts(opts = {}) {
  const d = ensure();
  const target = opts.target || d.shortcuts;
  try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  const skip = [d.root, d.shortcuts, d.archive, target];
  const roots = opts.roots && opts.roots.length ? opts.roots : desktopRoots();
  const depth = Number.isInteger(opts.depth) ? opts.depth : 1;
  const failed = [];
  const sources = [];
  const seen = new Set();
  for (const root of roots) {
    for (const src of collectShortcutPaths(root, depth, skip, failed)) {
      const k = src.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      if (samePath(path.dirname(src), target)) continue;
      const low = src.toLowerCase();
      const inTarget = low === target.toLowerCase() || low.startsWith(target.toLowerCase() + path.sep);
      if (inTarget) continue;
      sources.push(src);
    }
  }
  let moved = 0;
  const details = [];
  for (const src of sources) {
    try {
      const dest = moveInto(target, src);
      details.push({ from: src, to: dest });
      moved++;
    } catch (e) {
      failed.push({ name: path.basename(src), error: explainMoveError(e) });
    }
  }
  return { moved, details, failed };
}

/**
 * 把桌面上的普通文件 / 文件夹收进「文件收纳」
 * 快捷方式（.lnk/.url）不在这里处理，它们归「快捷方式」文件夹
 */
function importDesktopFiles(opts = {}) {
  const includeFolders = opts.includeFolders !== false;
  const filter = typeof opts.filter === 'function' ? opts.filter : null;
  ensure();
  const target = dirs().archive;
  const moved = [];
  const skipped = [];
  let desk = '';
  try { desk = app.getPath('desktop'); } catch (_) {}
  if (!desk || !fs.existsSync(desk)) return { moved: 0, names: [], skipped };

  let ents = [];
  try { ents = fs.readdirSync(desk, { withFileTypes: true }); } catch (_) { return { moved: 0, names: [], skipped }; }
  for (const ent of ents) {
    const name = ent.name;
    if (!name || name.startsWith('.') || name.startsWith('~$')) continue;
    if (name.toLowerCase() === 'desktop.ini') continue;
    const src = path.join(desk, name);
    const ext = path.extname(name).toLowerCase();
    if (ext === '.lnk' || ext === '.url') continue;                    // 快捷方式归另一个文件夹
    if (ent.isDirectory() && !includeFolders) continue;                // 尊重「收纳文件夹」开关
    if (ent.isDirectory() && name === 'DeskGlow') continue;
    if (filter && !filter(name, src)) continue;
    try {
      moveInto(target, src);
      moved.push(name);
    } catch (_) {
      skipped.push(name);
    }
  }
  return { moved: moved.length, names: moved, skipped };
}

/** 桌面根目录下还有多少「非快捷方式」的文件可以直接收进来 */
function countDesktopFiles() {
  let desk = '';
  try { desk = app.getPath('desktop'); } catch (_) { return 0; }
  if (!desk || !fs.existsSync(desk)) return 0;
  let ents = [];
  try { ents = fs.readdirSync(desk, { withFileTypes: true }); } catch (_) { return 0; }
  let n = 0;
  for (const ent of ents) {
    const name = ent.name;
    if (!name || name.startsWith('.') || name.startsWith('~$')) continue;
    if (name.toLowerCase() === 'desktop.ini') continue;
    const ext = path.extname(name).toLowerCase();
    if (ext === '.lnk' || ext === '.url') continue;
    n++;
  }
  return n;
}

/** 列出目录下的条目（不含隐藏/临时文件） */
function listDir(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents) {
    const name = ent.name;
    if (!name || name.startsWith('.') || name.toLowerCase() === 'desktop.ini') continue;
    if (name.startsWith('~$')) continue;
    const full = path.join(dir, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch (_) {}
    if (!stat) continue;
    const ext = path.extname(name).toLowerCase();
    out.push({
      path: full,
      name: ent.isDirectory() ? name : path.basename(name, ext),
      fileName: name,
      ext,
      dir,
      isDir: stat.isDirectory(),
      isShortcut: !stat.isDirectory() && (ext === '.lnk' || ext === '.url'),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  return out;
}

function open(which = 'root') {
  const d = dirs();
  ensure();
  const p = d[which] || d.root;
  return shell.openPath(p);
}

module.exports = {
  root, dirs, ensure, moveInto, uniquePath, explainMoveError, importDesktopShortcuts,
  importDesktopFiles, countDesktopFiles, listDir, open,
};
