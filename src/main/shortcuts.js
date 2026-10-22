'use strict';
/**
 * 桌面扫描 / 快捷方式解析 / 图标提取与缓存
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, shell } = require('electron');
const ps = require('./ps');
const vault = require('./vault');

let ICON_DIR = null;
const memIcon = new Map(); // filename -> dataURL

function iconDir() {
  if (!ICON_DIR) {
    ICON_DIR = path.join(app.getPath('userData'), 'icons');
    fs.mkdirSync(ICON_DIR, { recursive: true });
  }
  return ICON_DIR;
}

function desktopDirs() {
  const dirs = [];
  try {
    const d = app.getPath('desktop');
    if (d) dirs.push(d);
  } catch {}
  const pub = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
  try {
    if (fs.existsSync(pub) && !dirs.some((x) => x.toLowerCase() === pub.toLowerCase())) dirs.push(pub);
  } catch {}
  return dirs;
}

const SHORTCUT_EXT = new Set(['.lnk', '.url']);

/** 读取单个目录下的条目（不含隐藏 / 临时文件） */
function scanDir(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents) {
    const name = ent.name;
    if (!name || name.toLowerCase() === 'desktop.ini' || name.startsWith('.')) continue;
    if (name.startsWith('~$')) continue; // Office 临时文件
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
      isShortcut: !stat.isDirectory() && SHORTCUT_EXT.has(ext),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  return out;
}

/**
 * 扫描桌面所有条目。
 * 来源：桌面根目录（全部）+ 桌面子文件夹中的快捷方式 + DeskGlow\快捷方式
 * 这样把快捷方式放进桌面子文件夹后，Dock 依然认得出它们。
 */
