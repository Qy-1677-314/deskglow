'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, shell, nativeImage, dialog, powerMonitor, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const store = require('./store');
const sc = require('./shortcuts');
const vault = require('./vault');
const taskbar = require('./taskbar');
const ps = require('./ps');
const zorder = require('./zorder');
const dsk = require('./dsk');
const fonts = require('./fonts');
const update = require('./update');
const fmt = require('../renderer/widget-fmt');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
// 应用图标（256px PNG，圆角透明）；打包用的多尺寸 ICO 在同目录 icon.ico
const ICON_FILE = path.join(__dirname, 'assets', 'icon.png');

const GROUP_ICON_PRESETS = [
  ['work', '办公'],
  ['game', '游戏'],
  ['study', '学习'],
  ['chat', '社交'],
  ['music', '影音'],
  ['photo', '图片'],
  ['code', '开发'],
  ['tools', '工具'],
];
const GROUP_ICON_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg', '.bmp', '.gif'];

// 透明窗口一旦被 Chromium 判成「被挡住」，合成会停，Dock 就空一帧。
// 这挡不住 Win+D（那是真实的桌面窗口盖上来），只避免合成器自己停画。
// Win+D 的可见性在 zorder.ps1：所有者固定为桌面，并始终插在桌面层正上方。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,NativeWindowOcclusion,WindowsNativeOcclusionTracker,SpareRendererForSitePerProcess,WinDelaySpellcheckServiceInit,WinRetrieveSuggestionsOnlyOnDemand'
);

// 小组件用的自定义协议：只读 userData 下的 fonts / images。
// 必须在 app ready 之前登记，之后用 protocol.handle 映射到磁盘文件。
protocol.registerSchemesAsPrivileged([
  { scheme: 'dgfile', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } },
]);

let dockWin = null;
let panelWin = null;
let popupWin = null;
let tray = null;
let dockGen = 0;
let dockContentReady = false;
let dockRevealArmed = false;
let dockRevealFallback = null;
let startupCatchUpStarted = false;
let dockHasShown = false;
let taskbarStatusCache = null;

let desktopEntries = [];
let inspectMap = new Map();      // path -> { target, iconFile, iconIndex }
let popupParams = null;
// 页面请求的尺寸。工作区临时变小时不要把收窄后的窗口写回这里，否则任务栏出来后长不回去。
let lastDockSize = { w: 800, h: 96, shpad: 0 };
let displayKey = '';
let dockScale = 0;
let appliedDockKey = '';
let dockRebuilds = [];
let autoHideIgnored = false;
// 光标不在玻璃条上时窗口穿透，桌面右键才能落到壁纸上。null 表示还没设过。
let mousePass = null;
// 玻璃条在窗口里的位置（CSS 像素）。放大时图标会探出栏外，框会跟着变。
let dockHit = null;
// 拖动图标时不能穿透，否则松手事件到不了窗口，拖出移除会断掉。
let dockHolding = false;
let archiveCache = null;
let archiveCacheAt = 0;
let desktopFileCount = 0;
let desktopFileCountAt = 0;
const isDev = process.argv.includes('--dev');

/* ------------------------------------------------------------------ */
/* 渲染兼容模式兜底                                                     */
/* 部分机器（受管控电脑 / 虚拟机）Chromium 沙箱不可用，GPU 进程会反复崩溃。 */
/* 此时自动写入 .compat 标记并以 --no-sandbox 重启，之后一直走兼容模式。   */
/* ------------------------------------------------------------------ */
let compatRestarting = false;

/** 开发时写在项目根，打包后写在用户数据目录（asar 里不可写） */
function compatFlagPaths() {
  const list = [path.join(__dirname, '..', '..', '.compat')];
  try { list.push(path.join(app.getPath('userData'), '.compat')); } catch (_) { /* app 尚未就绪 */ }
  return list;
}

function compatEnabled() {
  return compatFlagPaths().some((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
}

function writeCompatFlag() {
  for (const p of compatFlagPaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'compat-mode');
    } catch (_) { /* 打包后项目根在 asar 里，写失败可忽略 */ }
  }
}

/** 重启参数：未打包时要带上应用目录；开机自启不要带上调试参数 */
function relaunchArgs({ sandbox = process.argv.includes('--no-sandbox'), keepDevFlags = false } = {}) {
  const args = [];
  if (!app.isPackaged) args.push(app.getAppPath());
  if (sandbox && !args.includes('--no-sandbox')) args.push('--no-sandbox');
  if (keepDevFlags) {
    if (process.argv.includes('--dev')) args.push('--dev');
    if (process.argv.includes('--capture')) args.push('--capture');
  }
  return args;
}

function relaunchCompat(reason) {
  if (compatRestarting) return;
  if (process.argv.includes('--no-sandbox')) return; // 已经是兼容模式，避免死循环
  compatRestarting = true;
  writeCompatFlag();
  try {
    app.relaunch({ args: relaunchArgs({ sandbox: true, keepDevFlags: true }) });
    console.warn('[DeskGlow] 渲染进程异常（' + reason + '），切换到兼容模式重启');
  } catch (_) { /* ignore */ }
  setTimeout(() => app.exit(0), 120);
}

app.on('child-process-gone', (e, details) => {
  if (!details) return;
  if (details.type !== 'GPU' && details.type !== 'Utility') return;
  if (details.reason === 'clean-exit') return;
  relaunchCompat(details.type + ':' + details.reason);
});

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function invalidateArchive() {
  archiveCache = null;
  archiveCacheAt = 0;
}

function refreshDesktop() {
  desktopEntries = sc.scanDesktop();
  desktopFileCount = vault.countDesktopFiles();
  desktopFileCountAt = Date.now();
  invalidateArchive();
  return desktopEntries;
}

function desktopFilesCached() {
  if (Date.now() - desktopFileCountAt > 3000) {
    desktopFileCount = vault.countDesktopFiles();
    desktopFileCountAt = Date.now();
  }
  return desktopFileCount;
}

/** Dock 上已经占用的路径（含分组内部），用来防止同一个快捷方式出现两次 */
function takenPaths(items) {
  const set = new Set();
  for (const it of items || []) {
    if (it.path) set.add(String(it.path).toLowerCase());
    if (it.kind === 'group') {
      for (const c of it.children || []) if (c.path) set.add(String(c.path).toLowerCase());
    }
  }
  return set;
}

function insertBeforeArchive(items, item) {
  const idx = items.findIndex((i) => i.kind === 'archive');
  if (idx >= 0) items.splice(idx, 0, item);
  else items.push(item);
}

function ensureArchiveItem() {
  const s = store.get();
  if ((s.items || []).some((i) => i.kind === 'archive')) return;
  s.items.push({ id: uid(), kind: 'archive', name: s.archive.name });
}

function entryByPath(p) {
  return desktopEntries.find((e) => e.path.toLowerCase() === String(p).toLowerCase());
}

/**
 * 路径自愈：文件被移动（例如拖进了桌面子文件夹或 DeskGlow\快捷方式）后，
 * 按文件名 / 显示名在扫描结果里找回，避免 Dock 上一片灰色。
 */
function healPaths() {
  const s = store.get();
  const byFile = new Map();
  const byName = new Map();
  for (const e of desktopEntries) {
    if (!e.isShortcut) continue;
    const fk = path.basename(e.path).toLowerCase();
    if (!byFile.has(fk)) byFile.set(fk, e);
    const nk = String(e.name || '').toLowerCase();
    if (nk && !byName.has(nk)) byName.set(nk, e);
  }
  let healed = 0;
  const fix = (o) => {
    if (!o || !o.path) return;
    if (fs.existsSync(o.path)) return;
    const fk = path.basename(o.path).toLowerCase();
    const e = byFile.get(fk) || byName.get(String(o.name || '').toLowerCase());
    if (e) {
      o.path = e.path;
      if (!o.name) o.name = e.name;
      healed++;
    }
  };
  for (const it of s.items || []) {
    if (it.kind === 'app') fix(it);
    if (it.kind === 'group') for (const c of it.children || []) fix(c);
  }
  return healed;
}

async function refreshInspect() {
  const paths = desktopEntries.filter((e) => e.isShortcut).map((e) => e.path);
  // 加上已被收纳/分组的路径（可能已不在桌面）
  const s = store.get();
  const extra = [];
  for (const it of s.items) {
    if (it.kind === 'app' && it.path) extra.push(it.path);
    if (it.kind === 'group') for (const c of it.children || []) if (c.path) extra.push(c.path);
  }
  const all = Array.from(new Set([...paths, ...extra]));
  const res = await sc.inspect(all);
  inspectMap = new Map();
  for (const r of res) if (r && r.path) inspectMap.set(r.path.toLowerCase(), r);
  return inspectMap;
}

/** 生成图标（只处理未缓存的）。includeArchive 为 false 时先把 Dock 上的图标补齐。 */
async function warmIcons(opts = {}) {
  const includeArchive = opts.includeArchive !== false;
  const s = store.get();
  const need = [];
  const seen = new Set();

  const push = (p) => {
    if (!p || seen.has(p.toLowerCase())) return;
    seen.add(p.toLowerCase());
    const fname = sc.cacheName(p, 0);
    if (fs.existsSync(path.join(sc.iconDir(), fname))) return;
    const entry = entryByPath(p) || { path: p };
    const info = inspectMap.get(p.toLowerCase());
    need.push(sc.buildJob(p, entry, info));
  };

  for (const it of s.items || []) {
    if (it.kind === 'app' && it.path) push(it.path);
    if (it.kind === 'group') for (const c of it.children || []) push(c.path);
  }
  if (includeArchive) archiveList().forEach((e) => push(e.path));

  if (!need.length) return 0;
  await sc.extractIcons(need);
  return need.length;
}

/** Dock 上是否还有没缓存的图标。不扫收纳夹。 */
function dockIconsMissing() {
  const s = store.get();
  const dir = sc.iconDir();
  const seen = new Set();
  const missing = (p) => {
    if (!p) return false;
    const k = String(p).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    try { return !fs.existsSync(path.join(dir, sc.cacheName(p, 0))); } catch { return false; }
  };
  for (const it of s.items || []) {
    if (it.kind === 'app' && missing(it.path)) return true;
    if (it.kind === 'group') {
      for (const c of it.children || []) if (missing(c.path)) return true;
    }
  }
  return false;
}

function dockPathsBroken() {
  const s = store.get();
  const bad = (p) => {
    if (!p) return false;
    try { return !fs.existsSync(p); } catch { return false; }
  };
  for (const it of s.items || []) {
    if (it.kind === 'app' && bad(it.path)) return true;
    if (it.kind === 'group') {
      for (const c of it.children || []) if (bad(c.path)) return true;
    }
  }
  return false;
}

/**
 * 窗口已经显示后再扫桌面、补失效路径和图标。
 * 这些以前排在创建窗口之前，Dock 要等它们结束才出现。
 */
async function catchUpAfterShow() {
  let inspected = false;
  try {
    refreshDesktop();
    const healed = healPaths();
    if (healed > 0) store.save(true);
    const broken = dockPathsBroken();
    if (healed > 0 || broken) pushDockState();
    if (dockIconsMissing()) {
      await refreshInspect();
      inspected = true;
      const n = await warmIcons({ includeArchive: false });
      if (n) pushDockState();
    }
  } catch (e) {
    console.warn('[startup] dock', e && e.message ? e.message : e);
  }
  // 收纳夹图标和快捷方式解析不参与首屏。错开一点，避开刚启动的层级脚本。
  setTimeout(() => {
    const prep = inspected ? Promise.resolve() : refreshInspect();
    prep
      .then(() => warmIcons())
      .then((n) => { if (n) broadcast(); })
      .catch((e) => console.warn('[startup] icons', e && e.message ? e.message : e));
  }, 800);
}

function scheduleStartupCatchUp() {
  if (startupCatchUpStarted) return;
  startupCatchUpStarted = true;
  setTimeout(() => { catchUpAfterShow().catch(() => {}); }, 400);
  setTimeout(() => {
    taskbar.status().then((s) => { taskbarStatusCache = s; }).catch(() => {});
  }, 2500);
}

