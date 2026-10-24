'use strict';
/* Dock 的层级不在这个文件里。不要用 rAF、改 opacity 或 invalidate() 处理显示桌面后 Dock 消失。约定见 AGENTS.md。 */

const api = window.dg;
const itemsEl = document.getElementById('items');
const pinnedEl = document.getElementById('pinned');
const barEl = document.getElementById('bar');
const stageEl = document.getElementById('stage');

let state = null;
let collapsed = false;
let collapseTimer = null;
let autoHide = false;
let inlineArchive = false;

const esc = (s) =>
  String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* --------------------------- 外观 --------------------------- */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return '';
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(', ');
}

function rgbaOf(hex, a) {
  const rgb = hexToRgb(hex) || '20, 24, 56';
  return `rgba(${rgb}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/* 描边和投影必须从原始图标各画一次。
   以前用一串 drop-shadow 叠加上去，每一层都会把上一层再投影一遍，
   描边就被涂成一圈很粗的黑边。 */
function applyIconFx(a) {
  const root = document.documentElement.style;
  const st = a.iconStroke || {};
  const sh = a.iconShadow || {};
  const strokeOn = !!st.on;
  const shadowOn = !!sh.on;
  if (!strokeOn && !shadowOn) {
    root.setProperty('--icon-filter', 'none');
    return;
  }
  root.setProperty('--icon-filter', 'url(#iconFx)');
  const w = Math.max(0.5, Math.min(4, Number(st.width) || 1.5));
  const blur = shadowOn ? Math.max(0, Math.min(40, Number(sh.blur) || 0)) : 0;
  const y = shadowOn ? (Number(sh.y) || 0) : 0;
  const al = shadowOn ? Math.max(0, Math.min(0.7, (sh.alpha == null ? 22 : Number(sh.alpha)) / 100)) : 0;
  sizeIconFilter(blur, y, strokeOn ? w : 0);
  const morph = document.getElementById('strokeMorph');
  const strokeFlood = document.getElementById('strokeFlood');
  const blurEl = document.getElementById('shadowBlur');
  const offsetEl = document.getElementById('shadowOffset');
  const shadowFlood = document.getElementById('shadowFlood');
  if (!morph) return;
  morph.setAttribute('radius', strokeOn ? String(w) : '0');
  strokeFlood.setAttribute('flood-color', st.color || '#ffffff');
  strokeFlood.setAttribute('flood-opacity', strokeOn ? '1' : '0');
  blurEl.setAttribute('stdDeviation', (blur / 2).toFixed(2));
  offsetEl.setAttribute('dy', String(y));
  shadowFlood.setAttribute('flood-color', sh.color || '#141838');
  shadowFlood.setAttribute('flood-opacity', al.toFixed(3));
}

/* 滤镜区域按模糊和偏移留够，否则晕开到边上会被切成一条直线。 */
function sizeIconFilter(blur, y, stroke) {
  const el = document.getElementById('iconFx');
  if (!el) return;
  const pad = Math.ceil(Math.max(0, blur) * 2.4 + Math.abs(Number(y) || 0) + Math.max(0, stroke) * 3 + 36);
  el.setAttribute('filterUnits', 'userSpaceOnUse');
  el.setAttribute('x', String(-pad));
  el.setAttribute('y', String(-pad));
  el.setAttribute('width', String(pad * 2 + 280));
  el.setAttribute('height', String(pad * 2 + 280));
}

/* 玻璃顶边的内高光。外投影不走 box-shadow：窗口边界会把还没淡完的
   阴影切成一条硬边，所以外投影改画在 .bar-shade 上，并在 --shpad 内淡到 0。 */
function buildBarShadow(a) {
  return a.theme === 'dark'
    ? 'inset 0 1px 0 rgba(255,255,255,0.10)'
    : 'inset 0 1px 0 rgba(255,255,255,0.7)';
}

/* 底板投影的可见长度。最浓的一段用 hide 藏在底板后面，reach 是探出栏底的淡出。 */
function barShadeMetrics(a) {
  const sh = a.barShadow || {};
  const on = !!sh.on && a.glassOn !== false;
  const radius = Math.max(0, Math.min(80, Number(a.radius) || 26));
  if (!on) return { reach: 0, hide: 12, inset: 12, fade: 22 };
  const blur = Math.max(0, Math.min(60, Number(sh.blur) || 0));
  const y = Math.max(-10, Math.min(40, Number(sh.y) || 0));
  let reach = Math.max(12, Math.round(Math.max(0, y) * 0.85 + blur * 0.72 + 8));
  let hide = Math.max(10, Math.round(blur * 0.38 + 10 + Math.max(0, -y) * 0.6));
  if (a.autoHide) {
    reach = Math.min(reach, 8);
    hide = Math.min(hide, 12);
  } else {
    // 栏底到屏幕底只有 bottomOffset。再长的话，淡出还没结束就被屏幕切成一条硬边。
    const room = Math.max(10, Number(a.bottomOffset) || 0);
    if (reach > room) reach = room;
  }
  // 底板接近全透明时，藏在后面的那一段会露出来，变成横穿图标的硬边。
  const covered = a.glassOn !== false && Number(a.opacity) >= 40;
  return {
    reach,
    hide: covered ? hide : 0,
    head: covered ? 1 : 0.62,
    inset: Math.round(Math.min(radius * 0.42, 36)),
    fade: Math.round(Math.max(16, Math.min(radius * 0.85, 56))),
  };
}

/* 栏底到窗口底的留白。自动隐藏时下沿就是热区，不能往下撑。 */
function barShadowPad(a) {
  if (a.autoHide) return 10;
  const m = barShadeMetrics(a);
  if (!m.reach) return 10;
  return Math.max(18, Math.min(150, m.reach + 10));
}

function applyBarShade(a) {
  const root = document.documentElement.style;
  const sh = a.barShadow || {};
  const on = !!sh.on && a.glassOn !== false;
  document.body.dataset.barshadow = on ? 'true' : 'false';
  const al = (sh.alpha == null ? 22 : Math.max(0, Math.min(80, Number(sh.alpha)))) / 100;
  const color = sh.color || (a.theme === 'dark' ? '#000000' : '#1c204a');
  const m = barShadeMetrics(a);
  root.setProperty('--shade-rgb', hexToRgb(color) || (a.theme === 'dark' ? '0, 0, 0' : '28, 32, 74'));
  root.setProperty('--shade-a', al.toFixed(3));
  root.setProperty('--shade-hide', m.hide + 'px');
  root.setProperty('--shade-head', String(m.head == null ? 1 : m.head));
  root.setProperty('--shade-reach', m.reach + 'px');
  root.setProperty('--shade-inset', m.inset + 'px');
  root.setProperty('--shade-fade', m.fade + 'px');
}

function applyAppearance(a) {
  const root = document.documentElement.style;
  root.setProperty('--icon', a.iconSize + 'px');
  root.setProperty('--gap', a.gap + 'px');
  root.setProperty('--radius', a.radius + 'px');
  root.setProperty('--alpha', String(Math.max(0, Math.min(1, a.opacity / 100))));
  root.setProperty('--blur', a.blur + 'px');
  root.setProperty('--maxw', Math.max(420, Math.round(window.screen.availWidth * 0.9) - 110) + 'px');
  applyIconFx(a);
  root.setProperty('--mag-dur', magSpeed(a) + 'ms');

  const hb = a.hoverBg || {};
  root.setProperty('--hover-bg', rgbaOf(hb.color || '#ffffff', (hb.alpha == null ? 70 : Number(hb.alpha)) / 100));
  root.setProperty('--shadow', buildBarShadow(a));
  root.setProperty('--shpad', barShadowPad(a) + 'px');
  applyBarShade(a);

  const bg = hexToRgb(a.bgColor);
  if (bg) root.setProperty('--bg-rgb', bg);
  else root.removeProperty('--bg-rgb');

  document.body.dataset.theme = a.theme || 'light';
  document.body.dataset.labels = a.showLabels ? 'true' : 'false';
  document.body.dataset.autohide = a.autoHide ? 'true' : 'false';
  document.body.dataset.glass = a.glassOn === false ? 'false' : 'true';
  document.body.dataset.fill = (a.glassOn !== false && Number(a.opacity) > 0) ? 'on' : 'off';
  document.body.dataset.frame = (a.glassOn !== false && a.frameOn !== false) ? 'true' : 'false';
  document.body.dataset.hoverbg = hb.on === false ? 'false' : 'true';
  autoHide = !!a.autoHide;
  if (!autoHide && collapsed) {
    collapsed = false;
    document.body.dataset.collapsed = 'false';
  }
}

/* --------------------------- 渲染 --------------------------- */
function appIcon(it) {
  if (it.icon) return `<img class="icon" src="${it.icon}" alt="" draggable="false" />`;
  const ch = esc((it.name || '?').trim().charAt(0).toUpperCase());
  return `<div class="fallback">${ch}</div>`;
}

const ARCHIVE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 7.5A2 2 0 0 1 5 5.5h4.2l1.6 1.8H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
</svg>`;

function groupFace(it) {
  if (it.iconSrc) {
    return `<div class="folder custom"><img src="${it.iconSrc}" alt="" draggable="false" /></div>`;
  }
  if (it.icon && window.DGIcons) {
    const tile = DGIcons.tile(it.icon);
    if (tile) return `<div class="folder custom">${tile}</div>`;
  }
  let inner = '';
  for (let i = 0; i < 4; i++) {
    const src = (it.preview || [])[i];
    inner += src ? `<img src="${src}" alt="" draggable="false" />` : `<div class="fallback"></div>`;
  }
  return `<div class="folder">${inner}</div>`;
}

function itemHTML(it) {
  let face = '';
  let cls = 'item';
  let tip = esc(it.name);
  if (it.kind === 'app' || it.kind === 'system') {
    face = appIcon(it);
    if (it.missing) cls += ' missing';
  } else if (it.kind === 'group') {
    face = groupFace(it);
    tip = `${esc(it.name)} · ${it.count} 项`;
  } else {
    face = `<div class="archive-tile">${ARCHIVE_SVG}</div>`;
  }
  return `<div class="${cls}" data-id="${it.id}" data-kind="${it.kind || 'archive'}">
    <div class="glyph"><div class="face">${face}</div></div>
    <div class="tip">${tip}</div>
  </div>`;
}

/* 布局：放得下就一行，放不下自动均衡成多行（不再横向滚动） */
function computeLayout() {
  const a = state.appearance;
  const itemW = a.iconSize + 12;
  const gap = a.gap;
  const nApps = state.items.filter((i) => i.kind !== 'archive' && !(i.kind === 'system' && i.closed)).length;
  const hasArchive = state.items.some((i) => i.kind === 'archive');
  const total = nApps + (hasArchive ? 1 : 0);
  const maxW = Math.max(380, Math.round(window.screen.availWidth * 0.94) - 48);
  const chrome = 28 + (hasArchive ? 8 : 0); // 左右内边距 + 与收纳之间的间隙
  const contentApps = nApps ? nApps * itemW + Math.max(0, nApps - 1) * gap : 190;
  const pinW = hasArchive ? 20 + itemW : 0;

  if (contentApps + chrome + pinW <= maxW) {
    return { layout: 'single', barW: contentApps + chrome + pinW, itemsW: contentApps, rows: 1 };
  }

  const capacity = Math.max(1, Math.floor((maxW - chrome + gap) / (itemW + gap)));
  const rows = Math.max(2, Math.ceil(total / capacity));
  const perRow = Math.min(capacity, Math.ceil(total / rows));
  const sepW = hasArchive ? 20 : 0;
  const itemsW = perRow * itemW + (perRow - 1) * gap + sepW;
  return {
    layout: 'wrap',
    barW: Math.min(itemsW + chrome, maxW),
    itemsW: Math.min(itemsW, maxW - chrome),
    rows,
  };
}

function applyLayout(L) {
  document.body.dataset.layout = L.layout === 'wrap' ? 'wrap' : 'single';
  document.documentElement.style.setProperty('--maxw', L.itemsW + 'px');
  if (L.layout === 'wrap') {
    itemsEl.style.width = L.itemsW + 'px';
    itemsEl.style.maxWidth = 'none';
  } else {
    itemsEl.style.width = '';
    itemsEl.style.maxWidth = '';
  }
  baseBarW = L.barW;
  barEl.style.width = L.barW + 'px';
}

let lastStruct = '';
let lastLayout = '';

function structKey() {
  return (state.items || [])
    .map((i) => [i.id, i.kind, i.name, i.count, i.closed ? 1 : 0, i.missing ? 1 : 0, i.kind === 'group' ? `${i.icon || '-'}/${(i.iconSrc || '').length}` : (i.icon || '').length, (i.preview || []).join(',').length].join(':'))
    .join(';');
}

/** 只有这些字段会改变 Dock 的宽高，其余外观只改 CSS 变量 */
function layoutKey() {
  const a = state.appearance || {};
  const m = a.magnify || {};
  const bs = a.barShadow || {};
  // 栏阴影会改变窗口高度（下方要留出投影的位置），所以也进 key
  return [a.iconSize, a.gap, a.showLabels ? 1 : 0, a.bottomOffset,
    bs.on ? 1 : 0, bs.blur, bs.y, a.glassOn === false ? 0 : 1,
    m.count, m.scale].join('|');
}

function render() {
  if (!state) return;
  const sk = structKey();
  const lk = layoutKey();
  const L = computeLayout();
  const inline = L.layout === 'wrap';
  if (sk === lastStruct && inline === inlineArchive) {
    applyLayout(L);
    if (lk !== lastLayout) {
      lastLayout = lk;
      measure();
    }
    return;
  }
  lastStruct = sk;
  lastLayout = lk;
  inlineArchive = inline;

  const apps = state.items.filter((i) => i.kind !== 'archive' && !(i.kind === 'system' && i.closed));
  const archive = state.items.find((i) => i.kind === 'archive');

  if (!apps.length && !archive) {
    itemsEl.innerHTML = `<div class="empty">右键打开面板，或把快捷方式拖到这里</div>`;
  } else {
    itemsEl.innerHTML = apps.map(itemHTML).join('') + (inline && archive ? `<div class="sep"></div>${itemHTML(archive)}` : '');
  }
  pinnedEl.innerHTML = !inline && archive ? `<div class="sep"></div>${itemHTML(archive)}` : '';

  applyLayout(L);
  measure();
  resetMagnify();
}

/* 窗口上方要留出的高度。名字不跟着图标缩放，但会抬到放大后的图标顶上，
   留少了就会被窗口上沿切掉。 */
function growPx() {
  const a = state.appearance;
  const m = a.magnify || {};
  const scale = Math.max(1, Number(m.scale) || 1.4);
  const h = a.iconSize + 12;
  const ty = (scale - 1) * (a.iconSize * 0.5);
  const iconAbove = (scale - 1) * h + ty;
  const tipAbove = a.showLabels ? (scale - 1) * h + ty + 8 + 32 : 0;
  let grow = Math.max(16, Math.ceil(Math.max(iconAbove, tipAbove) - 4));
  if (document.body.dataset.layout === 'wrap') {
    grow += Math.ceil((scale - 1) * (a.iconSize * 0.5) + 6);
  }
  return grow;
}

function measure() {
  if (!state) return;
  const L = computeLayout();
  const wantInline = L.layout === 'wrap';
  if (wantInline !== inlineArchive) {
    render();
    return;
  }
  applyLayout(L);

  const grow = growPx();
  document.documentElement.style.setProperty('--grow', grow + 'px');
  // 左右留出放大推挤所需的空间，避免图标被窗口裁掉
  const pad = magPad();
  document.documentElement.style.setProperty('--magpad', pad + 'px');
  // 栏下方留出阴影的位置：窗口边界会把阴影切出硬边
  const shpad = barShadowPad(state.appearance);
  document.documentElement.style.setProperty('--shpad', shpad + 'px');

  requestAnimationFrame(() => {
    const r = barEl.getBoundingClientRect();
    publishHit();
    // +10 是栏底与窗口底之间的固定留白（保持栏在屏幕上的落点不变）
    api.invoke('dock:measure', { w: L.barW + 28 + pad * 2, h: Math.ceil(r.height) + grow + shpad + 10, shpad });
    setTimeout(() => {
      const r2 = barEl.getBoundingClientRect();
      if (Math.abs(r2.height - r.height) > 1) {
        api.invoke('dock:measure', { w: L.barW + 28 + pad * 2, h: Math.ceil(r2.height) + grow + shpad + 10, shpad });
      }
    }, 150);
  });
}

/* --------------------------- 准星放大（带推挤） --------------------------- */
let magRaf = null;
let magPoint = null;
let magStamp = 0;
let shownExtra = 0;
let shownLift = 0;
const magShown = new WeakMap();
let baseBarW = 0;

/** 放大动画的响应时长（毫秒），越大越柔和 */
function magSpeed(a) {
  const m = (a || (state && state.appearance) || {}).magnify || {};
  const v = Number(m.speed);
  return Math.max(40, Math.min(600, Number.isFinite(v) && v > 0 ? v : 220));
}

function magParams() {
  const a = state.appearance;
  const m = a.magnify || {};
  return {
    max: Math.max(1, Math.min(2.5, Number(m.scale) || 1.4)),
    count: Math.max(1, Math.min(9, Number(m.count) || 5)),
    w: a.iconSize + 12,
    speed: magSpeed(a),
  };
}

/** Dock 左右需要为放大预留的额外宽度 */
function magPad() {
  const { max, count, w } = magParams();
  if (max <= 1.001) return 10;
  const half = (count - 1) / 2;
  let sum = 0;
  for (let d = 0; d <= half + 0.001; d++) sum += (half + 1 - d) / (half + 1);
  return Math.ceil(((max - 1) * w * sum) / 2) + 14;
}

function resetMagnify() {
  magPoint = null;
  magStamp = 0;
  shownExtra = 0;
  shownLift = 0;
  if (magRaf) { cancelAnimationFrame(magRaf); magRaf = null; }
  barEl.style.paddingTop = '';
  barEl.querySelectorAll('.item').forEach((el) => {
    el.style.setProperty('--s', '1');
    el.style.setProperty('--ty', '0px');
    el.style.setProperty('--tx', '0px');
    el.style.zIndex = '';
  });
  if (baseBarW) barEl.style.width = baseBarW + 'px';
  publishHit();
}

/** 静止布局上的图标框。不用变换后的位置，避免放大把准星推来推去。 */
function restBoxes() {
  const boxes = [];
  barEl.querySelectorAll('.item').forEach((el) => {
    const host = el.offsetParent;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const left = hr.left + host.clientLeft + el.offsetLeft;
    const top = hr.top + host.clientTop + el.offsetTop;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    boxes.push({
      el,
      left,
      top,
      right: left + width,
      bottom: top + height,
      cx: left + width / 2,
    });
  });
  return boxes;
}

function groupRows(boxes) {
  const rows = [];
  for (const b of boxes) {
    let row = null;
    for (const r of rows) {
      if (Math.abs(r.top - b.top) <= 8) { row = r; break; }
    }
    if (!row) {
      row = { top: b.top, bottom: b.bottom, boxes: [] };
      rows.push(row);
    }
    row.bottom = Math.max(row.bottom, b.bottom);
    row.boxes.push(b);
  }
  rows.sort((a, b) => a.top - b.top);
  rows.forEach((r) => r.boxes.sort((a, b) => a.cx - b.cx));
  return rows;
}

function pickRow(rows, y) {
  if (!rows.length) return null;
  for (const r of rows) {
    if (y >= r.top && y <= r.bottom) return r;
  }
  const gap = (Number(state.appearance.gap) || 0) + 2;
  let best = rows[0];
  let bestDy = Infinity;
  for (const r of rows) {
    const dy = Math.abs(y - (r.top + r.bottom) / 2);
    if (dy < bestDy) { bestDy = dy; best = r; }
  }
  if (y < best.top - gap / 2 || y > best.bottom + gap / 2) return null;
  return best;
}

/** 放大后图标顶部超出布局框的高度 */
function iconRisePx(scale) {
  const a = state.appearance;
  const h = a.iconSize + 12;
  return (scale - 1) * (h + a.iconSize * 0.5);
}

/** 把上面几行抬起，给当前行的放大留出空隙 */
function rowLiftPx(scale) {
  let gap = (Number(state.appearance.gap) || 0) + 2;
  const raw = parseFloat(getComputedStyle(itemsEl).rowGap);
  if (Number.isFinite(raw)) gap = raw;
  return Math.max(0, iconRisePx(scale) - gap + 4);
}

function popTy(scale) {
  return -(scale - 1) * (state.appearance.iconSize * 0.5);
}

/** 边缘斜率为 0，下一个图标是慢慢加入的，不会一进范围就突然变大。 */
function influence(dist, radius) {
  if (!(radius > 0) || dist >= radius) return 0;
  return (Math.cos((dist / radius) * Math.PI) + 1) / 2;
}

/**
 * 倍率按离指针的距离平滑衰减，个数只决定影响多远。
 * 挤开量锁在指针上，不会因为换了一个锚点图标而整排横跳。
 */
function lineShift(line, px, max, count, w) {
  const n = line.length;
  const pitch = Math.max(1, w + (Number(state.appearance.gap) || 0));
  const radius = (Math.max(1, count) + 1) / 2;
  const scales = line.map((b) => 1 + (max - 1) * influence(Math.abs(b.cx - px) / pitch, radius));
  const extra = scales.map((s) => (w * s - w) / 2);
  const dx = new Array(n).fill(0);
  if (n <= 1 || px <= line[0].cx) {
    for (let i = 1; i < n; i++) dx[i] = dx[i - 1] + extra[i - 1] + extra[i];
    return { scales, dx };
  }
  if (px >= line[n - 1].cx) {
    for (let i = n - 2; i >= 0; i--) dx[i] = dx[i + 1] - extra[i + 1] - extra[i];
    return { scales, dx };
  }
  let i0 = 0;
  for (let i = 0; i < n - 1; i++) {
    if (px >= line[i].cx && px <= line[i + 1].cx) { i0 = i; break; }
  }
  const span = line[i0 + 1].cx - line[i0].cx || 1;
  const frac = (px - line[i0].cx) / span;
  const gapGrow = extra[i0] + extra[i0 + 1];
  dx[i0] = -frac * gapGrow;
  dx[i0 + 1] = (1 - frac) * gapGrow;
  for (let i = i0 + 2; i < n; i++) dx[i] = dx[i - 1] + extra[i - 1] + extra[i];
  for (let i = i0 - 1; i >= 0; i--) dx[i] = dx[i + 1] - extra[i + 1] - extra[i];
  return { scales, dx };
}

function paintItem(el, scale, tx, ty, z) {
  el.style.setProperty('--s', scale.toFixed(3));
  el.style.setProperty('--tx', tx.toFixed(1) + 'px');
  el.style.setProperty('--ty', ty.toFixed(1) + 'px');
  el.style.zIndex = z || '';
}

function approach(cur, next, k, snap) {
  const v = cur + (next - cur) * k;
  return Math.abs(next - v) <= snap ? next : v;
}

/**
 * 目标位置跟指针走，显示出来的大小再按响应速度慢慢追上。
 * 这样刚放上去是缓缓变大，而不是第一帧就弹到最大。
 */
function applyMagnify(dt) {
  if (!state) return false;
  const { max, count, w, speed } = magParams();
  const tau = Math.max(70, speed * 0.45);
  const k = 1 - Math.exp(-Math.max(8, dt) / tau);
  const els = Array.from(barEl.querySelectorAll('.item'));
  document.documentElement.style.setProperty('--mag-dur', '0ms');

  const point = magPoint;
  const rows = point ? groupRows(restBoxes()) : [];
  const row = point ? pickRow(rows, point.y) : null;
  const targets = new Map();
  let extra = 0;
  let lift = 0;

  if (row) {
    const active = rows.indexOf(row);
    const shifted = lineShift(row.boxes, point.x, max, count, w);
    const peak = shifted.scales.reduce((m, s) => Math.max(m, s), 1);
    lift = rows.length > 1 && active > 0 ? rowLiftPx(peak) : 0;
    rows.forEach((r, ri) => {
      if (ri === active) {
        r.boxes.forEach((b, i) => {
          const d = Math.abs(b.cx - point.x);
          targets.set(b.el, {
            s: shifted.scales[i],
            tx: shifted.dx[i],
            ty: popTy(shifted.scales[i]),
            z: String(40 - Math.min(20, Math.round(d))),
          });
          extra = Math.max(extra, Math.abs(shifted.dx[i]) + (w * shifted.scales[i] - w) / 2);
        });
        return;
      }
      const ty = ri < active && lift > 0 ? -lift : 0;
      r.boxes.forEach((b) => targets.set(b.el, { s: 1, tx: 0, ty, z: '' }));
    });
  }

  let moving = false;
  els.forEach((el) => {
    const t = targets.get(el) || { s: 1, tx: 0, ty: 0, z: '' };
    const prev = magShown.get(el) || { s: 1, tx: 0, ty: 0 };
    const s = approach(prev.s, t.s, k, 0.004);
    const tx = approach(prev.tx, t.tx, k, 0.2);
    const ty = approach(prev.ty, t.ty, k, 0.2);
    magShown.set(el, { s, tx, ty });
    paintItem(el, s, tx, ty, t.z);
    if (s !== t.s || tx !== t.tx || ty !== t.ty) moving = true;
  });

  shownExtra = approach(shownExtra, extra, k, 0.4);
  shownLift = approach(shownLift, lift, k, 0.4);
  if (shownExtra !== extra || shownLift !== lift) moving = true;
  if (baseBarW) barEl.style.width = Math.ceil(baseBarW + shownExtra * 2) + 'px';
  if (shownLift > 0.5) barEl.style.paddingTop = `calc(var(--pad-y) + ${shownLift.toFixed(1)}px)`;
  else barEl.style.paddingTop = '';
  publishHit();
  return moving;
}

function stepMagnify(ts) {
  magRaf = null;
  const dt = magStamp ? Math.min(40, ts - magStamp) : 16;
  magStamp = ts;
  const moving = applyMagnify(dt);
  if (moving) magRaf = requestAnimationFrame(stepMagnify);
  else magStamp = 0;
}

function scheduleMagnify(point) {
  magPoint = point;
  if (magRaf) return;
  magRaf = requestAnimationFrame(stepMagnify);
}

barEl.addEventListener('pointermove', (e) => {
  if (drag && drag.moved) return;
  scheduleMagnify({ x: e.clientX, y: e.clientY });
});

barEl.addEventListener('pointerleave', () => {
  if (drag) return;
  scheduleMagnify(null);
});


/* --------------------------- 透明留白穿透 --------------------------- */
/* 窗口比图标高一截：上面是放大和名字（「AI · 4 项」），下面是投影。
   那截是透明的，但窗口仍会吃掉右键，桌面菜单出不来。
   名字气泡在图标外面，不能算进可点区域。底色和边框都没有时，只认图标本身。 */
let lastHitKey = '';
let overDock = true;

function glassHitsPointer() {
  const a = state && state.appearance;
  if (!a) return true;
  if (a.glassOn === false) return false;
  if (Number(a.opacity) > 0) return true;
  return a.frameOn !== false;
}

function unionBox(into, b) {
  if (!b || b.width < 1 || b.height < 1) return into;
  if (!into) return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  into.left = Math.min(into.left, b.left);
  into.top = Math.min(into.top, b.top);
  into.right = Math.max(into.right, b.right);
  into.bottom = Math.max(into.bottom, b.bottom);
  return into;
}

function dockHitBox() {
  let box = null;
  if (glassHitsPointer()) box = unionBox(box, barEl.getBoundingClientRect());
  barEl.querySelectorAll('.item').forEach((el) => {
    box = unionBox(box, el.getBoundingClientRect());
  });
  if (!box) return null;
  return {
    x: box.left,
    y: box.top,
    w: Math.max(0, box.right - box.left),
    h: Math.max(0, box.bottom - box.top),
  };
}

function publishHit() {
  const box = dockHitBox();
  const pageW = Math.round(window.innerWidth);
  const pageH = Math.round(window.innerHeight);
  if (!box || box.w < 2 || box.h < 2) {
    const key = '0,' + pageW + ',' + pageH;
    if (key === lastHitKey) return;
    lastHitKey = key;
    api.invoke('dock:hitbox', null);
    return;
  }
  const key = [Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h), pageW, pageH].join(',');
  if (key === lastHitKey) return;
  lastHitKey = key;
  api.invoke('dock:hitbox', Object.assign({ pageW, pageH }, box));
}