function scanDesktop() {
  const out = [];
  const seen = new Set();

  const push = (e) => {
    const k = e.path.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  const roots = desktopDirs();
  for (const dir of roots) {
    for (const e of scanDir(dir)) push(e);
  }

  // 桌面子文件夹（一层）里的快捷方式
  for (const dir of roots) {
    let subs = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch (_) { continue; }
    for (const s of subs) {
      for (const e of scanDir(path.join(dir, s.name))) {
        if (e.isShortcut) push(e);
      }
    }
  }

  // DeskGlow 自带的快捷方式文件夹
  const vd = vault.dirs();
  for (const e of scanDir(vd.shortcuts)) {
    if (e.isShortcut) push(e);
  }

  // DeskGlow\文件收纳：桌面文件夹被整体收进来时，里面可能还藏着快捷方式，
  // 这里递归两层把它们也纳入索引，保证 Dock 路径能自愈。
  const walkShortcuts = (dir, depth) => {
    if (depth < 0) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const hit = ents.filter((s) => !s.isDirectory() && /\.(lnk|url)$/i.test(s.name));
    if (hit.length) {
      const want = new Set(hit.map((f) => path.join(dir, f.name).toLowerCase()));
      for (const e of scanDir(dir)) if (want.has(e.path.toLowerCase())) push(e);
    }
    for (const s of ents) {
      if (s.isDirectory() && !s.name.startsWith('.')) walkShortcuts(path.join(dir, s.name), depth - 1);
    }
  };
  walkShortcuts(vd.archive, 2);

  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

const CATEGORY = {
  doc: ['.doc', '.docx', '.docm', '.rtf', '.odt', '.wps', '.pages', '.pdf'],
  sheet: ['.xls', '.xlsx', '.xlsm', '.csv', '.et', '.numbers'],
  slide: ['.ppt', '.pptx', '.pps', '.ppsx', '.key', '.dps'],
  text: ['.txt', '.md', '.log', '.ini', '.json', '.xml', '.html', '.htm'],
};

function categoryOf(entry) {
  if (entry.isDir) return 'folder';
  const ext = entry.ext.toLowerCase();
  for (const [k, list] of Object.entries(CATEGORY)) if (list.includes(ext)) return k;
  return 'other';
}

/** 解析快捷方式（批量，单次 PowerShell） */
async function inspect(paths) {
  if (!paths.length) return [];
  const payload = ps.tmpFile('inspect-in.json');
  const out = ps.tmpFile('inspect-out.json');
  try {
    fs.writeFileSync(payload, JSON.stringify(paths.map((p) => ({ path: p }))), 'utf8');
    const r = await ps.runScript('inspect.ps1', ['-Payload', payload, '-Out', out]);
    let data = ps.readJsonFile(out);
    if (data == null) return [];
    if (!Array.isArray(data)) data = [data];
    return data;
  } finally {
    try { fs.unlinkSync(payload); } catch {}
    try { fs.unlinkSync(out); } catch {}
  }
}

function cacheName(file, index) {
  const key = `${String(file).toLowerCase()}#${index || 0}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 24) + '.png';
}

function hasCached(file, index) {
  try { return fs.existsSync(path.join(iconDir(), cacheName(file, index))); } catch { return false; }
}

/**
 * 批量提取图标。
 * jobs: [{ id, file, index, alts:[{file,index}], shell }]
 * 返回 { id: 'xx.png' }
 */
async function extractIcons(jobs) {
  if (!jobs.length) return {};
  const payload = ps.tmpFile('icon-in.json');
  const out = ps.tmpFile('icon-out.json');
  const map = {};
  try {
    fs.writeFileSync(payload, JSON.stringify(jobs), 'utf8');
    await ps.runScript('icon-extract.ps1', ['-Payload', payload, '-Out', out, '-Size', '128'], { timeout: 120000 });
    const data = ps.readJsonFile(out) || {};
    for (const [id, b64] of Object.entries(data)) {
      if (!b64) continue;
      const job = jobs.find((j) => j.id === id);
      if (!job) continue;
      // 缓存键始终以「条目自身路径」为准，保证查找与写入一致
      const fname = job.key ? cacheName(job.key, 0) : cacheName(job.file, job.index);
      try {
        fs.writeFileSync(path.join(iconDir(), fname), Buffer.from(b64, 'base64'));
        map[id] = fname;
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.warn('[icons] extract failed', e.message);
  } finally {
    try { fs.unlinkSync(payload); } catch {}
    try { fs.unlinkSync(out); } catch {}
  }
  return map;
}

function iconDataUrl(fname) {
  if (!fname) return null;
  if (memIcon.has(fname)) return memIcon.get(fname);
  try {
    const buf = fs.readFileSync(path.join(iconDir(), fname));
    const url = 'data:image/png;base64,' + buf.toString('base64');
    memIcon.set(fname, url);
    return url;
  } catch { return null; }
}

/** 由 inspect 结果构造图标任务 */
function buildJob(id, entry, info) {
  const file = (info && info.iconFile) || '';
  const index = (info && Number(info.iconIndex)) || 0;
  const alts = [];
  if (info && info.target) alts.push({ file: info.target, index: 0 });
  if (file && file !== entry.path) alts.push({ file: entry.path, index: 0 });
  return { id, key: entry.path, file: file || entry.path, index, alts, shell: entry.path };
}

/** 启动条目 */
async function launch(target, args) {
  if (!target) return { ok: false, error: '缺少目标路径' };
  let p = target;
  if (!fs.existsSync(p)) {
    if (/^[a-z]+:\/\//i.test(p)) {
      await shell.openExternal(p);
      return { ok: true };
    }
    return { ok: false, error: '文件不存在：' + p };
  }
  const err = await shell.openPath(p);
  if (err) {
    const { spawn } = require('child_process');
    try {
      spawn('cmd.exe', ['/c', 'start', '', p], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: err };
    }
  }
  return { ok: true };
}

function extAllowed(archive, entry) {
  if (entry.isDir) return !!archive.includeFolders;
  const ext = entry.ext.toLowerCase();
  if (archive.extensions.includes(ext)) return true;
  if (archive.includeOther) return true;
  return false;
}

module.exports = {
  scanDesktop, scanDir, inspect, extractIcons, iconDataUrl, buildJob, launch,
  categoryOf, extAllowed, desktopDirs, hasCached, cacheName, iconDir, CATEGORY,
};
