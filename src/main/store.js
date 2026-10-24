'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  version: 1,
  schema: 4,
  initialized: false,
  appearance: {
    iconSize: 52,
    gap: 11,
    opacity: 64,
    blur: 26,
    theme: 'light',
    showLabels: false,
    hoverScale: 1.16,
    bottomOffset: 8,
    autoHide: false,
    radius: 26,
    accent: '#6c5ce7',
    layout: 'auto',
    bgColor: '',                                   // '' = 跟随深浅主题
    glassOn: true,                                 // 玻璃底板开关
    frameOn: true,                                 // 底板边框；不透明度为 0 时仍保留这一圈
    hoverBg: { on: true, color: '#ffffff', alpha: 70 },   // 悬停时图标后的浅色底
    magnify: { count: 5, scale: 1.40, speed: 220 }, // 准星放大：影响个数(1/3/5/7/9)、最大倍率、响应速度(ms)
    iconStroke: { on: false, width: 1.5, color: '#ffffff' },
    iconShadow: { on: true, blur: 7, y: 3, color: '#141838', alpha: 22 },
    barShadow: { on: true, blur: 24, y: 14, color: '#1c204a', alpha: 22 },
  },
  items: [],
  removedPaths: [],
  // DeskGlow 软件文件夹位置。'' = 默认（%USERPROFILE%\DeskGlow 及其下的两个子文件夹）
  vault: { root: '', shortcuts: '', archive: '' },
  archive: {
    enabled: true,
    name: '文件收纳',
    extensions: [
      '.doc', '.docx', '.docm', '.rtf', '.odt', '.wps', '.pages', '.pdf',
      '.xls', '.xlsx', '.xlsm', '.csv', '.et', '.numbers',
      '.ppt', '.pptx', '.pps', '.ppsx', '.key', '.dps',
      '.txt', '.md', '.log', '.ini', '.json', '.xml', '.html', '.htm',
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.heic', '.tif', '.tiff',
      '.zip', '.rar', '.7z', '.mp3', '.mp4', '.wav', '.psd',
    ],
    includeFolders: true,
    includeOther: false,
    groupByExt: false,
    view: 'icon',
    sort: 'off',
    order: [],
  },
  taskbar: { autoTray: false, autoPin: false },
  // 小组件 = 一堆可自由摆放的元素。字段含义见 src/renderer/widget-fmt.js 的 ELEMENT_DEFS
  widgets: {
    enabled: true,
    elements: [
      { id: 'w-clock', type: 'clock', name: '时钟', x: 92, y: 72, text: { size: 46, weight: 600 } },
      { id: 'w-date', type: 'date', name: '日期', x: 92, y: 136, text: { size: 15 } },
      { id: 'w-battery', type: 'battery', name: '电量', x: 92, y: 164, text: { size: 13 } },
    ],
  },
  ui: { panelBounds: null, dockVisible: true },
};

let filePath = null;
let data = null;
let timer = null;

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isObj(extra)) return out;
  for (const k of Object.keys(extra)) {
    if (isObj(out[k]) && isObj(extra[k])) out[k] = deepMerge(out[k], extra[k]);
    else if (extra[k] !== undefined) out[k] = extra[k];
  }
  return out;
}

function init() {
  filePath = path.join(app.getPath('userData'), 'config.json');
  let loaded = {};
  try {
    if (fs.existsSync(filePath)) loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    try { fs.copyFileSync(filePath, filePath + '.broken-' + Date.now()); } catch {}
    loaded = {};
  }
  const loadedSchema = Number(loaded.schema || 1); // 合并前记住磁盘上的版本
  data = deepMerge(DEFAULTS, loaded);
  // 老版本补全
  if (!Array.isArray(data.items)) data.items = [];
  migrate(loadedSchema, loaded);
  return data;
}

/** 配置升级：只在老版本配置上补一次，避免用户手动删除的项被反复加回来 */
function migrate(loadedSchema, loaded) {
  let changed = false;
  if (loadedSchema < 3) {
    // v2/v3：文件收纳补上图片 / 压缩包 / 音视频等常见类型
    const ext = Array.isArray(data.archive && data.archive.extensions) ? data.archive.extensions : [];
    data.archive.extensions = Array.from(new Set([...ext, ...DEFAULTS.archive.extensions]));
    changed = true;
  }
  if (loadedSchema < 4 && migrateWidgets(loaded)) changed = true;
  if (data.schema !== 4) { data.schema = 4; changed = true; }
  if (changed) save(true);
}

/**
 * v4：小组件从「固定三行 + 一块底板」变成「元素列表」。
 * 老配置里开着的时钟 / 日期 / 电量转成三个元素，位置沿用原来面板的左上角。
 */
function migrateWidgets(loaded) {
  const w = data.widgets;
  if (!w || typeof w !== 'object') return false;
  const legacy = w.clock || w.date || w.battery;
  if (!legacy) return false;

  // 用磁盘上的原始配置判断有没有元素：合并默认值之后永远是「有」
  const saved = (loaded && loaded.widgets) || {};
  const empty = !Array.isArray(saved.elements) || !saved.elements.length;
  if (empty) {
    const pos = w.position && Number.isFinite(Number(w.position.x)) ? w.position : null;
    const x = (pos ? Math.round(Number(pos.x)) : 92) + 16;   // 老面板有 16px 内边距
    let y = (pos ? Math.round(Number(pos.y)) : 72) + 16;
    const c = w.clock || {};
    const d = w.date || {};
    const b = w.battery || {};
    const out = [];
    if (c.on !== false) {
      out.push({
        id: 'w-clock', type: 'clock', name: '时钟', x, y,
        text: { size: c.size || 34, weight: c.weight || 650 },
        data: { pattern: c.pattern || 'HH:mm' },
      });
      y += Math.round((c.size || 34) * 1.3) + 6;
    }
    if (d.on !== false) {
      out.push({
        id: 'w-date', type: 'date', name: '日期', x, y,
        text: { size: d.size || 13 },
        data: { pattern: d.pattern || 'M月D日 ddd' },
      });
      y += Math.round((d.size || 13) * 1.6) + 6;
    }
    if (b.on !== false) {
      out.push({
        id: 'w-battery', type: 'battery', name: '电量', x, y,
        text: { size: b.size || 13 },
        data: {
          pattern: b.pattern || '{p}%',
          bar: b.bar !== false, icon: b.icon !== false, text: b.text !== false,
          low: b.low || 20,
        },
      });
    }
    w.elements = out;
  }

  delete w.clock;
  delete w.date;
  delete w.battery;
  delete w.style;
  delete w.layout;
  delete w.theme;
  delete w.position;
  return true;
}

function get() {
  if (!data) init();
  return data;
}

function flush() {
  if (!data || !filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error('[store] save failed', e);
  }
}

function save(immediate = false) {
  if (immediate) {
    clearTimeout(timer); timer = null; flush(); return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; flush(); }, 250);
}

function set(patch) {
  data = deepMerge(data || init(), patch);
  save();
  return data;
}

function pathFile() { return filePath; }

module.exports = { init, get, set, save, flush, pathFile, DEFAULTS };