function pointIn(b, x, y) {
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
}

/** 名字气泡和窗口上沿留白都不算。只认看得见的底板，或图标自己的框。 */
function pointerOverBar(x, y) {
  if (glassHitsPointer() && pointIn(barEl.getBoundingClientRect(), x, y)) return true;
  const items = barEl.querySelectorAll('.item');
  for (let i = 0; i < items.length; i++) {
    if (pointIn(items[i].getBoundingClientRect(), x, y)) return true;
  }
  return false;
}

function setPass(pass) {
  try { api.sendSync('dock:passthrough', !!pass); } catch (_) { /* ignore */ }
}

function syncPass(x, y) {
  if (drag) return;
  if (autoHide && collapsed) return;
  const over = pointerOverBar(x, y);
  if (over === overDock) return;
  overDock = over;
  setPass(!over);
}

document.addEventListener('mousemove', (e) => syncPass(e.clientX, e.clientY), true);
document.addEventListener('mouseleave', () => {
  if (drag || (autoHide && collapsed)) return;
  if (!overDock) return;
  overDock = false;
  setPass(true);
});

/* --------------------------- 右键 --------------------------- */
function onItemContext(e) {
  e.preventDefault();
  e.stopPropagation();
  const item = e.target.closest('.item');
  if (item) api.invoke('item:menu', item.dataset.id);
}