function archiveList() {
  if (archiveCache && Date.now() - archiveCacheAt < 2500) return archiveCache;
  const s = store.get();
  const list = [];
  const seen = new Set();
  const pushEntry = (e, inVault) => {
    const k = e.path.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    list.push({
      path: e.path,
      name: e.name,
      ext: e.ext,
      isDir: e.isDir,
      size: e.size,
      mtime: e.mtime,
      cat: inVault ? 'vault' : sc.categoryOf(e),
      dir: e.dir,
      inVault: !!inVault,
    });
  };

  // 1) 桌面上的文件（按收敛规则）
  for (const e of desktopEntries) {
    if (e.isShortcut) continue;
    if (!sc.extAllowed(s.archive, e)) continue;
    pushEntry(e, false);
  }
  // 2) DeskGlow\文件收纳（用户拖进来的，无条件显示）
  for (const e of vault.listDir(vault.dirs().archive)) {
    if (e.isShortcut) continue;
    pushEntry(e, true);
  }

  const saved = Array.isArray(s.archive.order) ? s.archive.order : [];
  const rank = new Map(saved.map((p, i) => [String(p).toLowerCase(), i]));
  list.sort((a, b) => {
    const ra = rank.has(a.path.toLowerCase()) ? rank.get(a.path.toLowerCase()) : 1e9;
    const rb = rank.has(b.path.toLowerCase()) ? rank.get(b.path.toLowerCase()) : 1e9;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  archiveCache = list;
  archiveCacheAt = Date.now();
  return list;
}

function iconUrl(p) {
  return sc.iconDataUrl(sc.cacheName(p, 0));
}

function groupIconDir() {
  return path.join(app.getPath('userData'), 'group-icons');
}

function groupIconSrc(icon) {
  if (!icon || !String(icon).startsWith('file:')) return '';
  const file = path.join(groupIconDir(), path.basename(String(icon).slice(5)));
  if (!fs.existsSync(file)) return '';
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  }[ext] || 'application/octet-stream';
  try {
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return '';
  }
}

function clearGroupIconFile(it) {
  if (!it || !it.icon || !String(it.icon).startsWith('file:')) return;
  const file = path.join(groupIconDir(), path.basename(String(it.icon).slice(5)));
  try { fs.unlinkSync(file); } catch { /* 文件已经不在 */ }
}

function setGroupIcon(id, icon) {
  const s = store.get();
  const it = s.items.find((i) => i.id === id && i.kind === 'group');
  if (!it) return false;
  const next = icon || '';
  if (next && !GROUP_ICON_PRESETS.some((p) => p[0] === next)) return false;
  if (it.icon !== next) clearGroupIconFile(it);
  it.icon = next;
  store.save(true);
  broadcast();
  return true;
}

async function importGroupIcon(id, parent) {
  const s = store.get();
  const it = s.items.find((i) => i.id === id && i.kind === 'group');
  if (!it) return { ok: false, error: '分组不存在' };
  const opts = {
    title: '选择分组图标',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico', 'svg', 'bmp', 'gif'] }],
  };
  const r = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  let st;
  try { st = fs.statSync(src); } catch { return { ok: false, error: '读不到这张图片' }; }
  if (!st.isFile()) return { ok: false, error: '请选择图片文件' };
  if (st.size > 2 * 1024 * 1024) return { ok: false, error: '图片请小于 2MB' };
  const ext = path.extname(src).toLowerCase();
  if (!GROUP_ICON_EXT.includes(ext)) return { ok: false, error: '只支持 png、jpg、webp、ico、svg' };
  const dir = groupIconDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${id}${ext}`;
  clearGroupIconFile(it);
  for (const old of GROUP_ICON_EXT) {
    const p = path.join(dir, `${id}${old}`);
    if (path.basename(p) === name) continue;
    try { fs.unlinkSync(p); } catch { /* 没有旧文件 */ }
  }
  fs.copyFileSync(src, path.join(dir, name));
  it.icon = `file:${name}`;
  store.save(true);
  broadcast();
  return { ok: true };
}

function serializeItem(it, archiveCount, checkExists = true) {
  const gone = (p) => (checkExists ? !fs.existsSync(p) : false);
  if (it.kind === 'app') {
    return { id: it.id, kind: 'app', name: it.name, path: it.path, icon: iconUrl(it.path), missing: gone(it.path) };
  }
  if (it.kind === 'group') {
    const children = (it.children || []).map((c) => ({
      id: c.id, name: c.name, path: c.path, icon: iconUrl(c.path), missing: gone(c.path),
    }));
    const custom = !!(it.icon && String(it.icon).startsWith('file:'));
    return {
      id: it.id, kind: 'group', name: it.name, count: children.length,
      children, preview: children.slice(0, 4).map((c) => c.icon),
      icon: custom ? '' : (it.icon || ''),
      iconSrc: custom ? groupIconSrc(it.icon) : '',
    };
  }
  return { id: it.id, kind: 'archive', name: it.name || store.get().archive.name, count: archiveCount };
}

function buildState() {
  const s = store.get();
  const archiveRaw = archiveList();
  const items = (s.items || []).map((it) => serializeItem(it, archiveRaw.length));
  const archive = archiveRaw.map((e) => ({ ...e, icon: iconUrl(e.path) }));
  const shortcuts = (s.items || []).reduce((n, it) => n + (it.kind === 'app' ? 1 : it.kind === 'group' ? (it.children || []).length : 0), 0);
  const vd = vault.dirs();
  return {
    appearance: s.appearance,
    archive: { ...s.archive, name: s.archive.name },
    vault: {
      root: vd.root,
      shortcuts: vd.shortcuts,
      archive: vd.archive,
      desktopShortcuts: desktopEntries.filter((e) => e.isShortcut && !e.path.toLowerCase().startsWith(vd.root.toLowerCase())).length,
      desktopFiles: desktopFilesCached(),
    },
    taskbar: s.taskbar,
    widgets: s.widgets,
    items,
    archiveItems: archive,
    stats: {
      shortcuts,
      groups: (s.items || []).filter((i) => i.kind === 'group').length,
      archiveCount: archive.length,
      total: shortcuts,
    },
    ui: { dockVisible: s.ui.dockVisible !== false },
    version: app.getVersion(),
    configPath: store.pathFile(),
    dev: isDev,
  };
}

/** Dock 首屏只需要栏上的图标。收纳夹里每个文件的图标留到面板再算。 */
function buildDockState(checkExists = false) {
  const s = store.get();
  return {
    appearance: s.appearance,
    items: (s.items || []).map((it) => serializeItem(it, 0, checkExists)),
    ui: { dockVisible: s.ui.dockVisible !== false },
  };
}

function pushDockState() {
  if (!dockWin || dockWin.isDestroyed()) return;
  try { dockWin.webContents.send('state:update', buildDockState(true)); } catch (_) { /* ignore */ }
}

function broadcast() {
  const state = buildState();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('state:update', state);
  }
  if (tray) updateTrayMenu();
}

/** 只改外观时不重发全部图标，避免拖滑条时三个窗口反复重绘 */
function broadcastAppearance() {
  const appearance = store.get().appearance;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('appearance:update', appearance);
  }
}

/* ------------------------------------------------------------------ */
/* 首次初始化                                                          */
/* ------------------------------------------------------------------ */

function bootstrapItems() {
  const s = store.get();
  if (s.initialized) return;
  const apps = desktopEntries.filter((e) => e.isShortcut);
  s.items = apps.map((e) => ({ id: uid(), kind: 'app', name: e.name, path: e.path }));
  s.items.push({ id: uid(), kind: 'archive', name: s.archive.name });
  s.initialized = true;
  store.save(true);
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function dockTarget() {
  const s = store.get();
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(lastDockSize.w, Math.max(320, wa.width - 60));
  // 高度按页面请求的来。工作区还没稳定时先收一收，变大后再放回去。
  const h = Math.min(lastDockSize.h, Math.max(64, Math.round(wa.height * 0.72)));
  // 窗口底部比栏底多留 shpad：这段空间专门用来画外投影，
  // 不留的话阴影会被窗口边界裁成一条硬边。
  const shpad = Math.max(0, Number(lastDockSize.shpad) || 0);
  const offset = Number(s.appearance.bottomOffset || 0);
  const x = wa.x + Math.round((wa.width - w) / 2);
  const y = wa.y + wa.height - h + shpad - offset;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

function currentDisplayKey() {
  try {
    const d = screen.getPrimaryDisplay();
    const wa = d.workArea;
    const b = d.bounds;
    return [Math.round(d.scaleFactor * 100), b.width, b.height, wa.x, wa.y, wa.width, wa.height].join(',');
  } catch (_) {
    return '';
  }
}

/** 开机后缩放、分辨率、任务栏占位会连着变几次。等它停住再创建窗口。 */
const EARLY_BOOT_SEC = 90;

function waitForStableDisplay() {
  return new Promise((resolve) => {
    let last = currentDisplayKey();
    let stable = 0;
    let done = false;
    const step = 200;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(cap);
      resolve();
    };
    const timer = setInterval(() => {
      const now = currentDisplayKey();
      if (now === last) stable += step;
      else { last = now; stable = 0; }
      if (stable >= 400) finish();
    }, step);
    const cap = setTimeout(finish, 3000);
  });
}

function canRebuildDock() {
  const now = Date.now();
  dockRebuilds = dockRebuilds.filter((t) => now - t < 30000);
  if (dockRebuilds.length >= 3) return false;
  dockRebuilds.push(now);
  return true;
}

function recreateDock() {
  const old = dockWin;
  dockWin = null;
  if (old && !old.isDestroyed()) {
    try { old.webContents.removeAllListeners('render-process-gone'); } catch (_) { /* ignore */ }
    try { old.removeAllListeners(); } catch (_) { /* ignore */ }
    try { old.destroy(); } catch (_) { /* ignore */ }
  }
  createDock();
}

/**
 * 透明窗口的缩放在创建时就定了。开机自启若赶在系统缩放生效之前，
 * 画面会停在旧缩放上，看起来只剩一半；setBounds 改的是同一套坐标，补不回来。
 */
function syncDockDisplay() {
  if (!dockWin || dockWin.isDestroyed()) return;
  if (store.get().ui.dockVisible === false) return;
  let scale = 0;
  try { scale = screen.getPrimaryDisplay().scaleFactor; } catch (_) { return; }
  if (dockScale && Math.abs(scale - dockScale) > 0.01) {
    if (canRebuildDock()) recreateDock();
    return;
  }
  const key = currentDisplayKey();
  // 页面还在加载时先别把 key 记成已处理，否则这次变更不会再量一次。
  if (key && key !== displayKey && !dockWin.webContents.isLoading()) {
    displayKey = key;
    try { dockWin.webContents.send('dock:remeasure'); } catch (_) { /* ignore */ }
  }
  positionDock();
}

/** 页面坐标和窗口坐标对不上（常见于 150%/200% 缩放下只画出一半）时重建窗口。 */
async function healDockViewport() {
  if (!dockWin || dockWin.isDestroyed()) return;
  if (store.get().ui.dockVisible === false) return;
  let page;
  try {
    page = await dockWin.webContents.executeJavaScript(
      '({dpr:window.devicePixelRatio,iw:window.innerWidth,ih:window.innerHeight})',
      true
    );
  } catch (_) { return; }
  if (!dockWin || dockWin.isDestroyed() || !page || !(page.ih > 10) || !(page.iw > 10)) return;
  const b = dockWin.getBounds();
  let scale = dockScale;
  try { scale = screen.getPrimaryDisplay().scaleFactor; } catch (_) { /* ignore */ }
  const badScale = Math.abs(Number(page.dpr) - scale) > 0.05;
  // 只认「页面比窗口小一截」。150% 缩放下大约是 0.67，200% 是 0.5。
  const badViewport = page.ih / b.height < 0.9 || page.iw / b.width < 0.9;
  if (!badScale && !badViewport) return;
  if (!canRebuildDock()) return;
  recreateDock();
}

/** 用户当前缩放。Win11 写在 WindowMetrics\AppliedDPI（144 = 150%），老系统才用 LogPixels。 */
function readConfiguredDpi() {
  const { execFile } = require('child_process');
  const keys = [
    ['HKCU\\Control Panel\\Desktop\\WindowMetrics', 'AppliedDPI'],
    ['HKCU\\Control Panel\\Desktop', 'LogPixels'],
  ];
  const next = (i) => new Promise((resolve) => {
    if (i >= keys.length) return resolve(0);
    const [key, name] = keys[i];
    execFile('reg.exe', ['query', key, '/v', name], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 4000,
    }, (err, out) => {
      if (!err) {
        const m = String(out).match(/0x([0-9a-f]+)/i);
        const dpi = m ? parseInt(m[1], 16) : 0;
        if (dpi >= 96 && dpi <= 480) return resolve(dpi);
      }
      resolve(next(i + 1));
    });
  });
  return next(0);
}

/**
 * 进程若在登录早期就拿到 96 DPI，这次运行里 scaleFactor 会一直是 1。
 * 窗口内部看起来是齐的，实际比系统缩放小一截，重新打开才正常。
 * 只在开机后的前十分钟、并且只重启一次。
 */
function maybeRelaunchForStartupDpi(dpi) {
  if (process.argv.includes('--dpi-settled') || process.argv.includes('--capture')) return false;
  if (require('os').uptime() > 600) return false;
  if (!dpi) return false;
  let scale = 1;
  try { scale = screen.getPrimaryDisplay().scaleFactor; } catch (_) { return false; }
  if (Math.abs(dpi / 96 - scale) < 0.2) return false;
  try {
    const args = relaunchArgs({ keepDevFlags: true });
    if (!args.includes('--dpi-settled')) args.push('--dpi-settled');
    app.relaunch({ args });
    app.releaseSingleInstanceLock();
  } catch (_) { return false; }
  app.exit(0);
  return true;
}

function positionDock(save = true) {
  if (!dockWin || dockWin.isDestroyed()) return;
  const b = dockTarget();
  const cur = dockWin.getBounds();
  const same = cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height;
  if (!same) {
    const want = [b.x, b.y, b.width, b.height].join(',');
    // 系统不接受这次尺寸时不要每 200ms 再设一次，透明窗口会在壁纸上闪。
    if (want !== appliedDockKey) {
      appliedDockKey = want;
      try { dockWin.setBounds(b); } catch (_) { /* ignore */ }
    }
  } else {
    appliedDockKey = '';
  }
  sinkDock();
}

function attachDiagnostics(win, tag) {
  if (!win) return;
  win.webContents.on('preload-error', (_e, p, err) => console.log(`[${tag}] preload-error`, p, err && err.message));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[${tag}] did-fail-load`, code, desc, url));
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[${tag}] console:`, message, `${src}:${line}`);
  });
}

/**
 * 窗口被最小化、隐藏或挪出屏幕时把它拉回来。
 * 纯 Z 序变化不要走这里的重绘：透明窗口每被强制重绘一次，
 * 毛玻璃就会在桌面上闪一块，Wallpaper Engine 开着时尤其明显。
 */
function dockWasHiddenByShell() {
  if (!dockWin || dockWin.isDestroyed()) return false;
  try {
    if (dockWin.isMinimized() || !dockWin.isVisible()) return true;
    const cur = dockWin.getBounds();
    if (cur.x <= -2000 || cur.y <= -2000) return true;
    const wa = screen.getPrimaryDisplay().workArea;
    if (cur.y > wa.y + wa.height + 40) return true;
    if (cur.x + cur.width < wa.x - 20) return true;
  } catch (_) { return false; }
  return false;
}

function reviveDock() {
  if (!dockHasShown) return;
  if (!dockWin || dockWin.isDestroyed()) return;
  if (store.get().ui.dockVisible === false) return;
  let moved = false;
  try {
    const lost = dockWasHiddenByShell();
    if (dockWin.isMinimized()) {
      dockWin.setMinimizable(true);
      dockWin.restore();
      dockWin.setMinimizable(false);
      moved = true;
    }
    if (!dockWin.isVisible()) {
      dockWin.showInactive();
      moved = true;
    }
    if (lost || moved) positionDock();
    else sinkDock();
  } catch { /* ignore */ }
}

/** 贴在桌面上，但位于所有普通窗口后面。点击时不要抢到最前。 */
function sinkDock() {
  if (!dockWin || dockWin.isDestroyed() || !dockWin.isVisible()) return;
  if (store.get().ui.dockVisible === false) return;
  zorder.sink(dockWin);
}

zorder.onMode((mode) => {
  if (mode !== 'DESKTOP') return;
  if (!dockHasShown) return;
  if (!dockWin || dockWin.isDestroyed()) return;
  if (store.get().ui.dockVisible === false) return;
  try {
    if (!dockWin.isMinimized() && dockWin.isVisible()) return;
    if (dockWin.isMinimized()) {
      dockWin.setMinimizable(true);
      dockWin.restore();
      dockWin.setMinimizable(false);
    }
    if (!dockWin.isVisible()) dockWin.showInactive();
    positionDock();
  } catch (_) { /* ignore */ }
});

function popupMenu(win, template) {
  const menu = Menu.buildFromTemplate(template);
  const target = win && !win.isDestroyed() ? win : undefined;
  const onDock = !!(target && dockWin && target === dockWin);
  if (onDock) {
    try { dockWin.setFocusable(true); } catch (_) { /* ignore */ }
  }
  menu.popup({
    window: target,
    callback: () => {
      if (!onDock || !dockWin || dockWin.isDestroyed()) return;
      try { dockWin.setFocusable(false); } catch (_) { /* ignore */ }
      sinkDock();
    },
  });
}

/** 穿透位会被置顶切换冲掉，但 JS 标志还停在 true，于是不再重设，右键又被窗口吃掉。 */
let mousePassAt = 0;

/** 只在穿透状态变化时改窗口。来回设会让透明窗口闪一下。
 *  已经是穿透时，隔一会儿再写一次同样的样式，把被冲掉的 WS_EX_TRANSPARENT 补回来。 */
function setMousePass(pass) {
  if (!dockWin || dockWin.isDestroyed()) return;
  const next = !!pass;
  const now = Date.now();
  if (mousePass === next) {
    if (!next || now - mousePassAt < 400) return;
  }
  // 窗口默认就接收点击。还没穿透过就不要再设一次 false，免得透明层闪一下。
  if (!next && mousePass == null) { mousePass = false; return; }
  const prev = mousePass;
  mousePass = next;
  mousePassAt = now;
  try {
    if (next) dockWin.setIgnoreMouseEvents(true, { forward: true });
    else dockWin.setIgnoreMouseEvents(false);
  } catch (_) {
    mousePass = prev;
  }
}

function cursorOnDock() {
  if (!dockWin || dockWin.isDestroyed()) return true;
  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch (_) { return true; }
  let b;
  try { b = dockWin.getContentBounds(); } catch (_) { return true; }
  // 光标在窗口外面时，这块透明留白不该被当成 Dock。
  if (pt.x < b.x || pt.y < b.y || pt.x > b.x + b.width || pt.y > b.y + b.height) return false;
  if (!dockHit) return true;
  // 150% 缩放下页面坐标有时比窗口小一截，不换算的话命中框会盖住名字那一截留白。
  const sx = dockHit.pageW > 8 ? b.width / dockHit.pageW : 1;
  const sy = dockHit.pageH > 8 ? b.height / dockHit.pageH : 1;
  const pad = 2;
  const x = b.x + dockHit.x * sx;
  const y = b.y + dockHit.y * sy;
  const w = dockHit.w * sx;
  const h = dockHit.h * sy;
  return pt.x >= x - pad && pt.x <= x + w + pad
    && pt.y >= y - pad && pt.y <= y + h + pad;
}

/** 自动隐藏：Windows 上窗口一旦 setIgnoreMouseEvents 就收不到 mousemove，
 *  所以改由主进程轮询光标是否落在 Dock 底部的热区里，再通知渲染进程展开。 */
let dockHotTimer = null;
let dockHot = false;
let dockHotMiss = 0;
let dockPassTimer = null;

function startDockHoverWatch() {
  if (dockHotTimer) clearInterval(dockHotTimer);
  dockHotTimer = setInterval(() => {
    if (!dockWin || dockWin.isDestroyed()) return;
    const autoHide = store.get().appearance.autoHide === true;
    if (!autoHide) {
      if (autoHideIgnored) {
        try { dockWin.setIgnoreMouseEvents(false); } catch (_) { /* ignore */ }
        autoHideIgnored = false;
        mousePass = false;
      }
      dockHot = false;
      dockHotMiss = 0;
      return;
    }
    let pt;
    try { pt = screen.getCursorScreenPoint(); } catch { return; }
    const b = dockWin.getBounds();
    const inX = pt.x >= b.x && pt.x <= b.x + b.width;
    // 收起时只认窗口下沿 56px 的热区；展开后整个 Dock（含上方留白）都算在内
    const inY = dockHot
      ? pt.y >= b.y - 10 && pt.y <= b.y + b.height + 8
      : pt.y >= b.y + b.height - 56 && pt.y <= b.y + b.height + 8;
    const inHot = inX && inY;

    if (inHot) {
      dockHotMiss = 0;
      if (dockHot) return;
      dockHot = true;
    } else {
      // 光标读数偶发抖动时不要立刻收起，连续 1.1 秒落在外面才算离开
      dockHotMiss++;
      if (!dockHot || dockHotMiss < 10) return;
      dockHot = false;
    }

    try {
      dockWin.setIgnoreMouseEvents(!dockHot, { forward: true });
      autoHideIgnored = !dockHot;
      mousePass = !dockHot;
    } catch { /* ignore */ }
    try { dockWin.webContents.send('dock:expand', dockHot); } catch { /* ignore */ }
  }, 110);
}

/** 玻璃条以外是透明留白（名字、放大、投影）。光标在那里时让点击落到桌面。
 *  渲染进程在移出玻璃条时会马上改；这里再对一次光标，因为穿透之后页面收不到 mousemove。 */
function startDockPassWatch() {
  if (dockPassTimer) clearInterval(dockPassTimer);
  dockPassTimer = setInterval(() => {
    if (!dockWin || dockWin.isDestroyed()) return;
    if (dockHolding) { setMousePass(false); return; }
    const autoHide = store.get().appearance.autoHide === true;
    // 收起时整窗穿透归自动隐藏管，两边不要抢
    if (autoHide && !dockHot) return;
    // 还没量到图标时，先让窗口上沿那截留白穿透，避免名字区域一直吃掉桌面右键。
    if (!dockHit) { setMousePass(true); return; }
    setMousePass(!cursorOnDock());
  }, 24);
}

function armDock(gen) {
  if (gen !== dockGen) return;
  if (!dockContentReady || !dockRevealArmed) return;
  if (!dockWin || dockWin.isDestroyed()) return;
  if (dockRevealFallback) { clearTimeout(dockRevealFallback); dockRevealFallback = null; }
  try { dockWin.webContents.setBackgroundThrottling(false); } catch (_) { /* ignore */ }
  if (!dockWin.isVisible()) dockWin.showInactive();
  dockHasShown = true;
  sinkDock();
  if (armDock.doneGen === gen) return;
  armDock.doneGen = gen;
  // 缩放若在窗口出来之后才写进页面，过一会儿页面高度会只剩窗口的一半。
  setTimeout(healDockViewport, 1200);
  setTimeout(healDockViewport, 4500);
  if (!tray) setTimeout(buildTray, 400);
  scheduleStartupCatchUp();
}

function noteDockContentReady(gen) {
  if (gen !== dockGen) return;
  dockContentReady = true;
  armDock(gen);
}

function createDock() {
  const gen = ++dockGen;
  dockContentReady = false;
  dockRevealArmed = false;
  dockHasShown = false;
  dockHit = null;
  dockHolding = false;
  mousePass = null;
  if (dockRevealFallback) { clearTimeout(dockRevealFallback); dockRevealFallback = null; }
  const b = dockTarget();
  try { dockScale = screen.getPrimaryDisplay().scaleFactor; } catch (_) { dockScale = 0; }
  displayKey = currentDisplayKey();
  appliedDockKey = '';
  dockWin = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    focusable: false,
    hasShadow: false,
    acceptFirstMouse: true,
    show: false,
    title: 'DeskGlow Dock',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  dockWin._gen = gen;
  dockWin.setAlwaysOnTop(false);
  // Win+D 已冻结。约定见 AGENTS.md 与 .cursor/skills/deskgow-show-desktop/SKILL.md。
  // 不要对 Dock 调用 setAlwaysOnTop(true) 或 setVisibleOnAllWorkspaces。
  // 显示桌面时的置顶只允许 zorder.ps1 把窗口贴在置顶带最底部。
  dockWin.loadFile(path.join(RENDERER, 'dock.html'));
  attachDiagnostics(dockWin, 'dock');

  // 显示桌面把窗口压到 HWND_BOTTOM，或直接最小化。Z 序只重排，不强制重绘。
  const WM_WINDOWPOSCHANGING = 0x0046;
  let shellNudge = null;
  dockWin.hookWindowMessage(WM_WINDOWPOSCHANGING, (_w, lParam) => {
    try {
      if (!lParam || lParam.length < 36) return;
      const insertAfter = lParam.readBigUInt64LE(8);
      const x = lParam.readInt32LE(16);
      const flags = lParam.readUInt32LE(32);
      const movedOff = (flags & 0x0002) === 0 && x <= -30000;
      const hiding = (flags & 0x0080) !== 0;
      const buried = insertAfter === 1n;
      if (!buried && !movedOff && !hiding) return;
      if (movedOff || hiding) {
        setTimeout(reviveDock, 30);
        setTimeout(reviveDock, 200);
        return;
      }
      if (shellNudge) return;
      shellNudge = setTimeout(() => {
        shellNudge = null;
        sinkDock();
        setTimeout(sinkDock, 160);
      }, 30);
    } catch (_) { /* ignore */ }
  });
  dockWin.on('minimize', () => {
    setTimeout(reviveDock, 0);
    setTimeout(reviveDock, 200);
  });
  dockWin.on('hide', () => {
    if (store.get().ui.dockVisible !== false) setTimeout(reviveDock, 0);
  });
  // 兜底：万一 minimize 事件没触发（窗口只是被系统移出屏幕），恢复后重新摆位
  dockWin.on('restore', () => setTimeout(() => { try { positionDock(); } catch {} }, 30));

  // 页面先拿到图标再显示，避免先闪出一条空坞。超时仍显示，防止脚本出错时永远不出现。
  dockRevealFallback = setTimeout(() => {
    if (gen !== dockGen) return;
    dockContentReady = true;
    dockRevealArmed = true;
    armDock(gen);
  }, 2000);
  dockWin.once('ready-to-show', () => {
    if (gen !== dockGen) return;
    // 关闭后台节流，保证 Dock 在屏幕外时动画仍运行。
    // 「显示桌面」下的可见性由 zorder.ps1 维持：高于桌面层，低于普通窗口。
    try { dockWin.webContents.setBackgroundThrottling(false); } catch (_) { /* ignore */ }
    dockRevealArmed = true;
    armDock(gen);
  });
  dockWin.on('show', () => sinkDock());
  dockWin.on('closed', () => { dockWin = null; });
  startDockHoverWatch();
  startDockPassWatch();
  dockWin.webContents.on('render-process-gone', () => {
    if (dockWin) { dockWin.destroy(); dockWin = null; }
    setTimeout(createDock, 800);
  });
}

function showDock(show) {
  if (!dockWin) return;
  // 先写标记再隐藏，避免 hide 事件里的守护逻辑把 Dock 又拉回来
  store.get().ui.dockVisible = show;
  if (show) dockWin.showInactive();
  else dockWin.hide();
  store.save();
  if (tray) updateTrayMenu();
}

function createPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return panelWin;
  }
  const s = store.get();
  const bounds = s.ui.panelBounds || { width: 1120, height: 740 };
  panelWin = new BrowserWindow({
    width: bounds.width || 1120,
    height: bounds.height || 740,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#f5f6fa',
    title: 'DeskGlow 控制面板',
    icon: nativeImage.createFromPath(ICON_FILE),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  panelWin.loadFile(path.join(RENDERER, 'panel.html'));
  attachDiagnostics(panelWin, 'panel');
  panelWin.once('ready-to-show', () => {
    panelWin.show();
    panelWin.focus();
  });
  panelWin.on('close', () => {
    try {
      const b = panelWin.getBounds();
      store.get().ui.panelBounds = b;
      store.save();
    } catch {}
  });
  panelWin.on('closed', () => { panelWin = null; });
  return panelWin;
}

function focusPanelTab(tab) {
  createPanel();
  if (!panelWin || panelWin.isDestroyed()) return;
  const send = () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('focus:tab', tab);
  };
  if (panelWin.webContents.isLoading()) panelWin.webContents.once('did-finish-load', send);
  else send();
}

/* ------------------------------------------------------------------ */
/* 桌面小组件（元素画布）                                               */
/* 一个铺满工作区的透明窗口承载全部元素：时钟 / 日期 / 电量 / 文本 / 图片。 */
/* 平时鼠标穿透，桌面图标照常能点；编辑模式才接管鼠标、临时浮到最上层。      */
/* 层级仍然只走 zorder.sink()，与 Dock 同一套规则，不改那里的任何代码。      */
/* ------------------------------------------------------------------ */
let widgetWin = null;
let widgetEdit = false;
let widgetSinkTimer = null;
let panelWasHiddenForEdit = false;
let batteryState = { hasBattery: false, percent: null, charging: false, ac: false, minutes: 0 };
let batteryTimer = null;
let batteryBusy = false;
let batteryBound = false;

function widgetConfig() {
  return store.get().widgets || {};
}

function widgetElements() {
  const w = widgetConfig();
  return Array.isArray(w.elements) ? w.elements : [];
}

function saveElements(list) {
  const s = store.get();
  s.widgets.elements = list;
  store.save();
}

function findElement(id) {
  return widgetElements().find((e) => e && e.id === id) || null;
}

function workArea() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}

function widgetState() {
  return {
    widgets: widgetConfig(),
    battery: batteryState,
    edit: widgetEdit,
    screen: workArea(),
  };
}

/** 组装配置里的点号路径，元素深层字段（text.size 之类）都靠它写 */
function setPath(obj, pathStr, value) {
  const keys = String(pathStr || '').split('.').filter(Boolean);
  if (!keys.length) return false;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return true;
}

function applyElementPatch(el, patch) {
  if (!el || !patch || typeof patch !== 'object') return;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (k.indexOf('.') >= 0) { setPath(el, k, v); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && el[k] && typeof el[k] === 'object' && !Array.isArray(el[k])) {
      applyElementPatch(el[k], v);
    } else {
      el[k] = v;
    }
  }
}

function needsBattery() {
  return widgetElements().some((e) => e && e.type === 'battery' && e.visible !== false);
}

/** 和 Dock 一样贴在桌面上：显示桌面时还在，打开的程序会盖住它。 */
function sinkWidget() {
  if (!widgetWin || widgetWin.isDestroyed() || !widgetWin.isVisible()) return;
  if (widgetConfig().enabled === false) return;
  if (widgetEdit) return;  // 编辑时临时置顶，退出后再坐回桌面
  zorder.sink(widgetWin);
  ensureWidgetPassThrough();
}

let widgetPassAt = 0;

/**
 * 保证画布不吃鼠标。Windows 上 setBounds / 置顶切换一类窗口操作有可能把
 * WS_EX_TRANSPARENT 冲掉，一旦丢了整块画布就会盖住桌面（点不中、右键也没反应）。
 * 编辑态退出、工作区变化时立刻补一次，平时借 sink 心跳低频兜底。
 * 刻意不加 forward：非编辑态画布不需要鼠标移动事件（渲染层只在拖拽/缩放/框选时
 * 用指针事件），纯 WS_EX_TRANSPARENT 穿透最可靠，也免得受鼠标钩子和 UIPI 影响。
 */
function ensureWidgetPassThrough(force) {
  if (!widgetWin || widgetWin.isDestroyed() || widgetEdit) return;
  const now = Date.now();
  if (!force && now - widgetPassAt < 5000) return;
  widgetPassAt = now;
  try { widgetWin.setIgnoreMouseEvents(true); } catch (_) { /* ignore */ }
}

function startWidgetWatch() {
  if (widgetSinkTimer) return;
  // 显示桌面只改 Z 序。Dock 有窗口消息钩子，这里用低频补层级就够了。
  widgetSinkTimer = setInterval(() => {
    try { sinkWidget(); } catch (_) { /* ignore */ }
  }, 1500);
}

function stopWidgetWatch() {
  if (!widgetSinkTimer) return;
  clearInterval(widgetSinkTimer);
  widgetSinkTimer = null;
}

/** 工作区变了（任务栏挪位、分辨率变化）时把画布重新铺满 */
function placeCanvas() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const wa = workArea();
  try { widgetWin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height }); } catch (_) { /* ignore */ }
  ensureWidgetPassThrough(true);  // setBounds 之后补一次穿透，别让画布盖住桌面
  broadcastWidgets('main');
}

function createWidget() {
  if (widgetWin && !widgetWin.isDestroyed()) return widgetWin;
  const wa = workArea();
  widgetWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: false,
    acceptFirstMouse: true,
    show: false,
    title: 'DeskGlow 小组件',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  widgetWin.setAlwaysOnTop(false);
  // 平时不吃鼠标，桌面图标 / 桌面右键都还能用
  try { widgetWin.setIgnoreMouseEvents(true); } catch (_) { /* ignore */ }
  widgetWin.loadFile(path.join(RENDERER, 'widget.html'));
  attachDiagnostics(widgetWin, 'widget');
  widgetWin.once('ready-to-show', () => {
    if (!widgetWin || widgetWin.isDestroyed()) return;
    if (widgetConfig().enabled === false) return;
    if (widgetEdit) wrapperFocus();
    else widgetWin.showInactive();
    sinkWidget();
    setTimeout(sinkWidget, 220);
    setTimeout(sinkWidget, 800);
  });
  widgetWin.webContents.on('did-finish-load', () => {
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('widget:edit', widgetEdit);
  });
  widgetWin.on('closed', () => { widgetWin = null; widgetEdit = false; });
  widgetWin.webContents.on('render-process-gone', () => {
    if (widgetWin) { try { widgetWin.destroy(); } catch (_) { /* ignore */ } widgetWin = null; }
    setTimeout(() => { if (widgetConfig().enabled !== false) createWidget(); }, 800);
  });
  return widgetWin;
}

function wrapperFocus() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  try { widgetWin.show(); widgetWin.focus(); } catch (_) { /* ignore */ }
}

/** 进入 / 退出可视化编辑：接管鼠标、临时置顶，退出时把面板还回来 */
function setWidgetEdit(on) {
  const next = !!on;
  if (!widgetWin || widgetWin.isDestroyed()) { widgetEdit = next; return next; }
  if (next === widgetEdit) {
    try { widgetWin.webContents.send('widget:edit', widgetEdit); } catch (_) { /* ignore */ }
    return widgetEdit;
  }
  widgetEdit = next;
  if (next) {
    stopWidgetWatch();
    try { widgetWin.setAlwaysOnTop(true, 'floating'); } catch (_) { /* ignore */ }
    try { widgetWin.setIgnoreMouseEvents(false); } catch (_) { /* ignore */ }
    wrapperFocus();
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
      panelWin.hide();
      panelWasHiddenForEdit = true;
    }
  } else {
    try { widgetWin.setAlwaysOnTop(false); } catch (_) { /* ignore */ }
    ensureWidgetPassThrough(true);  // 先恢复穿透再坐下桌面层级，顺序不能反
    try { widgetWin.showInactive(); } catch (_) { /* ignore */ }
    startWidgetWatch();
    sinkWidget();
    setTimeout(() => { try { sinkWidget(); } catch (_) { /* ignore */ } }, 400);
    if (panelWasHiddenForEdit && panelWin && !panelWin.isDestroyed()) {
      try { panelWin.show(); panelWin.focus(); } catch (_) { /* ignore */ }
    }
    panelWasHiddenForEdit = false;
  }
  try { widgetWin.webContents.send('widget:edit', widgetEdit); } catch (_) { /* ignore */ }
  broadcastWidgets('main');
  return widgetEdit;
}

function applyWidgetSettings() {
  const w = widgetConfig();
  if (w.enabled === false) {
    if (widgetEdit) setWidgetEdit(false);
    stopWidgetWatch();
    stopBatteryWatch();
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.hide();
  } else {
    createWidget();
    if (widgetWin && !widgetWin.isDestroyed() && !widgetWin.isVisible()) {
      if (widgetEdit) wrapperFocus();
      else { widgetWin.showInactive(); setTimeout(sinkWidget, 80); }
    }
    startWidgetWatch();
    if (needsBattery()) startBatteryWatch();
    else stopBatteryWatch();
  }
  broadcastWidgets('main');
  if (tray) updateTrayMenu();
}

function broadcastWidgets(src) {
  const payload = {
    widgets: widgetConfig(),
    edit: widgetEdit,
    screen: workArea(),
    fonts: dsk.listFonts(),
    src: src || 'main',
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('widgets:update', payload);
  }
}

function broadcastBattery() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('widget:battery', batteryState);
  }
}

async function refreshBattery() {
  if (batteryBusy) return;
  batteryBusy = true;
  let next = { hasBattery: false, percent: null, charging: false, ac: false, minutes: 0 };
  try {
    const r = await ps.runJson('battery.ps1', [], { timeout: 12000 });
    if (r.ok && r.data) {
      const d = r.data;
      next = {
        hasBattery: d.hasBattery !== false,
        percent: d.percent == null ? null : Math.max(0, Math.min(100, Number(d.percent))),
        charging: !!d.charging,
        ac: !!d.ac,
        minutes: Number(d.minutes) || 0,
      };
    }
  } catch (_) { /* 读不到就按没有电池处理 */ }
  // 电源状态以系统事件为准，比 Win32_Battery 的状态码可靠
  try { next.ac = !powerMonitor.isOnBatteryPower(); } catch (_) { /* ignore */ }
  batteryBusy = false;
  batteryState = next;
  broadcastBattery();
}

function startBatteryWatch() {
  if (!batteryBound) {
    batteryBound = true;
    try {
      powerMonitor.on('on-ac', () => { refreshBattery(); });
      powerMonitor.on('on-battery', () => { refreshBattery(); });
      powerMonitor.on('resume', () => { refreshBattery(); });
    } catch (_) { /* ignore */ }
  }
  if (!batteryTimer) batteryTimer = setInterval(() => refreshBattery(), 30000);
  refreshBattery();
}

function stopBatteryWatch() {
  if (batteryTimer) { clearInterval(batteryTimer); batteryTimer = null; }
}

/* ---------------- 元素操作 ---------------- */

function addWidgetElement(type) {
  if (!fmt.ELEMENT_DEFS[type]) return null;
  const list = widgetElements();
  const wa = workArea();
  const same = list.filter((e) => e && e.type === type).length;
  const el = fmt.createElement(type, {
    id: 'w' + uid(),
    name: same ? fmt.ELEMENT_DEFS[type].label + ' ' + (same + 1) : fmt.ELEMENT_DEFS[type].label,
    x: Math.round(wa.width / 2 - 130 + (list.length % 6) * 18),
    y: Math.round(wa.height / 2 - 40 + (list.length % 6) * 18),
  });
  list.push(el);
  saveElements(list);
  if (needsBattery()) startBatteryWatch();
  broadcastWidgets('panel');
  return el;
}

function patchWidgetElement(id, patch) {
  const el = findElement(id);
  if (!el) return null;
  applyElementPatch(el, patch);
  saveElements(widgetElements());
  if (needsBattery()) startBatteryWatch();
  else stopBatteryWatch();
  broadcastWidgets('panel');
  return el;
}

function removeWidgetElement(id) {
  const list = widgetElements();
  const next = list.filter((e) => e && e.id !== id);
  if (next.length === list.length) return false;
  saveElements(next);
  if (needsBattery()) startBatteryWatch();
  else stopBatteryWatch();
  broadcastWidgets('panel');
  return true;
}

function duplicateWidgetElement(id) {
  const list = widgetElements();
  const idx = list.findIndex((e) => e && e.id === id);
  if (idx < 0) return null;
  const copy = JSON.parse(JSON.stringify(list[idx]));
  copy.id = 'w' + uid();
  copy.name = String(copy.name || fmt.ELEMENT_DEFS[copy.type].label) + ' 副本';
  copy.x = (Number(copy.x) || 0) + 18;
  copy.y = (Number(copy.y) || 0) + 18;
  list.splice(idx + 1, 0, copy);
  saveElements(list);
  if (needsBattery()) startBatteryWatch();
  broadcastWidgets('panel');
  return copy;
}

function orderWidgetElement(id, dir) {
  const list = widgetElements();
  const idx = list.findIndex((e) => e && e.id === id);
  if (idx < 0) return false;
  const to = idx + (dir === 'up' ? -1 : 1);
  if (to < 0 || to >= list.length) return false;
  const [el] = list.splice(idx, 1);
  list.splice(to, 0, el);
  saveElements(list);
  broadcastWidgets('panel');
  return true;
}

function moveWidgetElement(id, pos) {
  const el = findElement(id);
  if (!el || !pos) return false;
  for (const k of ['x', 'y', 'w', 'h']) {
    if (pos[k] === undefined || pos[k] === null) continue;
    const n = Number(pos[k]);
    if (!Number.isFinite(n)) continue;
    el[k] = Math.round(Math.max(0, Math.min(12000, n)));
  }
  saveElements(widgetElements());
  broadcastWidgets('canvas');
  return true;
}

/** 多选一起移动 / 对齐：一次落盘、一次广播，避免 N 次重排 */
function moveWidgetElements(items) {
  if (!Array.isArray(items) || !items.length) return false;
  const list = widgetElements();
  const byId = new Map(list.filter((e) => e && e.id).map((e) => [e.id, e]));
  let touched = false;
  for (const it of items) {
    if (!it || !it.id) continue;
    const el = byId.get(it.id);
    if (!el) continue;
    for (const k of ['x', 'y', 'w', 'h']) {
      if (it[k] === undefined || it[k] === null) continue;
      const n = Number(it[k]);
      if (!Number.isFinite(n)) continue;
      el[k] = Math.round(Math.max(0, Math.min(12000, n)));
    }
    touched = true;
  }
  if (!touched) return false;
  saveElements(list);
  broadcastWidgets('canvas');
  return true;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif'];

async function pickElementImage(id) {
  const el = findElement(id);
  if (!el || el.type !== 'image') return { ok: false, error: '这个元素不是图片' };
  const r = await dialog.showOpenDialog(panelWin && !panelWin.isDestroyed() ? panelWin : undefined, {
    title: '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: IMAGE_EXT }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const saved = dsk.importImage(r.filePaths[0]);
  if (!saved) return { ok: false, error: '这个格式的图片读不了' };
  const cur = findElement(id);
  if (!cur) return { ok: false, error: '元素已经不在了' };
  cur.data = { ...(cur.data || {}), src: saved.url };
  saveElements(widgetElements());
  broadcastWidgets('panel');
  return { ok: true, src: saved.url };
}

async function importFontDialog() {
  const r = await dialog.showOpenDialog(panelWin && !panelWin.isDestroyed() ? panelWin : undefined, {
    title: '导入字体',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
  });
  if (r.canceled) return { ok: false, canceled: true, list: dsk.listFonts() };
  const added = [];
  for (const p of r.filePaths || []) {
    const f = dsk.importFont(p);
    if (f) added.push(f);
  }
  if (added.length) broadcastWidgets('main');
  return { ok: true, added, list: dsk.listFonts() };
}

async function applyImportedPreset() {
  const r = await dsk.importPreset(panelWin);
  if (!r.ok) return r;
  const incoming = r.elements.map((raw) => {
    const el = fmt.normalizeElement(raw);
    el.id = 'w' + uid();
    return el;
  });
  const list = r.mode === 'append' ? widgetElements().concat(incoming) : incoming;
  saveElements(list);
  if (needsBattery()) startBatteryWatch();
  else stopBatteryWatch();
  broadcastWidgets('main');
  broadcast();
  return { ok: true, mode: r.mode, count: incoming.length, name: r.name };
}

function resetWidgetElements() {
  const list = (store.DEFAULTS.widgets.elements || []).map((raw) => {
    const el = fmt.normalizeElement(raw);
    el.id = 'w' + uid();
    return el;
  });
  saveElements(list);
  if (needsBattery()) startBatteryWatch();
  else stopBatteryWatch();
  broadcastWidgets('main');
  return list.length;
}

let popupWatcher = null;
let popupShownAt = 0;

function stopPopupWatcher() {
  if (popupWatcher) { clearInterval(popupWatcher); popupWatcher = null; }
}

/** 鼠标离开弹窗与 Dock 之后自动收起（弹窗不抢焦点，blur 不可靠） */
function startPopupWatcher(win) {
  stopPopupWatcher();
  if (process.argv.includes('--capture')) return;
  popupShownAt = Date.now();
  popupWatcher = setInterval(() => {
    if (!popupWin || popupWin.isDestroyed() || popupWin !== win) { stopPopupWatcher(); return; }
    if (Date.now() - popupShownAt < 420) return;
    let pt;
    try { pt = screen.getCursorScreenPoint(); } catch (_) { return; }
    const inside = (b) => pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
    try {
      if (inside(win.getBounds())) return;
      if (dockWin && !dockWin.isDestroyed() && inside(dockWin.getBounds())) return;
      if (panelWin && !panelWin.isDestroyed() && inside(panelWin.getBounds())) return;
    } catch (_) { return; }
    closePopup();
  }, 200);
}

function createPopup(params, anchorRect) {
  // 先销毁旧窗口，避免它的 closed 回调把新窗口的 params 清空
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.removeAllListeners('closed');
    popupWin.destroy();
    popupWin = null;
  }
  stopPopupWatcher();
  popupParams = params;

  const wa = screen.getDisplayNearestPoint({ x: anchorRect.cx, y: anchorRect.cy }).workArea;
  const W = params.kind === 'archive' ? 700 : 600;
  const H = params.kind === 'archive' ? 520 : 420;
  let x = Math.round(anchorRect.cx - W / 2);
  let y = Math.round(anchorRect.cy - H - 16);
  x = Math.max(wa.x + 12, Math.min(x, wa.x + wa.width - W - 12));
  if (y < wa.y + 12) y = Math.round(anchorRect.cy + 24);

  const win = new BrowserWindow({
    x, y, width: W, height: H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  popupWin = win;
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(RENDERER, 'popup.html'));
  attachDiagnostics(win, 'popup');
  win.once('ready-to-show', () => {
    // 用 show() 而不是 showInactive()：搜索框要能输入、Esc 要能关闭
    win.show();
    win.focus();
    startPopupWatcher(win);
  });
  win.on('closed', () => {
    if (popupWin === win) {
      popupWin = null;
      popupParams = null;
      stopPopupWatcher();
    }
  });
}

function closePopup() {
  stopPopupWatcher();
  if (popupWin && !popupWin.isDestroyed()) popupWin.close();
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function buildTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON_FILE).resize({ width: 32, height: 32 }));
  tray.setToolTip('DeskGlow 桌面美化');
  updateTrayMenu();
  // 左键单击托盘图标直接打开控制面板
  tray.on('click', () => { reviveDock(); createPanel(); });
  tray.on('double-click', () => { reviveDock(); createPanel(); });
}

function updateTrayMenu() {
  if (!tray) return;
  const s = store.get();
  const menu = Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => createPanel() },
    { type: 'separator' },
    {
      label: s.ui.dockVisible === false ? '显示 Dock' : '隐藏 Dock',
      click: () => showDock(s.ui.dockVisible === false),
    },
    {
      label: '显示小组件',
      type: 'checkbox',
      checked: s.widgets.enabled !== false,
      click: (mi) => {
        store.set({ widgets: { enabled: mi.checked } });
        applyWidgetSettings();
        broadcast();
      },
    },
    {
      label: widgetEdit ? '退出编辑小组件' : '编辑小组件',
      click: () => setWidgetEdit(!widgetEdit),
    },
    { label: '扫描桌面', click: () => scanPrompt() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: loginItemEnabled(),
      click: (mi) => {
        setLoginItem(mi.checked);
        broadcast();
      },
    },
    { type: 'separator' },
    { label: '安装更新包', click: () => update.applyFromDialog() },
    { label: '退出 DeskGlow', click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

/* ------------------------------------------------------------------ */
/* 操作                                                                */
/* ------------------------------------------------------------------ */

async function rescan(notify = false) {
  vault.ensure();
  refreshDesktop();
  // 先把被移动过的快捷方式路径修好（否则 Dock 上会一片灰色）
  const healed = healPaths();
  await refreshInspect();

  const s = store.get();
  const removed = new Set((s.removedPaths || []).map((p) => p.toLowerCase()));
  const known = new Set();
  for (const it of s.items) {
    if (it.kind === 'app') known.add(it.path.toLowerCase());
    if (it.kind === 'group') for (const c of it.children || []) known.add(c.path.toLowerCase());
  }

  let added = 0;
  const archiveIdx = s.items.findIndex((i) => i.kind === 'archive');
  const fresh = [];
  for (const e of desktopEntries) {
    if (!e.isShortcut) continue;
    const key = e.path.toLowerCase();
    if (known.has(key) || removed.has(key)) continue;
    fresh.push({ id: uid(), kind: 'app', name: e.name, path: e.path });
    known.add(key);
    added++;
  }
  if (fresh.length) {
    if (archiveIdx >= 0) s.items.splice(archiveIdx, 0, ...fresh);
    else s.items.push(...fresh);
  }

  // 移除不存在的条目（保留分组结构）；文件收纳图标始终留在最后
  s.items = s.items
    .map((it) => {
      if (it.kind === 'group') {
        const children = (it.children || []).filter((c) => fs.existsSync(c.path));
        return { ...it, children };
      }
      return it;
    })
    .filter((it) => it.kind !== 'group' || (it.children || []).length > 0);
  ensureArchiveItem();

  store.save(true);
  await warmIcons();
  broadcast();
  if (notify && panelWin) {
    const extra = healed > 0 ? `，修复 ${healed} 个失效路径` : '';
    panelWin.webContents.send('toast', { type: 'ok', text: `扫描完成，新增 ${added} 个快捷方式${extra}` });
  }
  return { added, healed };
}

function shortcutRefs() {
  const list = [];
  const s = store.get();
  for (const it of s.items || []) {
    if (it.kind === 'app') list.push(it);
    if (it.kind === 'group') for (const c of it.children || []) list.push(c);
  }
  return list;
}

/** 对照当前桌面，找出新出现的和已经失效的快捷方式。不改 Dock。 */
function scanDiff() {
  const s = store.get();
  const removed = new Set((s.removedPaths || []).map((p) => String(p).toLowerCase()));
  const known = new Set(shortcutRefs().map((it) => String(it.path || '').toLowerCase()).filter(Boolean));
  const added = [];
  const seen = new Set();
  for (const e of desktopEntries) {
    if (!e.isShortcut) continue;
    const key = e.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (known.has(key) || removed.has(key)) continue;
    added.push({ name: e.name, path: e.path });
  }
  const missing = [];
  for (const it of shortcutRefs()) {
    if (!it.path || fs.existsSync(it.path)) continue;
    missing.push({ name: it.name || path.basename(it.path), path: it.path });
  }
  return { added, missing };
}

function insertFresh(items) {
  if (!items.length) return;
  const s = store.get();
  const archIdx = s.items.findIndex((i) => i.kind === 'archive');
  if (archIdx >= 0) s.items.splice(archIdx, 0, ...items);
  else s.items.push(...items);
}

async function applyScan(mode) {
  const s = store.get();
  if (mode === 'replace') {
    s.removedPaths = (s.removedPaths || []).filter((p) => !fs.existsSync(p));
  }
  const removed = new Set((s.removedPaths || []).map((p) => String(p).toLowerCase()));
  const known = new Set();
  for (const it of s.items) {
    if (it.kind === 'app' && it.path) known.add(it.path.toLowerCase());
    if (it.kind === 'group') for (const c of it.children || []) if (c.path) known.add(c.path.toLowerCase());
  }
  const fresh = [];
  for (const e of desktopEntries) {
    if (!e.isShortcut) continue;
    const key = e.path.toLowerCase();
    if (known.has(key) || removed.has(key)) continue;
    fresh.push({ id: uid(), kind: 'app', name: e.name, path: e.path });
    known.add(key);
  }
  insertFresh(fresh);
  let removedCount = 0;
  if (mode === 'replace') {
    const before = shortcutRefs().length;
    s.items = s.items
      .map((it) => {
        if (it.kind !== 'group') return it;
        const children = (it.children || []).filter((c) => c.path && fs.existsSync(c.path));
        return { ...it, children };
      })
      .filter((it) => {
        if (it.kind === 'group') return (it.children || []).length > 0;
        if (it.kind === 'app') return it.path && fs.existsSync(it.path);
        return true;
      });
    removedCount = Math.max(0, before - shortcutRefs().length);
  }
  ensureArchiveItem();
  store.save(true);
  await warmIcons();
  broadcast();
  return { added: fresh.length, removed: removedCount };
}

function toastPanel(text, type = 'ok') {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('toast', { type, text });
}

async function scanPrompt() {
  vault.ensure();
  refreshDesktop();
  const healed = healPaths();
  if (healed) store.save(true);
  await refreshInspect();
  const diff = scanDiff();
  if (!diff.added.length && !diff.missing.length) {
    if (healed) broadcast();
    toastPanel(healed ? `已修好 ${healed} 个路径` : '没有变化');
    return { mode: 'none', added: 0, missing: 0, healed };
  }
  const parent = panelWin && !panelWin.isDestroyed() ? panelWin : undefined;
  const box = (opts) => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));
  const choice = await box({
    type: 'question',
    buttons: ['只调整新增', '完全替换', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: '扫描桌面',
    message: `新增 ${diff.added.length} 个，失效 ${diff.missing.length} 个`,
    detail: '只调整新增：加上新图标，其余保持不动。\n完全替换：关掉的图标会重新出现，失效的会从 Dock 移除。\n文件夹里的文件不会被删除。',
  });
  if (choice.response === 2) return { mode: 'cancel', added: diff.added.length, missing: diff.missing.length };
  if (choice.response === 1) {
    const warn = await box({
      type: 'warning',
      buttons: ['继续替换', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '完全替换',
      message: 'Dock 上的显示会按当前桌面重排',
      detail: '你关掉的快捷方式会重新出现，失效图标会从 Dock 移除。分组会保留。文件不会从文件夹删除。',
    });
    if (warn.response !== 0) return { mode: 'cancel' };
    const r = await applyScan('replace');
    toastPanel(`已替换，加入 ${r.added} 个，移除 ${r.removed} 个`);
    return { mode: 'replace', ...r, healed };
  }
  const r = await applyScan('add');
  toastPanel(r.added ? `已加入 ${r.added} 个` : '没有需要新增的图标');
  return { mode: 'add', ...r, healed };
}

const taskbarPath = () => app.getPath('userData');

const LOGIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LOGIN_RUN_NAME = 'DeskGlow';

function quoteCmd(s) {
  return '"' + String(s).replace(/"/g, '') + '"';
}

/**
 * 开机要走「启动 DeskGlow.vbs」。
 * 直接登记 electron.exe 会跳过 launch.js：本机需要先清掉 ELECTRON_RUN_AS_NODE，
 * 并在 .compat 存在时带上 --no-sandbox，否则进程会秒退，看起来就像没自启。
 */
function loginCommandLine() {
  const root = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  const vbs = path.join(root, '启动 DeskGlow.vbs');
  if (!app.isPackaged && fs.existsSync(vbs)) {
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    return `${quoteCmd(wscript)} //B //Nologo ${quoteCmd(vbs)}`;
  }
  const args = relaunchArgs().map(quoteCmd).join(' ');
  return args ? `${quoteCmd(process.execPath)} ${args}` : quoteCmd(process.execPath);
}

