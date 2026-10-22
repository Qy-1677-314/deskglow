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

/** 把 src 移动进 dir，返回新路径（跨盘时复制后删除） */
function moveInto(dir, src) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const dest = uniquePath(dir, path.basename(src));
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch (_) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }
    return dest;
  }
}

/** 把桌面上的 .lnk / .url 收进「快捷方式」文件夹 */
function importDesktopShortcuts() {
  ensure();
  const target = dirs().shortcuts;
  let moved = 0;
  const details = [];
  let desk = '';
  try { desk = app.getPath('desktop'); } catch (_) {}
  if (desk && fs.existsSync(desk)) {
    let ents = [];
    try { ents = fs.readdirSync(desk, { withFileTypes: true }); } catch (_) {}
    for (const ent of ents) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (ext !== '.lnk' && ext !== '.url') continue;
      const src = path.join(desk, ent.name);
      try {
        const dest = moveInto(target, src);
        details.push({ from: src, to: dest });
        moved++;
      } catch (_) { /* ignore */ }
    }
  }
  return { moved, details };
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
  root, dirs, ensure, moveInto, uniquePath, importDesktopShortcuts,
  importDesktopFiles, countDesktopFiles, listDir, open,
};