itemsEl.addEventListener('contextmenu', onItemContext);
pinnedEl.addEventListener('contextmenu', onItemContext);

document.addEventListener('contextmenu', (e) => {
  // 名字和上方留白上的右键要落到桌面。这次若仍被窗口接到，不要拦掉，也不要弹 Dock 菜单。
  if (!pointerOverBar(e.clientX, e.clientY)) {
    setPass(true);
    return;
  }
  e.preventDefault();
  api.invoke('dock:menu');
});

/* --------------------------- 拖动排序 / 拖出移除 --------------------------- */
let drag = null;
let ghost = null;

function onPointerDown(e) {
  if (e.button !== 0) return;
  const item = e.target.closest('.item');
  if (!item) return;
  drag = { id: item.dataset.id, el: item, x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey };
  try { api.sendSync('dock:hold', true); } catch (_) { /* ignore */ }
  try { item.setPointerCapture(e.pointerId); } catch {}
}

function startDrag(e) {
  if (!drag || drag.moved) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return;
  drag.moved = true;
  resetMagnify();
  drag.el.classList.add('dragging');
  const img = drag.el.querySelector('img');
  ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  ghost.innerHTML = img ? `<img src="${img.src}" style="width:100%;height:100%;object-fit:contain" />` : '';
  document.body.appendChild(ghost);
}

