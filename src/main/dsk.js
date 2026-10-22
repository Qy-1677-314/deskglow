'use strict';
/*
 * 小组件的资源与预设。
 * - 字体 / 图片统一落在 userData 下的 fonts、images，用 dgfile:// 协议读
 * - 预设是单个 .dskset 文件（JSON），字体与图片以 base64 内嵌，别人拿到就能直接用
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog } = require('electron');

const FONT_EXT = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.avif'];
const PRESET_EXT = 'dskset';
const SINGLE_MAX = 8 * 1024 * 1024;   // 单个资源内嵌上限
const TOTAL_MAX = 32 * 1024 * 1024;   // 预设文件里资源总量上限

/** 文件名只留安全字符，避免 ../ 之类的路径跑到目录外面 */
function safeName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 60);
}

function dirOf(kind) {
  return path.join(app.getPath('userData'), kind === 'font' ? 'fonts' : 'images');
}

function ensureDir(kind) {
  const d = dirOf(kind);
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
  return d;
}

function hashOf(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  } catch (_) {
    return crypto.randomBytes(4).toString('hex');
  }
}

/** dgfile:// 只肯读这两个目录里的文件 */
function resolve(kind, file) {
  if (kind !== 'font' && kind !== 'image') return null;
  const base = file.replace(/\.[^.]+$/, '');
  const ext = path.extname(file).toLowerCase();
  if (!safeName(base) || !ext) return null;
  const dir = dirOf(kind);
  const full = path.resolve(dir, safeName(base) + ext);
  if (!full.startsWith(path.resolve(dir) + path.sep)) return null;
  return full;
}

function urlOf(kind, file) {
  return 'dgfile://' + (kind === 'font' ? 'font' : 'img') + '/' + encodeURIComponent(file);
}

function fileFromUrl(src) {
  const m = /^dgfile:\/\/(?:font|img)\/(.+)$/.exec(String(src || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
}

function familyOf(file) {
  return 'DG-' + String(file).replace(/\.[^.]+$/, '');
}

/* ------------------------------ 字体 ------------------------------ */

function listFonts() {
  const dir = ensureDir('font');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter((n) => FONT_EXT.includes(path.extname(n).toLowerCase()))
    .sort()
    .map((file) => {
      const base = file.replace(/\.[^.]+$/, '').replace(/__[0-9a-f]{8}$/, '');
      return { file, name: base, family: familyOf(file), url: urlOf('font', file) };
    });
}

/** 同一个字体重复导入时按内容哈希去重，返回已有的那条 */
function importFont(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!FONT_EXT.includes(ext)) return null;
  const base = safeName(path.basename(srcPath, path.extname(srcPath))) || 'font';
  const file = base + '__' + hashOf(srcPath) + ext;
  const dest = path.join(ensureDir('font'), file);
  try {
    if (!fs.existsSync(dest)) fs.copyFileSync(srcPath, dest);
  } catch (e) {
    return null;
  }
  return { file, name: base, family: familyOf(file), url: urlOf('font', file) };
}

function findFontFile(family) {
  const key = String(family || '');
  if (!key.startsWith('DG-')) return '';
  const want = key.slice(3);
  const list = listFonts();
  const hit = list.find((f) => f.family === key || f.file.replace(/\.[^.]+$/, '') === want);
  return hit ? hit.file : '';
}

/* ------------------------------ 图片 ------------------------------ */

function importImage(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!IMG_EXT.includes(ext)) return null;
  const base = safeName(path.basename(srcPath, path.extname(srcPath))) || 'image';
  const file = base + '__' + hashOf(srcPath) + ext;
  const dest = path.join(ensureDir('image'), file);
  try {
    if (!fs.existsSync(dest)) fs.copyFileSync(srcPath, dest);
  } catch (_) {
    return null;
  }
  return { file, name: base, url: urlOf('img', file) };
}

/* ------------------------------ 预设 ------------------------------ */

function readAsset(kind, file, budget) {
  const full = resolve(kind, file);
  if (!full) return null;
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > SINGLE_MAX || st.size > budget) return null;
    return { name: file, ext: path.extname(file), data: fs.readFileSync(full).toString('base64') };
  } catch (_) {
    return null;
  }
}