let loginItemCache = null;

function loginItemEnabled() {
  if (loginItemCache !== null) return loginItemCache;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg.exe', ['query', LOGIN_RUN_KEY, '/v', LOGIN_RUN_NAME], {
      windowsHide: true,
      encoding: 'utf8',
    });
    loginItemCache = /REG_SZ/i.test(out);
    return loginItemCache;
  } catch (_) {
    loginItemCache = false;
    return false;
  }
}

function runPowerShell(script) {
  const { execFileSync } = require('child_process');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
  });
}

/** 开机自启写在当前用户的 Run 项里，不依赖 Electron 的登录项（未打包时它对不上真实启动命令） */
function setLoginItem(enable) {
  loginItemCache = null;
  const { execFileSync } = require('child_process');
  try {
    if (!enable) {
      execFileSync('reg.exe', ['delete', LOGIN_RUN_KEY, '/v', LOGIN_RUN_NAME, '/f'], { windowsHide: true });
      return false;
    }
    const cmd = loginCommandLine().replace(/'/g, "''");
    runPowerShell(
      `New-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${LOGIN_RUN_NAME}' -Value '${cmd}' -PropertyType String -Force | Out-Null`
    );
    // 02 00 … 表示「允许启动」，避免被系统启动项审批默默关掉
    execFileSync('reg.exe', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
      '/v', LOGIN_RUN_NAME, '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f',
    ], { windowsHide: true });
  } catch (e) {
    console.warn('[loginItem]', e.message);
  }
  return loginItemEnabled();
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => ({
    state: buildState(),
    taskbar: taskbarStatusCache || await taskbar.status(),
    loginItem: loginItemEnabled(),
  }));

  // Dock 首屏不走 app:bootstrap：那边会启动 PowerShell 查任务栏，图标要等它结束才画出来。
  ipcMain.handle('dock:state', () => buildDockState(false));
  ipcMain.handle('dock:painted', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== dockWin) return false;
    noteDockContentReady(win._gen);
    return true;
  });

  ipcMain.handle('state:get', () => buildState());

  ipcMain.handle('dock:measure', (e, size) => {
    if (!size || !size.w || !size.h) return;
    // 只记页面想要的尺寸。按当前工作区收窄在 dockTarget 里做，
    // 开机时工作区偏小，把收窄结果写回来的话，任务栏出来后坞也长不回去。
    lastDockSize = {
      w: Math.max(Math.ceil(size.w), 240),
      h: Math.max(Math.ceil(size.h), 64),
      shpad: Math.max(0, Math.ceil(Number(size.shpad) || 0)),
    };
    positionDock();
  });

  ipcMain.handle('dock:hover', () => {
    // 鼠标穿透只由 startDockHoverWatch 管理。
    // 以前收起后再把穿透关掉，自动隐藏大约 0.7 秒后就会失效。
    return true;
  });

  ipcMain.handle('dock:hitbox', (e, box) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== dockWin) return false;
    if (!box || !(box.w > 1) || !(box.h > 1)) { dockHit = null; return false; }
    dockHit = {
      x: Number(box.x) || 0,
      y: Number(box.y) || 0,
      w: Number(box.w) || 0,
      h: Number(box.h) || 0,
      pageW: Number(box.pageW) || 0,
      pageH: Number(box.pageH) || 0,
    };
    return true;
  });

  // 同步：移出玻璃条的同一轮鼠标消息里就要穿透，否则这次右键仍被窗口吃掉
  ipcMain.on('dock:passthrough', (e, pass) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== dockWin) { e.returnValue = false; return; }
    if (dockHolding) { setMousePass(false); e.returnValue = true; return; }
    if (store.get().appearance.autoHide === true && !dockHot) { e.returnValue = true; return; }
    setMousePass(!!pass);
    e.returnValue = true;
  });

  ipcMain.on('dock:hold', (e, on) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== dockWin) { e.returnValue = false; return; }
    dockHolding = !!on;
    if (dockHolding) setMousePass(false);
    e.returnValue = true;
  });

  ipcMain.handle('dock:open', async (e, id) => {
    const s = store.get();
    const it = s.items.find((i) => i.id === id);
    if (!it) return { ok: false };
    if (it.kind === 'app') {
      closePopup();
      return sc.launch(it.path);
    }
    // 计算图标中心点，用于弹窗定位
    const b = dockWin.getBounds();
    let cx = b.x + b.width / 2;
    let cy = b.y;
    if (it.kind === 'archive') cx = b.x + b.width - 60;
    return { ok: true, kind: it.kind, id: it.id, anchor: { cx, cy } };
  });

  ipcMain.handle('popup:open', (e, params) => {
    const b = dockWin.getBounds();
    createPopup(params, params.anchor || { cx: b.x + b.width / 2, cy: b.y });
    return true;
  });

  ipcMain.handle('popup:close', () => { closePopup(); return true; });

  ipcMain.handle('popup:fit', (e, h) => {
    if (!popupWin || popupWin.isDestroyed()) return false;
    const b = popupWin.getBounds();
    const nh = Math.min(Math.max(Math.round(h), 250), 660);
    if (Math.abs(nh - b.height) < 4) return true;
    popupWin.setBounds({ x: b.x, y: b.y + b.height - nh, width: b.width, height: nh });
    return true;
  });

  ipcMain.handle('popup:params', () => popupParams);

  ipcMain.handle('item:launch', async (e, target) => sc.launch(target));

  ipcMain.handle('item:reveal', (e, target) => {
    try { shell.showItemInFolder(target); return true; } catch { return false; }
  });

  ipcMain.handle('item:menu', (e, id) => {
    const s = store.get();
    const it = s.items.find((i) => i.id === id);
    if (!it) return false;
    const isApp = it.kind === 'app';
    const template = [];
    if (isApp) template.push({ label: '打开', click: () => sc.launch(it.path) });
    else {
      template.push({
        label: '展开',
        click: () => {
          const b = dockWin.getBounds();
          createPopup({ kind: it.kind, id: it.id }, { cx: b.x + b.width / 2, cy: b.y });
        },
      });
    }
    if (it.kind === 'group') {
      template.push({
        label: '重命名分组',
        click: () => focusPanelTab('groups'),
      });
      template.push({
        label: '解散分组',
        click: () => {
          const idx = s.items.findIndex((i) => i.id === it.id);
          clearGroupIconFile(it);
          const kids = (it.children || []).map((c) => ({ ...c, id: c.id || uid(), kind: 'app' }));
          s.items.splice(idx, 1, ...kids);
          store.save(true); broadcast();
        },
      });
    }
    if (isApp) {
      template.push({ type: 'separator' });
      template.push({ label: '在资源管理器中显示', click: () => shell.showItemInFolder(it.path) });
      template.push({ label: '从 Dock 移除', click: () => removeItem(it.id) });
    }
    if (it.kind === 'archive') {
      template.push({ type: 'separator' });
      template.push({ label: '文件收纳设置', click: () => focusPanelTab('archive') });
    }
    template.push({ type: 'separator' });
    template.push({ label: '控制面板', click: () => createPanel() });
    popupMenu(dockWin, template);
    return true;
  });

  ipcMain.handle('dock:menu', () => {
    const s = store.get();
    popupMenu(dockWin, [
      { label: '打开控制面板', click: () => createPanel() },
      { label: '扫描桌面', click: () => scanPrompt() },
      { type: 'separator' },
      {
        label: '自动隐藏 Dock',
        type: 'checkbox',
        checked: !!s.appearance.autoHide,
        click: (mi) => { s.appearance.autoHide = mi.checked; store.save(true); broadcast(); },
      },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuiting = true; app.quit(); } },
    ]);
    return true;
  });

  ipcMain.handle('items:move', (e, { id, targetId, after }) => {
    const s = store.get();
    const from = s.items.findIndex((i) => i.id === id);
    if (from < 0) return false;
    const [moved] = s.items.splice(from, 1);
    if (moved.kind === 'archive') {
      s.items.push(moved);
      store.save(true);
      broadcast();
      return true;
    }
    let to = targetId ? s.items.findIndex((i) => i.id === targetId) : s.items.length;
    if (to < 0) to = s.items.length;
    if (after) to += 1;
    const archIdx = s.items.findIndex((i) => i.kind === 'archive');
    if (archIdx >= 0 && to > archIdx) to = archIdx;
    s.items.splice(to, 0, moved);
    store.save(true);
    broadcast();
    return true;
  });

  ipcMain.handle('items:toGroup', (e, { itemId, groupId }) => {
    const s = store.get();
    if (!itemId || itemId === groupId) return false;
    const gi = s.items.findIndex((i) => i.id === groupId && i.kind === 'group');
    if (gi < 0) return false;
    const fromIdx = s.items.findIndex((i) => i.id === itemId);
    if (fromIdx < 0) return false;
    const group = s.items[gi];
    const from = s.items[fromIdx];

    if (from.kind === 'app') {
      s.items.splice(fromIdx, 1);
      group.children.push({ id: uid(), name: from.name, path: from.path });
    } else if (from.kind === 'group') {
      for (const c of from.children || []) group.children.push({ id: uid(), name: c.name, path: c.path });
      clearGroupIconFile(from);
      s.items.splice(fromIdx, 1);
    } else {
      return false;
    }
    store.save(true);
    warmIcons().then(broadcast);
    broadcast();
    return true;
  });

  ipcMain.handle('group:create', (e, { name, itemIds = [] }) => {
    const s = store.get();
    const children = [];
    for (const id of itemIds) {
      const idx = s.items.findIndex((i) => i.id === id);
      if (idx < 0) continue;
      const it = s.items[idx];
      if (it.kind === 'app') children.push({ id: uid(), name: it.name, path: it.path });
      else if (it.kind === 'group') {
        for (const c of it.children || []) children.push({ id: uid(), name: c.name, path: c.path });
        clearGroupIconFile(it);
      } else continue;
      s.items.splice(idx, 1);
    }
    if (!children.length) return false;
    const group = { id: uid(), kind: 'group', name: name || '新建分组', children };
    const archIdx = s.items.findIndex((i) => i.kind === 'archive');
    if (archIdx >= 0) s.items.splice(archIdx, 0, group);
    else s.items.push(group);
    store.save(true);
    warmIcons().then(broadcast);
    broadcast();
    return group.id;
  });

  ipcMain.handle('group:rename', (e, { id, name }) => {
    const s = store.get();
    const it = s.items.find((i) => i.id === id);
    if (!it) return false;
    it.name = name;
    store.save(true); broadcast();
    return true;
  });

  ipcMain.handle('group:setIcon', (e, { id, icon }) => setGroupIcon(id, icon || ''));

  ipcMain.handle('group:importIcon', (e, id) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const parent = win && !win.isDestroyed() && win !== dockWin
      ? win
      : (panelWin && !panelWin.isDestroyed() ? panelWin : null);
    return importGroupIcon(id, parent);
  });

  ipcMain.handle('group:delete', (e, { id, keepChildren }) => {
    const s = store.get();
    const idx = s.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const it = s.items[idx];
    if (it.kind === 'group') clearGroupIconFile(it);
    const kids = (it.children || []).map((c) => ({ id: uid(), kind: 'app', name: c.name, path: c.path }));
    if (keepChildren && kids.length) s.items.splice(idx, 1, ...kids);
    else s.items.splice(idx, 1);
    store.save(true); broadcast();
    return true;
  });

  ipcMain.handle('group:reorder', (e, { groupId, ids }) => {
    const s = store.get();
    const g = s.items.find((i) => i.id === groupId && i.kind === 'group');
    if (!g || !Array.isArray(ids)) return false;
    const map = new Map((g.children || []).map((c) => [c.id, c]));
    const next = [];
    for (const id of ids) {
      const c = map.get(id);
      if (!c || next.includes(c)) continue;
      next.push(c);
    }
    for (const c of g.children || []) if (!next.includes(c)) next.push(c);
    g.children = next;
    store.save(true);
    broadcast();
    return true;
  });

  ipcMain.handle('group:removeChild', (e, { groupId, childId, toDock }) => {
    const s = store.get();
    const gi = s.items.findIndex((i) => i.id === groupId);
    if (gi < 0) return false;
    const g = s.items[gi];
    const ci = (g.children || []).findIndex((c) => c.id === childId);
    if (ci < 0) return false;
    const [child] = g.children.splice(ci, 1);
    if (toDock) {
      s.items.splice(gi, 0, { id: uid(), kind: 'app', name: child.name, path: child.path });
    }
    store.save(true); broadcast();
    return true;
  });

  ipcMain.handle('items:remove', (e, id) => removeItem(id));

  ipcMain.handle('items:confirmRemove', async (e, id) => {
    const s = store.get();
    const it = s.items.find((i) => i.id === id);
    if (!it || it.kind === 'archive') return false;
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const box = (opts) => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));
    const r = await box({
      type: 'question',
      buttons: ['移出', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '移出 Dock',
      message: `移出「${it.name || '这个图标'}」？`,
      detail: '文件会留在快捷方式文件夹里，可以随时在「快捷方式」里重新打开。',
    });
    if (r.response !== 0) return false;
    return removeItem(id);
  });

  ipcMain.handle('items:center', (e, id) => {
    const s = store.get();
    const idx = s.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const [moved] = s.items.splice(idx, 1);
    if (moved.kind === 'archive') {
      s.items.push(moved);
    } else {
      const archIdx = s.items.findIndex((i) => i.kind === 'archive');
      const limit = archIdx >= 0 ? archIdx : s.items.length;
      s.items.splice(Math.floor(limit / 2), 0, moved);
    }
    store.save(true);
    broadcast();
    return true;
  });

  ipcMain.handle('items:pickGroup', (e, itemId) => {
    const s = store.get();
    const it = s.items.find((i) => i.id === itemId);
    if (!it || it.kind === 'archive') return false;
    const groups = s.items.filter((i) => i.kind === 'group' && i.id !== itemId);
    const template = groups.map((g) => ({
      label: g.name || '未命名',
      click: () => {
        const cur = store.get();
        const gi = cur.items.findIndex((i) => i.id === g.id && i.kind === 'group');
        const fromIdx = cur.items.findIndex((i) => i.id === itemId);
        if (gi < 0 || fromIdx < 0) return;
        const group = cur.items[gi];
        const from = cur.items[fromIdx];
        if (from.kind === 'app') {
          cur.items.splice(fromIdx, 1);
          group.children.push({ id: uid(), name: from.name, path: from.path });
        } else if (from.kind === 'group') {
          for (const c of from.children || []) group.children.push({ id: uid(), name: c.name, path: c.path });
          clearGroupIconFile(from);
          const idx = cur.items.findIndex((i) => i.id === from.id);
          if (idx >= 0) cur.items.splice(idx, 1);
        } else return;
        store.save(true);
        warmIcons().then(broadcast);
        broadcast();
      },
    }));
    template.push({ type: 'separator' });
    template.push({
      label: '新建分组',
      click: () => {
        const cur = store.get();
        const fromIdx = cur.items.findIndex((i) => i.id === itemId);
        if (fromIdx < 0) return;
        const from = cur.items[fromIdx];
        const children = [];
        if (from.kind === 'app') children.push({ id: uid(), name: from.name, path: from.path });
        else if (from.kind === 'group') {
          for (const c of from.children || []) children.push({ id: uid(), name: c.name, path: c.path });
          clearGroupIconFile(from);
        } else return;
        cur.items.splice(fromIdx, 1);
        const group = { id: uid(), kind: 'group', name: '新建分组', children };
        const archIdx = cur.items.findIndex((i) => i.kind === 'archive');
        if (archIdx >= 0) cur.items.splice(archIdx, 0, group);
        else cur.items.push(group);
        store.save(true);
        broadcast();
      },
    });
    popupMenu(BrowserWindow.fromWebContents(e.sender) || panelWin, template);
    return true;
  });

  ipcMain.handle('items:add', async (e, paths) => {
    const s = store.get();
    const taken = takenPaths(s.items);
    let added = 0;
    for (const p of paths || []) {
      if (!p) continue;
      const key = String(p).toLowerCase();
      if (taken.has(key)) continue;
      const entry = entryByPath(p) || { path: p, name: path.basename(p, path.extname(p)) };
      insertBeforeArchive(s.items, { id: uid(), kind: 'app', name: entry.name, path: p });
      taken.add(key);
      s.removedPaths = (s.removedPaths || []).filter((x) => x.toLowerCase() !== key);
      added++;
    }
    store.save(true);
    await warmIcons();
    broadcast();
    return added;
  });

  ipcMain.handle('scan:list', async () => {
    refreshDesktop();
    return desktopEntries
      .filter((e) => e.isShortcut)
      .map((e) => ({ ...e, icon: iconUrl(e.path) }));
  });

  ipcMain.handle('archive:list', () => archiveList().map((e) => ({ ...e, icon: iconUrl(e.path) })));

  ipcMain.handle('archive:reorder', (e, { paths }) => {
    if (!Array.isArray(paths) || !paths.length) return false;
    const s = store.get();
    const low = (p) => String(p).toLowerCase();
    const full = archiveList().map((item) => item.path);
    const set = new Set(paths.map(low));
    let i = 0;
    const next = full.map((p) => (set.has(low(p)) ? paths[i++] : p));
    while (i < paths.length) next.push(paths[i++]);
    s.archive.order = next;
    store.save(true);
    archiveCache = null;
    broadcast();
    return true;
  });

  /** 把文件移动进 DeskGlow\文件收纳（拖进「文件合集」= 放进软件文件夹） */
  ipcMain.handle('archive:addFiles', async (e, paths) => {
    const dir = vault.dirs().archive;
    vault.ensure();
    let moved = 0;
    const skipped = [];
    for (const p of paths || []) {
      if (!p) continue;
      try {
        const st = fs.statSync(p);
        if (!st) continue;
        if (path.dirname(p).toLowerCase() === dir.toLowerCase()) { skipped.push(p); continue; }
        vault.moveInto(dir, p);
        moved++;
      } catch (_) { skipped.push(p); }
    }
    if (moved) {
      refreshDesktop();
      await refreshInspect();
      await warmIcons();
    }
    broadcast();
    return { moved, skipped };
  });

  ipcMain.handle('vault:open', (e, which) => vault.open(which || 'root'));

  /** 把桌面上的普通文件 / 文件夹收进 DeskGlow\文件收纳，桌面就干净了 */
  ipcMain.handle('vault:importFiles', async () => {
    const s = store.get();
    const r = vault.importDesktopFiles({ includeFolders: s.archive.includeFolders !== false });
    refreshDesktop();
    healPaths();
    await refreshInspect();
    await warmIcons();
    store.save(true);
    broadcast();
    return r;
  });

  /** 把桌面上的快捷方式收进 DeskGlow\快捷方式，桌面就干净了 */
  ipcMain.handle('vault:importShortcuts', async () => {
    const r = vault.importDesktopShortcuts();
    refreshDesktop();
    healPaths();
    await refreshInspect();
    await warmIcons();
    store.save(true);
    broadcast();
    return r.moved;
  });

  ipcMain.handle('settings:patch', async (e, patch) => {
    store.set(patch);
    if (patch && patch.appearance && patch.appearance.autoHide === false && dockWin) {
      dockWin.setIgnoreMouseEvents(false);
      autoHideIgnored = false;
      mousePass = false;
      dockHot = false;
    }
    if (patch && patch.appearance) {
      positionDock();
      if (patch.appearance.autoHide === true && dockWin) {
        dockWin.setIgnoreMouseEvents(false);
        autoHideIgnored = false;
        mousePass = false;
        dockHot = false;
      }
    }
    const keys = patch ? Object.keys(patch) : [];
    const onlyAppearance = keys.length === 1 && keys[0] === 'appearance';
    if (patch && patch.archive) {
      refreshDesktop();
      await warmIcons();
    }
    if (patch && patch.widgets) {
      applyWidgetSettings();
    }
    if (onlyAppearance) broadcastAppearance();
    else broadcast();
    return true;
  });

  /* ---------------- 小组件 ---------------- */
  ipcMain.handle('widget:state', () => ({ ...widgetState(), fonts: dsk.listFonts() }));
  ipcMain.handle('widget:battery:get', () => batteryState);
  ipcMain.handle('widget:edit', (e, on) => setWidgetEdit(on));
  ipcMain.handle('widget:element:add', (e, p) => addWidgetElement(p && p.type));
  ipcMain.handle('widget:element:patch', (e, p) => (p ? patchWidgetElement(p.id, p.patch) : null));
  ipcMain.handle('widget:element:remove', (e, p) => (p ? removeWidgetElement(p.id) : false));
  ipcMain.handle('widget:element:duplicate', (e, p) => (p ? duplicateWidgetElement(p.id) : null));
  ipcMain.handle('widget:element:order', (e, p) => (p ? orderWidgetElement(p.id, p.dir) : false));
  ipcMain.handle('widget:element:move', (e, p) => (p ? moveWidgetElement(p.id, p) : false));
  ipcMain.handle('widget:elements:move', (e, p) => (p ? moveWidgetElements(p.items) : false));
  ipcMain.handle('widget:element:image', (e, p) => pickElementImage(p && p.id));
  ipcMain.handle('widget:reset', () => resetWidgetElements());

  ipcMain.handle('font:list', () => ({ system: fonts.listInstalled(), custom: dsk.listFonts() }));
  ipcMain.handle('font:import', () => importFontDialog());

  ipcMain.handle('preset:export', () => dsk.exportPreset(panelWin, widgetConfig()));
  ipcMain.handle('preset:import', () => applyImportedPreset());

  ipcMain.handle('taskbar:status', () => taskbar.status());  ipcMain.handle('taskbar:action', async (e, action) => {
    const r = await taskbar.action(action);
    broadcast();
    return r;
  });

  ipcMain.handle('panel:open', () => { createPanel(); return true; });

  ipcMain.handle('win:minimize', (e) => e.sender.getOwnerBrowserWindow()?.minimize() || BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

  ipcMain.handle('app:openConfigDir', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:loginItem', (e, enable) => {
    const v = setLoginItem(enable);
    updateTrayMenu();
    broadcast();
    return v;
  });
  ipcMain.handle('app:restart', () => {
    app.relaunch({ args: relaunchArgs({ keepDevFlags: true }) });
    app.exit(0);
  });
  ipcMain.handle('app:applyUpdate', (e) => update.applyFromDialog(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('app:quit', () => { app.isQuiting = true; app.quit(); });

  ipcMain.handle('dock:show', (e, show) => {
    showDock(!!show);
    broadcast();
    return true;
  });

  ipcMain.handle('scan:prompt', () => scanPrompt());
  ipcMain.handle('scan:refresh', () => scanPrompt());

  ipcMain.handle('child:menu', (e, { groupId, childId }) => {
    const s = store.get();
    const g = s.items.find((i) => i.id === groupId);
    if (!g) return false;
    const c = (g.children || []).find((x) => x.id === childId);
    if (!c) return false;
    popupMenu(popupWin || dockWin, [
      { label: '打开', click: () => sc.launch(c.path) },
      { label: '在资源管理器中显示', click: () => shell.showItemInFolder(c.path) },
      { type: 'separator' },
      {
        label: '移出分组（放回 Dock）',
        click: async () => {
          const gi = s.items.findIndex((i) => i.id === groupId);
          const idx = (g.children || []).findIndex((x) => x.id === childId);
          if (gi < 0 || idx < 0) return;
          const [child] = g.children.splice(idx, 1);
          s.items.splice(gi, 0, { id: uid(), kind: 'app', name: child.name, path: child.path });
          store.save(true);
          await warmIcons();
          broadcast();
        },
      },
      {
        label: '从分组删除',
        click: () => {
          g.children = (g.children || []).filter((x) => x.id !== childId);
          if (!g.children.length) {
            s.items = s.items.filter((i) => i.id !== groupId);
          }
          store.save(true);
          broadcast();
        },
      },
    ]);
    return true;
  });

  ipcMain.handle('file:menu', (e, p) => {
    popupMenu(popupWin || dockWin, [
      { label: '打开', click: () => sc.launch(p) },
      { label: '在资源管理器中显示', click: () => shell.showItemInFolder(p) },
      { type: 'separator' },
      { label: '复制路径', click: () => require('electron').clipboard.writeText(p) },
    ]);
    return true;
  });

  ipcMain.handle('dialog:pickFiles', async (e) => {
    const r = await dialog.showOpenDialog(panelWin || undefined, {
      title: '选择要添加到 Dock 的程序',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '程序/快捷方式', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:pickArchiveFiles', async (e) => {
    const r = await dialog.showOpenDialog(popupWin && !popupWin.isDestroyed() ? popupWin : panelWin || undefined, {
      title: '选择要放进「文件收纳」的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });
}

function removeItem(id) {
  const s = store.get();
  const idx = s.items.findIndex((i) => i.id === id);
  if (idx < 0) return false;
  const it = s.items[idx];
  if (it.kind === 'archive') return false;
  const hide = [];
  if (it.kind === 'app' && it.path) hide.push(it.path);
  if (it.kind === 'group') {
    for (const c of it.children || []) if (c && c.path) hide.push(c.path);
    clearGroupIconFile(it);
  }
  if (hide.length) s.removedPaths = [...new Set([...(s.removedPaths || []), ...hide])];
  s.items.splice(idx, 1);
  store.save(true);
  broadcast();
  return true;
}

/* ------------------------------------------------------------------ */
/* 开发自检：--capture 逐窗口截图                                        */
/* ------------------------------------------------------------------ */
async function devCapture() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = path.join(process.cwd(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const shoot = async (win, name) => {
    if (!win || win.isDestroyed()) return;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, name), img.toPNG());
      console.log('[capture]', name);
    } catch (e) {
      console.log('[capture failed]', name, e.message);
    }
  };

  await wait(4000);
  await shoot(dockWin, 'dock.png');

  // 模拟鼠标悬停，验证准星放大
  try {
    const diag = await dockWin.webContents.executeJavaScript(`(async () => {
      const els = document.querySelectorAll('.item');
      const el = els[Math.min(8, els.length - 1)];
      if (!el) return 'no-item';
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      await new Promise((res) => setTimeout(res, 600));
      const around = Array.from(els).slice(6, 12).map((n) => ({
        s: n.style.getPropertyValue('--s'),
        tx: n.style.getPropertyValue('--tx'),
      }));
      return JSON.stringify({ n: els.length, around, barW: document.getElementById('bar').style.width });
    })()`);
    console.log('[capture] hover', diag);
    await wait(300);
    await shoot(dockWin, 'dock-hover.png');
  } catch (e) {
    console.log('[capture] hover failed', e.message);
  }

  createPanel();
  await wait(2600);
  await shoot(panelWin, 'panel-overview.png');
  for (const tab of ['shortcuts', 'appearance', 'groups', 'archive']) {
    panelWin.webContents.send('focus:tab', tab);
    await wait(1600);
    await shoot(panelWin, `panel-${tab}.png`);
    const act = await panelWin.webContents
      .executeJavaScript(`(() => { const p = document.querySelector('.page.active'); return p ? p.id : 'none'; })()`)
      .catch((e) => 'err:' + e.message);
    console.log('[capture] tab', tab, '->', act);
    if (tab === 'appearance') {
      await panelWin.webContents.executeJavaScript(
        `(() => { const p = document.querySelector('#page-appearance'); if (!p) return 0; const sc = p.parentElement; sc.scrollTop = sc.scrollHeight; return sc.scrollTop; })()`
      ).catch(() => {});
      await wait(700);
      await shoot(panelWin, 'panel-appearance-2.png');
    }
  }

  const st = buildState();
  const group = st.items.find((i) => i.kind === 'group');
  if (group) {
    createPopup({ kind: 'group', id: group.id }, { cx: 960, cy: 980 });
    await wait(1400);
    await shoot(popupWin, 'popup-group.png');
  }
  const arch = st.items.find((i) => i.kind === 'archive');
  if (arch) {
    createPopup({ kind: 'archive', id: arch.id }, { cx: 960, cy: 980 });
    await wait(1400);

    // 自检①：模拟「把文件拖进文件合集」→ 应被移动进 DeskGlow\文件收纳
    try {
      const tf = path.join(require('os').tmpdir(), 'DeskGlow 收纳自检.txt');
      fs.writeFileSync(tf, 'deskglow selftest');
      const r = await popupWin.webContents.executeJavaScript(
        `window.dg.invoke('archive:addFiles', ${JSON.stringify([tf])})`
      );
      const landed = vault.listDir(vault.dirs().archive).some((e) => e.fileName === 'DeskGlow 收纳自检.txt');
      console.log('[selftest] archive:addFiles', JSON.stringify(r), 'landed=', landed);
      await wait(1200);
      await shoot(popupWin, 'popup-archive-drop.png');
      // 清理
      const p = path.join(vault.dirs().archive, 'DeskGlow 收纳自检.txt');
      try { fs.unlinkSync(p); } catch (_) {}
      refreshDesktop();
    } catch (e) {
      console.log('[selftest] archive failed', e.message);
    }

    await shoot(popupWin, 'popup-archive.png');

    // 自检②：桌面文件 → DeskGlow\文件收纳（只处理本次创建的自检文件）
    try {
      const NAME = 'DeskGlow文件收纳自检.txt';
      const deskFile = path.join(app.getPath('desktop'), NAME);
      fs.writeFileSync(deskFile, 'deskglow import test');
      const r = vault.importDesktopFiles({ filter: (n) => n === NAME });
      const landed = vault
        .listDir(vault.dirs().archive)
        .some((e) => e.fileName.startsWith('DeskGlow文件收纳自检'));
      console.log('[selftest] vault:importFiles', JSON.stringify(r), 'landed=', landed);
      for (const e of vault.listDir(vault.dirs().archive)) {
        if (e.fileName.startsWith('DeskGlow文件收纳自检')) {
          try { fs.unlinkSync(e.path); } catch (_) {}
        }
      }
      refreshDesktop();
    } catch (e) {
      console.log('[selftest] importFiles failed', e.message);
    }

    // 自检③：点击关闭按钮 → 窗口应销毁
    try {
      await popupWin.webContents.executeJavaScript(`document.getElementById('btnClose').click()`);
      await wait(700);
      console.log('[selftest] popup closed =', !popupWin || popupWin.isDestroyed());
    } catch (e) {
      console.log('[selftest] close failed', e.message);
    }
  }
  console.log('[capture] done');
  app.isQuiting = true;
  app.exit(0);
}

/* ------------------------------------------------------------------ */
/* （临时诊断代码已移除）                                                */
/* ------------------------------------------------------------------ */


const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createPanel());

  if (compatEnabled() && !process.argv.includes('--no-sandbox')) {
    try { app.relaunch({ args: relaunchArgs({ sandbox: true, keepDevFlags: true }) }); } catch (_) { /* ignore */ }
    app.exit(0);
  } else app.whenReady().then(async () => {
    app.setAppUserModelId('com.deskglow.app');
    store.init();
    // 首次运行就建好软件文件夹（快捷方式 / 文件收纳）
    vault.ensure();
    registerIpc();

    // dgfile:// 只映射到 userData 下的 fonts / images，渲染层用它加载导入的字体与图片
    try {
      protocol.handle('dgfile', (req) => {
        try {
          const u = new URL(req.url);
          const kind = u.hostname === 'font' ? 'font' : 'image';
          const file = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
          const full = dsk.resolve(kind, file);
          if (!full || !fs.existsSync(full)) return new Response('not found', { status: 404 });
          return net.fetch(pathToFileURL(full).toString());
        } catch (_) {
          return new Response('bad request', { status: 400 });
        }
      });
    } catch (e) {
      console.error('[dgfile]', e);
    }

    const uptime = require('os').uptime();
    // 缩放查询和下面的等待并行。开机超过十分钟就不必查，进程拿到的缩放已经是对的。
    const dpiPromise = uptime < 600 ? readConfiguredDpi() : null;
    if (!store.get().initialized) {
      refreshDesktop();
      bootstrapItems();
    }
    // 系统刚起来时，缩放和任务栏占位还会变，这时创建的透明窗口会少一半。
    // 开机超过一分半再空等，只会拖慢之后每次打开。
    if (uptime < EARLY_BOOT_SEC) await waitForStableDisplay();
    if (dpiPromise && maybeRelaunchForStartupDpi(await dpiPromise)) return;

    createDock();
    if (store.get().widgets.enabled !== false) {
      createWidget();
      startWidgetWatch();
      if (needsBattery()) startBatteryWatch();
    }
    const onDisplay = () => { try { syncDockDisplay(); } catch (_) { /* ignore */ } };
    screen.on('display-metrics-changed', onDisplay);
    screen.on('display-metrics-changed', () => { try { placeCanvas(); } catch (_) { /* ignore */ } });
    screen.on('display-added', onDisplay);
    screen.on('display-removed', onDisplay);

    // 显示桌面经常只改 Z 序，所以平时只校正层级。
    // 工作区或缩放变了才重摆；盖在任务栏上不算「被挪出屏幕」，以前因此不会自己回来。
    setInterval(() => {
      try {
        // 还没画出图标时窗口是藏着的。这时 isVisible 为假，不能当成被系统藏起来。
        if (!dockHasShown) return;
        if (!dockWin || dockWin.isDestroyed()) return;
        if (store.get().ui.dockVisible === false) return;
        if (dockWasHiddenByShell()) {
          reviveDock();
          return;
        }
        syncDockDisplay();
        sinkDock();
      } catch (_) { /* ignore */ }
    }, 200);

    try {
      const { globalShortcut } = require('electron');
      globalShortcut.register('CommandOrControl+Alt+D', () => {
        const s = store.get();
        showDock(s.ui.dockVisible === false);
        broadcast();
      });
    } catch {}

    // 自动隐藏：不在这里设置鼠标穿透，交给 startDockHoverWatch 统一管理
    // （Windows 上 setIgnoreMouseEvents 之后窗口收不到鼠标事件，还会影响透明窗口绘制）
    if (store.get().appearance.autoHide && dockWin) {
      dockWin.setIgnoreMouseEvents(false);
      autoHideIgnored = false;
    }

    if (process.argv.includes('--capture')) devCapture();
  });

  app.on('window-all-closed', (e) => {
    // Dock 常驻，不退出
  });

  app.on('before-quit', () => {
    app.isQuiting = true;
    stopWidgetWatch();
    stopBatteryWatch();
    store.flush();
    zorder.stop();
  });

  // 防止 Dock 被意外关闭
  app.on('activate', () => {
    if (!dockWin) createDock();
  });
}