itemsEl.addEventListener('pointerdown', onPointerDown);
pinnedEl.addEventListener('pointerdown', onPointerDown);
itemsEl.addEventListener('pointermove', startDrag);
pinnedEl.addEventListener('pointermove', startDrag);

document.addEventListener('pointermove', (e) => {
  if (!drag || !drag.moved) return;
  if (ghost) {
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
  }
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const target = el && el.closest('.item');
  document.querySelectorAll('.item.drop-target').forEach((n) => n.classList.remove('drop-target'));
  if (target && target !== drag.el) target.classList.add('drop-target');
});

function releaseHold() {
  try { api.sendSync('dock:hold', false); } catch (_) { /* ignore */ }
}

document.addEventListener('pointerup', async (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  releaseHold();
  syncPass(e.clientX, e.clientY);
  if (ghost) { ghost.remove(); ghost = null; }
  d.el.classList.remove('dragging');
  document.querySelectorAll('.item.drop-target').forEach((n) => n.classList.remove('drop-target'));

  if (!d.moved) {
    openItem(d.id, d.el);
    return;
  }

  const under = document.elementFromPoint(e.clientX, e.clientY);
  const over = under && under.closest('.item');

  // 拖到 Dock 之外 → 从 Dock 移除
  const r = barEl.getBoundingClientRect();
  const M = 26;
  const outside = e.clientX < r.left - M || e.clientX > r.right + M || e.clientY < r.top - M || e.clientY > r.bottom + M;
  if (!over && outside) {
    if (d.el.dataset.kind === 'archive' || d.el.dataset.kind === 'system') return;
    await api.invoke('items:confirmRemove', d.id);
    return;
  }

  if (!over || over === d.el) return;
  const targetId = over.dataset.id;
  const targetKind = over.dataset.kind;
  if (targetKind === 'archive') return;

  const rect = over.getBoundingClientRect();
  const rel = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
  const center = rel > 0.32 && rel < 0.68;
  const dragKind = d.el.dataset.kind;
  if (dragKind === 'archive') return;

  // 拖到两侧是换位置；拖到图标中间才建组或放入分组。分组本身始终可以换位置。
  if (!center || dragKind === 'group' || dragKind === 'system' || targetKind === 'system' || d.shift) {
    await api.invoke('items:move', { id: d.id, targetId, after: rel >= 0.5 });
    return;
  }
  if (targetKind === 'group') {
    await api.invoke('items:toGroup', { itemId: d.id, groupId: targetId });
    return;
  }
  const id = await api.invoke('group:create', { name: '新建分组', itemIds: [targetId, d.id] });
  const el = document.querySelector(`[data-id="${id}"]`);
  if (el) el.classList.add('group-flash');
});