function writeAsset(kind, asset) {
  if (!asset || !asset.data) return '';
  const raw = safeName(String(asset.name || ''));
  const base = raw.replace(/\.[^.]+$/, '');
  let ext = String(asset.ext || path.extname(raw) || '').toLowerCase();
  if (ext && ext.charAt(0) !== '.') ext = '.' + ext;
  if (!base || !ext || ![...FONT_EXT, ...IMG_EXT].includes(ext)) return '';
  const finalName = base + ext;
  const full = resolve(kind, finalName);
  if (!full) return '';
  try {
    ensureDir(kind);
    if (!fs.existsSync(full)) fs.writeFileSync(full, Buffer.from(asset.data, 'base64'));
  } catch (_) {
    return '';
  }
  return finalName;
}

/**
 * 导出：把元素里引用到的字体与图片一起打包，换台机器打开也能保持原样。
 * 资源过大时跳过并在 skipped 里说明，不至于把文件写成几十兆。
 */
async function exportPreset(win, widgets, fallbackName) {
  const elements = Array.isArray(widgets && widgets.elements) ? widgets.elements : [];
  const name = String(fallbackName || 'DeskGlow 小组件').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'DeskGlow 小组件';
  const r = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '导出小组件预设',
    defaultPath: path.join(app.getPath('desktop'), name + '.' + PRESET_EXT),
    filters: [{ name: 'DeskGlow 小组件预设', extensions: [PRESET_EXT] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };

  const assets = { fonts: [], images: [] };
  const skipped = [];
  let budget = TOTAL_MAX;

  const fontFiles = new Set();
  for (const el of elements) {
    const fam = el && el.text && el.text.font;
    if (fam && String(fam).startsWith('DG-')) {
      const f = findFontFile(fam);
      if (f) fontFiles.add(f);
    }
    if (el && el.type === 'image' && el.data && el.data.src) {
      const f = fileFromUrl(el.data.src);
      if (!f) continue;
      if (assets.images.some((a) => a.name === f)) continue;
      const a = readAsset('image', f, budget);
      if (a) { assets.images.push(a); budget -= a.data.length; }
      else skipped.push(f);
    }
  }
  for (const f of fontFiles) {
    const a = readAsset('font', f, budget);
    if (a) { assets.fonts.push(a); budget -= a.data.length; }
    else skipped.push(f);
  }

  const payload = {
    format: 'DeskGlow Widget Preset',
    formatId: PRESET_EXT,
    version: 1,
    app: 'DeskGlow',
    createdAt: new Date().toISOString(),
    name: path.basename(r.filePath, '.' + PRESET_EXT),
    elements,
    assets,
  };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return {
    ok: true,
    path: r.filePath,
    count: elements.length,
    fonts: assets.fonts.length,
    images: assets.images.length,
    skipped,
  };
}

/** 导入：先读文件、验证格式，再让用户选替换还是追加 */
async function importPreset(win) {
  const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '导入小组件预设',
    properties: ['openFile'],
    filters: [{ name: 'DeskGlow 小组件预设', extensions: [PRESET_EXT, 'json'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  } catch (e) {
    return { ok: false, error: '文件读不出来，可能不是有效的预设' };
  }
  const elements = Array.isArray(doc.elements) ? doc.elements : null;
  if (!elements || !elements.length) return { ok: false, error: '这个预设里没有元素' };

  const assets = doc.assets || {};
  const restored = { fonts: 0, images: 0 };
  for (const a of Array.isArray(assets.fonts) ? assets.fonts : []) {
    if (writeAsset('font', a)) restored.fonts++;
  }
  for (const a of Array.isArray(assets.images) ? assets.images : []) {
    if (writeAsset('image', a)) restored.images++;
  }

  const msg = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question',
    title: '导入小组件预设',
    message: `这个预设包含 ${elements.length} 个元素`,
    detail: restored.fonts || restored.images
      ? `附带 ${restored.fonts} 个字体、${restored.images} 张图片。\n选择「替换」会清掉当前桌面上已有的元素。`
      : '选择「替换」会清掉当前桌面上已有的元素，选择「追加」则接在后面。',
    buttons: ['替换当前元素', '追加到现有元素', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (msg.response === 2) return { ok: false, canceled: true };

  return {
    ok: true,
    mode: msg.response === 1 ? 'append' : 'replace',
    elements,
    name: doc.name || path.basename(r.filePaths[0], '.' + PRESET_EXT),
  };
}

module.exports = {
  FONT_EXT, IMG_EXT, PRESET_EXT,
  resolve, urlOf, fileFromUrl, familyOf,
  listFonts, importFont, importImage, findFontFile,
  exportPreset, importPreset,
  dirOf, ensureDir,
};