document.addEventListener('pointercancel', () => {
  if (!drag) return;
  if (ghost) { ghost.remove(); ghost = null; }
  drag.el.classList.remove('dragging');
  drag = null;
  releaseHold();
  resetMagnify();
});

window.addEventListener('blur', () => {
  if (!drag) return;
  if (ghost) { ghost.remove(); ghost = null; }
  drag.el.classList.remove('dragging');
  drag = null;
  releaseHold();
  resetMagnify();
});

async function openItem(id, el) {
  const r = await api.invoke('dock:open', id);
  if (!r || !r.ok) return;
  if (r.kind === 'group' || r.kind === 'archive') {
    const rect = el.getBoundingClientRect();
    await api.invoke('popup:open', {
      kind: r.kind,
      id,
      anchor: {
        cx: Math.round(window.screenX + rect.left + rect.width / 2),
        cy: Math.round(window.screenY + rect.top),
      },
    });
  }
}

/* --------------------------- 拖入文件添加图标 --------------------------- */
function pathsFromDrop(dt) {
  const out = [];
  if (!dt) return out;
  const files = Array.from(dt.files || []);
  for (const f of files) {
    let p = '';
    try { p = api.getPathForFile(f); } catch (_) { p = f.path || ''; }
    if (p) out.push(p);
  }
  if (!out.length) {
    // 兜底：某些来源只有 text/uri-list
    const raw = dt.getData('text/uri-list') || '';
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      try { out.push(decodeURIComponent(new URL(line).pathname).replace(/^\//, '')); } catch (_) {}
    }
  }
  return out;
}

let dropDepth = 0;

document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dropDepth++;
  document.body.classList.add('drop-file');
});

document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const over = el && el.closest('.item');
  document.querySelectorAll('.item.over-archive').forEach((n) => n.classList.remove('over-archive'));
  if (over && over.dataset.kind === 'archive') over.classList.add('over-archive');
});

document.addEventListener('dragleave', (e) => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) document.body.classList.remove('drop-file');
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropDepth = 0;
  document.body.classList.remove('drop-file');
  const paths = pathsFromDrop(e.dataTransfer);
  if (!paths.length) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const over = el && el.closest('.item');
  // 拖到「文件合集」图标上 = 直接放进 DeskGlow\文件收纳
  if (over && over.dataset.kind === 'archive') {
    await api.invoke('archive:addFiles', paths);
    return;
  }
  await api.invoke('items:add', paths);
});

/* --------------------------- 自动隐藏 --------------------------- */
function expand() {
  if (!autoHide) return;
  clearTimeout(collapseTimer);
  if (collapsed) {
    collapsed = false;
    document.body.dataset.collapsed = 'false';
  }
}

function scheduleCollapse() {
  if (!autoHide) return;
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    collapsed = true;
    document.body.dataset.collapsed = 'true';
  }, 620);
}

document.addEventListener('mousemove', expand);
document.addEventListener('mouseleave', scheduleCollapse);
document.addEventListener('mouseenter', expand);

// Windows 下窗口自动隐藏后收不到鼠标事件，改由主进程轮询光标位置来驱动
api.on('dock:expand', (on) => {
  if (on) expand();
  else scheduleCollapse();
});

/* --------------------------- 状态同步 --------------------------- */
function applyState(s) {
  state = s;
  applyAppearance(s.appearance);
  render();
}

api.on('state:update', applyState);

api.on('appearance:update', (a) => {
  if (!state || !a) return;
  state.appearance = a;
  applyAppearance(a);
  render();
});

(async () => {
  try {
    const boot = await api.invoke('dock:state');
    applyState(boot);
    if (boot.appearance && boot.appearance.autoHide) {
      collapsed = true;
      document.body.dataset.collapsed = 'true';
    }
  } catch (e) {
    console.error(e);
  }
  api.invoke('dock:painted').catch(() => {});
})();

window.addEventListener('resize', () => {
  clearTimeout(window.__dm);
  window.__dm = setTimeout(measure, 80);
});
// 开机后工作区会变。主进程发现缩放或任务栏占位变了，再量一次。
api.on('dock:remeasure', () => measure());
setTimeout(measure, 400);
// 收起动画和换行会改玻璃条的位置。只在框变了才告诉主进程，不碰绘制。
setInterval(publishHit, 150);

// Win+D / 「显示桌面」的可见性只由主进程 zorder.ps1 维持。
// 不要在这里做 rAF 心跳、改 opacity，或写一个无用样式来逼合成器重画。
// 透明窗口被这样强制重绘时，显示桌面下会整片变空，或者在壁纸上闪一块。
