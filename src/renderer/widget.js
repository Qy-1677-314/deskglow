'use strict';
/* 桌面画布：把每个元素按像素坐标摆到桌面上。
   层级只交给主进程的 zorder.sink()，这里不做置顶 / 重绘之类的补救。 */

const api = window.dg;
const F = window.DGFmt;
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const hud = $('hud');
const hudMenu = $('hudMenu');
const hudPos = $('hudPos');
const guideLayer = $('guides');
const marqueeEl = $('marquee');
const btnSnap = $('hudSnap');

let widgets = { elements: [] };
let battery = null;
let editing = false;
let selectedIds = new Set();   // 多选：Ctrl 点选 / 空白处拖拽框选
let primaryId = '';            // 主选中：工具条读数、缩放手柄只认它
let customFonts = [];
let rendered = new Map();      // id -> { root, body, el, kind, update }
let drag = null;
let pick = null;
let nudgeTimer = null;
let snapOn = true;
const loadedFonts = new Set();

const SNAP_PX = 7;             // 吸附距离（屏幕像素）
try { snapOn = localStorage.getItem('dg.snap') !== '0'; } catch (_) { /* 用默认值 */ }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function clamp(v, min, max, fb) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(min, Math.min(max, n));
}

/** #rrggbb + 百分比透明度 → rgba() */
function rgba(hex, alpha) {
  let h = String(hex || '#ffffff').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const a = Math.max(0, Math.min(100, Number(alpha) || 0)) / 100;
  if (!Number.isFinite(n) || h.length !== 6) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ------------------------------ 电量图形 ------------------------------ */
/** 并排模式的小电池图标（正方形，不被拉伸） */
function batterySvg(pct, charging, size) {
  const lv = pct == null ? 0 : Math.max(0, Math.min(16, Math.round((pct / 100) * 16)));
  const fill = lv > 0
    ? `<rect x="3.6" y="8.6" width="${lv}" height="6.8" rx="1.3" fill="currentColor" stroke="none"/>`
    : '';
  const bolt = charging
    ? `<path d="M12.7 6.4 8.3 12.5h3.1l-1 4.1 4.5-6.1h-3.1z" fill="currentColor" stroke="none"/>`
    : '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.8" y="7.4" width="17.4" height="9.2" rx="2.6"/><path d="M21.4 10.3v3.4"/>${fill}${bolt}</svg>`;
}

/* 电池外框的几何：viewBox 宽 128，身体占 2 ~ 118，正极凸起 120.5 ~ 125.5。
   电量条的左右边缘要跟「身体」对齐，不能延伸到正极底下。 */
const BAT_VB = 128;
const BAT_BODY_X = 2;
const BAT_BODY_W = 116;
const BAT_NUB_X = 120.5;
const BAT_NUB_W = 5;
const BAT_BODY_LEFT = `${((BAT_BODY_X / BAT_VB) * 100).toFixed(4)}%`;
const BAT_BODY_PCT = `${((BAT_BODY_W / BAT_VB) * 100).toFixed(4)}%`;

/** 重叠模式的电池外框：横向随内容拉长，描边用 non-scaling-stroke 保持粗细一致 */
function batteryShape(pct, charging, hasText, iconSize) {
  const ratio = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  const fw = (BAT_BODY_W - 9) * ratio;
  const sw = Math.max(1.4, Math.min(2.8, clamp(iconSize, 8, 96, 26) * 0.09));
  const fill = fw > 0.6
    ? `<rect x="6.5" y="12.5" width="${fw.toFixed(1)}" height="27" rx="6" fill="currentColor" stroke="none" opacity="${hasText ? 0.32 : 1}"/>`
    : '';
  const bolt = (charging && !hasText)
    ? `<path d="M71 11.5 55 31h9.2l-2.6 9.8L78 22.5h-9.2z" fill="currentColor" stroke="none"/>`
    : '';
  return `<svg viewBox="0 0 ${BAT_VB} 52" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="${sw.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round" overflow="visible">
    <rect x="${BAT_BODY_X}" y="7.5" width="${BAT_BODY_W}" height="37" rx="10.2" vector-effect="non-scaling-stroke"/>${fill}${bolt}
    <rect x="${BAT_NUB_X}" y="17.5" width="${BAT_NUB_W}" height="17" rx="2.4" fill="currentColor" stroke="none"/></svg>`;
}

/* ------------------------------ 元素内容 ------------------------------ */
function clockHtml(el) {
  const d = el.data || {};
  const txt = F.formatDate(new Date(), d.pattern || 'HH:mm', { tz: d.tz, h12: d.h12 });
  return `<span class="ln mono">${esc(txt)}</span>`;
}

function dateHtml(el) {
  const d = el.data || {};
  const now = new Date();
  let html = `<span class="ln">${esc(F.formatDate(now, d.pattern || 'YYYY年M月D日 ddd'))}</span>`;
  const p = F.parts(now, 'auto');
  const lunar = F.toLunar(p.year, p.month, p.day);
  if (d.lunar && lunar) {
    html += `<span class="sub" style="font-size:${clamp(d.lunarSize, 5, 80, 12)}px">农历${esc(F.lunarText(lunar))}</span>`;
  }
  if (d.holiday) {
    const f = F.festivalOf(p, lunar);
    if (f) html += `<span class="sub" style="font-size:${clamp(d.holidaySize, 5, 80, 12)}px">${esc(f)}</span>`;
  }
  return html;
}

function batteryHtml(el) {
  const d = el.data || {};
  const b = battery || {};
  const pct = b.percent == null ? null : Math.round(b.percent);
  const low = pct != null && pct <= clamp(d.low, 1, 100, 20) && !b.ac;
  const base = el.text.color || '#ffffff';
  const hot = low ? (d.lowColor || '#f0506e') : '';
  const iconColor = hot || d.iconColor || base;
  const barColor = hot || d.barColor || base;
  const numColor = hot || d.textColor || base;

  const iconSize = clamp(d.iconSize, 8, 96, 26);
  const barW = clamp(d.barW, 12, 400, 54);
  const barH = clamp(d.barH, 2, 24, 5);
  const fillPct = pct == null ? 0 : Math.max(2.5, Math.min(100, pct));

  const hasIcon = !!d.icon;
  const hasText = !!d.text;
  const txt = F.batteryText(d.pattern, b);
  if (!hasIcon && !d.bar && !hasText) return '';

  // 电量条：重叠模式跟电池「身体」同宽（跳过右侧正极），并排模式用固定宽度
  const track = (full) => (d.bar
    ? `<span class="bat-track${full ? ' sep' : ''}" style="${full
      ? `width:${BAT_BODY_PCT};margin-left:${BAT_BODY_LEFT}`
      : `width:${barW}px`};height:${barH}px;background:${rgba(barColor, 24)}"><i style="width:${fillPct}%;background:${barColor}"></i></span>`
    : '');

  // 重叠：百分比压在电池里；外框宽度由文字撑开，字号再大也不会溢出去。
  // 外面套一层 bat-stack，电量条的百分比宽度才有统一的参照系（跟外框同一宽度）。
  if (d.inline && hasIcon) {
    const hasShadow = !!(el.text && el.text.shadow && el.text.shadow.on);
    const numStyle = `color:${numColor}`
      + (hasShadow ? '' : ';text-shadow:0 1px 2px rgba(0,0,0,.6),0 0 3px rgba(0,0,0,.45)');
    const bolt = b.charging
      ? `<svg class="bat-bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 5.5 13.2h4.6L9 22l7.6-11.4h-4.7z"/></svg>`
      : '';
    return `<div class="bat-stack" style="--ic:${iconSize}px;color:${iconColor}">
        <div class="bat-inline">
          <span class="bat-shape" aria-hidden="true">${batteryShape(pct, b.charging, hasText, iconSize)}</span>
          ${hasText ? `<span class="bat-num" style="${numStyle}">${bolt}${esc(txt)}</span>` : ''}
        </div>
        ${track(true)}
      </div>`;
  }

  // 并排：图标 + 电量条 + 百分比
  const icon = hasIcon ? `<span class="bat-ic" style="color:${iconColor}">${batterySvg(pct, b.charging, iconSize)}</span>` : '';
  const num = hasText ? `<span class="bat-num" style="color:${numColor}">${esc(txt)}</span>` : '';
  return `<div class="bat-row">${icon}${track(false)}${num}</div>`;
}

function imageHtml(el, editMode) {
  const d = el.data || {};
  if (d.src) {
    const fit = ['contain', 'cover', 'fill'].includes(d.fit) ? d.fit : 'contain';
    return `<img class="el-img" src="${esc(d.src)}" alt="" draggable="false" style="object-fit:${fit}">`;
  }
  if (!editMode) return '';
  return `<div class="el-img" style="display:flex;align-items:center;justify-content:center;border:1px dashed rgba(140,146,170,.7);border-radius:inherit;font-size:12px;opacity:.8">选择图片</div>`;
}

function bodyHtml(el, editMode) {
  if (el.type === 'clock') return clockHtml(el);
  if (el.type === 'date') return dateHtml(el);
  if (el.type === 'battery') return batteryHtml(el);
  if (el.type === 'image') return imageHtml(el, editMode);
  return `<span class="ln">${esc((el.data && el.data.content) || '')}</span>`;
}

/* ------------------------------ 框子贴文字 ------------------------------ */
/* 编辑态的虚线框要贴着文字墨迹，不能留一圈由 line-height 和字体升部撑出来的空
   （46px 的时钟能空出 15px，对齐时根本瞄不准）。做法：用 canvas 量出每行文字
   的真实墨迹（actualBoundingBox*），再把 .elbody 首尾子元素的 margin 收成负数，
   把盒子削到墨迹上 —— 文字位置不动，只是框子和背景跟着收拢。
   手动设过宽高的元素按用户的尺寸来，不削。 */
const inkCtx = document.createElement('canvas').getContext('2d');
const TEXT_TIGHT = new Set(['clock', 'date', 'text']);

function fontCtx(style) {
  inkCtx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if ('letterSpacing' in inkCtx) inkCtx.letterSpacing = style.letterSpacing || 'normal';
}

/** 多行文字按行切开：逐字符量 rect，top 相同的归一行 */
function splitLines(range, textNode) {
  const lines = [];
  const s = textNode.nodeValue;
  for (let i = 0; i < s.length; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const r = range.getBoundingClientRect();
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.top - last.top) < 0.6) last.text += s[i];
    else if (r.width || r.height) lines.push({ top: r.top, left: r.left, right: r.right, text: s[i] });
    else if (last) last.text += s[i];
  }
  return lines;
}

/** 墨迹相对 .elbody 边框盒的四周余量；量不到文字返回 null */
function inkSlack(body) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  if (!nodes.some((t) => t.nodeValue && t.nodeValue.trim())) return null;

  const bb = body.getBoundingClientRect();
  const range = document.createRange();
  let top = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  let leftAligned = true;

  for (const t of nodes) {
    if (!t.nodeValue || !t.nodeValue.trim()) continue;
    const host = t.parentElement;
    if (!host) continue;
    const st = getComputedStyle(host);
    fontCtx(st);
    const fs = parseFloat(st.fontSize) || 16;
    if (st.textAlign !== 'left') leftAligned = false;
    range.selectNodeContents(t);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    if (!rects.length) continue;
    // Range 的 rect 是「字体盒」（升部+降部），所以基线 = rect.top + fontBoundingBoxAscent
    const lines = rects.length === 1
      ? [{ top: rects[0].top, left: rects[0].left, right: rects[0].right, text: t.nodeValue }]
      : splitLines(range, t);
    for (const ln of lines) {
      if (!ln.text) continue;
      const m = inkCtx.measureText(ln.text);
      const base = ln.top + (m.fontBoundingBoxAscent || fs * 0.8);
      top = Math.min(top, base - (m.actualBoundingBoxAscent || 0));
      bottom = Math.max(bottom, base + (m.actualBoundingBoxDescent || 0));
      right = Math.max(right, ln.left + (m.actualBoundingBoxRight || m.width));
    }
  }
  if (!Number.isFinite(top)) return null;
  return {
    // 上沿钳到 0：墨迹顶到盒子上方时不把盒子往上顶（那会把文字挤动），
    // 宁可让高高的升部尖角冒出虚线一点点；下沿不钳，descender 该包住就包住
    top: Math.max(0, top - bb.top),
    bottom: bb.bottom - bottom,
    right: leftAligned ? Math.max(0, bb.right - right) : 0,
  };
}

/** 把元素盒子削到文字墨迹上（幂等：尺寸被手动改过时会把之前的削掉清回去） */
function tightenBox(node) {
  const { root, body, el } = node;
  const kids = body.children;
  if (!kids.length || !TEXT_TIGHT.has(el.type)) return;
  const first = kids[0];
  const last = kids[kids.length - 1];

  let m = null;
  if (!el.h) {
    // 旋转时量的是轴对齐包围盒，先临时去掉旋转，量完再放回去（同一任务内，不会闪）
    const tf = root.style.transform;
    if (tf && tf !== 'none') root.style.transform = 'none';
    m = inkSlack(body);
    if (tf && tf !== 'none') root.style.transform = tf;
  }

  first.style.marginTop = m ? `${-m.top}px` : '';
  last.style.marginBottom = m ? `${-m.bottom}px` : '';
  // 右边只在「没手动设宽 + 左对齐」时收：居中 / 靠右时负 margin 会把文字挤动
  body.style.marginRight = (!el.w && m && m.right > 0) ? `${-m.right}px` : '';
}

/* ------------------------------ 样式 ------------------------------ */
function boxStyle(el) {
  const s = [`left:${el.x}px`, `top:${el.y}px`];
  if (el.w) s.push(`width:${el.w}px`);
  if (el.h) s.push(`height:${el.h}px`);
  if (el.rotate) s.push(`transform:rotate(${el.rotate}deg)`);
  if (el.opacity < 100) s.push(`opacity:${clamp(el.opacity, 0, 100, 100) / 100}`);
  if (el.pad) s.push(`padding:${el.pad}px`);
  if (el.radius) s.push(`border-radius:${el.radius}px`);
  if (el.bg && el.bg.on) s.push(`background:${rgba(el.bg.color, el.bg.alpha)}`);
  if (el.shadow && el.shadow.on) {
    s.push(`box-shadow:0 ${clamp(el.shadow.y, -40, 40, 0)}px ${clamp(el.shadow.blur, 0, 80, 0)}px ${rgba(el.shadow.color, el.shadow.alpha)}`);
  }
  return s.join(';');
}

function textStyle(el) {
  const t = el.text || {};
  const stack = (t.font ? `'${String(t.font).replace(/'/g, '')}', ` : '')
    + "'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif";
  const s = [
    `font-size:${clamp(t.size, 5, 240, 16)}px`,
    `font-weight:${Math.round(clamp(t.weight, 100, 900, 500) / 100) * 100}`,
    `font-style:${t.italic ? 'italic' : 'normal'}`,
    `text-decoration:${t.underline ? 'underline' : 'none'}`,
    `letter-spacing:${clamp(t.letter, -10, 40, 0)}px`,
    `line-height:${clamp(t.line, 0.8, 3, 1.25)}`,
    `color:${t.color || '#ffffff'}`,
    `font-family:${stack}`,
    `text-align:${el.align || 'left'}`,
  ];
  if (t.shadow && t.shadow.on) {
    s.push(`text-shadow:0 ${clamp(t.shadow.y, -40, 40, 0)}px ${clamp(t.shadow.blur, 0, 60, 0)}px ${rgba(t.shadow.color, t.shadow.alpha)}`);
  }
  return s.join(';');
}

/* ------------------------------ 渲染 ------------------------------ */
function buildNode(el) {
  const root = document.createElement('div');
  root.className = 'el'
    + (el.align === 'center' ? ' al-center' : el.align === 'right' ? ' al-right' : '')
    + (el.h ? ' fixed-h' : '');
  root.dataset.id = el.id;
  root.style.cssText = boxStyle(el) + ';' + textStyle(el);
  if (!el.visible) root.style.opacity = String(0.35);

  const body = document.createElement('div');
  body.className = 'elbody';
  body.innerHTML = bodyHtml(el, editing);
  root.appendChild(body);

  const node = { root, body, el, kind: el.type };
  node.update = () => {
    if (node.kind !== 'clock' && node.kind !== 'date' && node.kind !== 'battery') return;
    const html = bodyHtml(node.el, editing);
    if (body.innerHTML !== html) {
      body.innerHTML = html;
      tightenBox(node);
    }
  };
  return node;
}

function render() {
  if (drag || pick) return;
  stage.textContent = '';
  rendered.clear();
  const list = (widgets.elements || []).map(F.normalizeElement);
  for (const el of list) {
    if (!el.visible && !editing) continue;
    // 台式机没有电池时不显示电量，但编辑时留着，否则没法调位置
    if (el.type === 'battery' && battery && battery.hasBattery === false && !editing) continue;
    const node = buildNode(el);
    stage.appendChild(node.root);
    // 必须等挂进文档再量：脱离文档的元素没有布局，量出来全是 0
    tightenBox(node);
    rendered.set(el.id, node);
  }
  // 元素被删掉 / 被隐藏后，选中集合要跟着收敛
  for (const id of [...selectedIds]) if (!rendered.has(id)) selectedIds.delete(id);
  if (!rendered.has(primaryId)) primaryId = [...selectedIds].pop() || '';
  applySelection();
  updateHudPos();
  ensureFonts(list);
}

function refreshDynamic() {
  for (const node of rendered.values()) {
    if (node.kind === 'clock' || node.kind === 'date') node.update();
  }
}

function refreshBatteryNodes() {
  for (const node of rendered.values()) if (node.kind === 'battery') node.update();
}

/* ------------------------------ 几何 ------------------------------ */
function rectOf(node) {
  const r = node.root;
  return { x: r.offsetLeft, y: r.offsetTop, w: r.offsetWidth, h: r.offsetHeight };
}

/** 一组元素的包围盒（用 layout 坐标，忽略旋转，够用且稳） */
function boundsOf(ids) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const id of ids) {
    const n = rendered.get(id);
    if (!n) continue;
    const r = rectOf(n);
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 吸附参照线：屏幕左右中 / 上下中 + 其它元素的左中右、上中下 */
function snapTargets(exclude) {
  const xs = [0, Math.round(window.innerWidth / 2), window.innerWidth];
  const ys = [0, Math.round(window.innerHeight / 2), window.innerHeight];
  for (const [id, node] of rendered) {
    if (exclude.has(id)) continue;
    const r = rectOf(node);
    xs.push(r.x, Math.round(r.x + r.w / 2), r.x + r.w);
    ys.push(r.y, Math.round(r.y + r.h / 2), r.y + r.h);
  }
  return { xs, ys };
}

/** 在 values 里挑一个离参照线最近、且在阈值内的位移 */
function bestSnap(values, targets) {
  let best = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) > SNAP_PX) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, t };
    }
  }
  return best;
}

function showGuides(list) {
  guideLayer.textContent = '';
  if (!list.length) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  for (const g of list) {
    const line = document.createElement('i');
    if (g.axis === 'x') {
      line.className = 'gx';
      line.style.left = `${g.v}px`;
      line.style.top = '0';
      line.style.height = `${H}px`;
    } else {
      line.className = 'gy';
      line.style.top = `${g.v}px`;
      line.style.left = '0';
      line.style.width = `${W}px`;
    }
    guideLayer.appendChild(line);
  }
}

function clearGuides() {
  // 参考线是空 <i>，textContent 永远是空串，只能看子节点数量
  if (guideLayer.childElementCount) guideLayer.textContent = '';
}

/* ------------------------------ 选中与手柄 ------------------------------ */
function applySelection() {
  for (const [id, node] of rendered) {
    node.root.classList.toggle('sel', editing && selectedIds.has(id));
    node.root.classList.toggle('sel-primary', editing && selectedIds.size > 1 && id === primaryId);
    for (const h of node.root.querySelectorAll('.hz')) h.remove();
  }
  // 手柄只在单选时出现，多选时拖整组更方便
  const single = editing && selectedIds.size === 1 ? rendered.get(primaryId) : null;
  if (single) {
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const i = document.createElement('i');
      i.className = 'hz';
      i.dataset.h = h;
      single.root.appendChild(i);
    }
  }
  const any = editing && selectedIds.size > 0;
  for (const b of document.querySelectorAll('#hudAlign .hud-ico')) b.disabled = !any;
  const label = $('hudAlignLabel');
  if (label) label.textContent = selectedIds.size > 1 ? '互相对齐' : '对齐';
}

function setSelection(ids, primary) {
  selectedIds = new Set(ids.filter((id) => rendered.has(id)));
  primaryId = primary && selectedIds.has(primary) ? primary : ([...selectedIds].pop() || '');
  applySelection();
  updateHudPos();
}

function updateHudPos() {
  if (!editing) { hudPos.textContent = ''; return; }
  const n = selectedIds.size;
  if (!n) { hudPos.textContent = '未选中元素'; return; }
  if (n === 1) {
    const node = rendered.get(primaryId);
    if (!node) { hudPos.textContent = '未选中元素'; return; }
    const r = rectOf(node);
    hudPos.textContent = `x ${Math.round(node.el.x)} · y ${Math.round(node.el.y)} · ${r.w}×${r.h}`;
    return;
  }
  const box = boundsOf(selectedIds);
  hudPos.textContent = box ? `已选 ${n} 个 · ${box.w}×${box.h}` : `已选 ${n} 个`;
}

/* ------------------------------ 拖动 / 缩放 / 框选 ------------------------------ */
function onPointerDown(e) {
  if (!editing || e.button !== 0) return;

  const handle = e.target.closest ? e.target.closest('.hz') : null;
  const root = e.target.closest ? e.target.closest('.el') : null;

  if (!root) {
    startMarquee(e);
    return;
  }

  const id = root.dataset.id;
  if (!rendered.has(id)) return;

  // Ctrl / Cmd 点选：加入或移出选择，不动位置
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      if (primaryId === id) primaryId = [...selectedIds].pop() || '';
    } else {
      selectedIds.add(id);
      primaryId = id;
    }
    applySelection();
    updateHudPos();
    return;
  }

  if (!selectedIds.has(id)) setSelection([id], id);
  else if (primaryId !== id) { primaryId = id; applySelection(); updateHudPos(); }

  const node = rendered.get(id);
  if (!node) return;
  e.preventDefault();

  if (handle) {
    const r = rectOf(node);
    const targets = snapTargets(new Set([id]));
    drag = {
      mode: 'resize',
      id,
      root,
      node,
      dir: handle.dataset.h,
      sx: e.screenX,
      sy: e.screenY,
      ox: node.el.x,
      oy: node.el.y,
      ow: node.el.w || r.w,
      oh: node.el.h || r.h,
      nx: node.el.x,
      ny: node.el.y,
      nw: node.el.w || r.w,
      nh: node.el.h || r.h,
      targets,
      moved: false,
    };
  } else {
    const ids = [...selectedIds];
    const box = boundsOf(ids) || rectOf(node);
    const start = new Map();
    for (const sid of ids) {
      const n = rendered.get(sid);
      if (n) start.set(sid, { x: n.el.x, y: n.el.y });
    }
    drag = {
      mode: 'move',
      ids,
      start,
      box,
      sx: e.screenX,
      sy: e.screenY,
      targets: snapTargets(selectedIds),
      moved: false,
    };
  }
  try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
}

function moveBy(dx, dy) {
  for (const sid of drag.ids) {
    const n = rendered.get(sid);
    const st = drag.start.get(sid);
    if (!n || !st) continue;
    n.el.x = st.x + dx;
    n.el.y = st.y + dy;
    n.root.style.left = `${n.el.x}px`;
    n.root.style.top = `${n.el.y}px`;
  }
}

function onPointerMove(e) {
  if (pick) { moveMarquee(e); return; }
  if (!drag) return;
  const rawX = Math.round(e.screenX - drag.sx);
  const rawY = Math.round(e.screenY - drag.sy);

  if (drag.mode === 'move') {
    let dx = rawX;
    let dy = rawY;
    let nx = Math.round(drag.box.x + dx);
    let ny = Math.round(drag.box.y + dy);
    // 先把整组按回屏幕里，再吸附，免得吸附把人往画面外拽
    if (nx < 0) { dx -= nx; nx = 0; }
    if (ny < 0) { dy -= ny; ny = 0; }

    const guides = [];
    if (drag.targets && snapOn && !e.altKey) {
      const sx = bestSnap([nx, nx + drag.box.w / 2, nx + drag.box.w], drag.targets.xs);
      if (sx) { dx += sx.d; nx += sx.d; guides.push({ axis: 'x', v: sx.t }); }
      const sy = bestSnap([ny, ny + drag.box.h / 2, ny + drag.box.h], drag.targets.ys);
      if (sy) { dy += sy.d; ny += sy.d; guides.push({ axis: 'y', v: sy.t }); }
    }
    showGuides(guides);
    moveBy(dx, dy);
    drag.moved = true;
    updateHudPos();
    return;
  }

  // 缩放
  const d = drag.dir;
  let x = drag.ox;
  let y = drag.oy;
  let w = drag.ow;
  let h = drag.oh;
  if (d.indexOf('e') >= 0) w = drag.ow + rawX;
  if (d.indexOf('s') >= 0) h = drag.oh + rawY;
  if (d.indexOf('w') >= 0) { w = drag.ow - rawX; x = drag.ox + rawX; }
  if (d.indexOf('n') >= 0) { h = drag.oh - rawY; y = drag.oy + rawY; }

  const guides = [];
  if (drag.targets && snapOn && !e.altKey) {
    if (d.indexOf('w') >= 0) {
      const s = bestSnap([x], drag.targets.xs);
      if (s) { x += s.d; w -= s.d; guides.push({ axis: 'x', v: s.t }); }
    }
    if (d.indexOf('e') >= 0) {
      const s = bestSnap([x + w], drag.targets.xs);
      if (s) { w += s.d; guides.push({ axis: 'x', v: s.t }); }
    }
    if (d.indexOf('n') >= 0) {
      const s = bestSnap([y], drag.targets.ys);
      if (s) { y += s.d; h -= s.d; guides.push({ axis: 'y', v: s.t }); }
    }
    if (d.indexOf('s') >= 0) {
      const s = bestSnap([y + h], drag.targets.ys);
      if (s) { h += s.d; guides.push({ axis: 'y', v: s.t }); }
    }
  }
  showGuides(guides);

  drag.nw = Math.max(16, Math.round(w));
  drag.nh = Math.max(16, Math.round(h));
  drag.nx = Math.max(0, Math.round(x));
  drag.ny = Math.max(0, Math.round(y));
  drag.root.style.left = `${drag.nx}px`;
  drag.root.style.top = `${drag.ny}px`;
  drag.root.style.width = `${drag.nw}px`;
  drag.root.style.height = `${drag.nh}px`;
  drag.root.classList.add('fixed-h');
  drag.node.el.x = drag.nx;
  drag.node.el.y = drag.ny;
  // 手动定过尺寸了，把「贴文字」削掉的余量清回去，框子按用户的尺寸来
  tightenBox(drag.node);
  drag.moved = true;
  updateHudPos();
}

function onPointerUp() {
  if (pick) { endMarquee(); return; }
  if (!drag) return;
  const d = drag;
  drag = null;
  clearGuides();
  if (!d.moved) return;

  if (d.mode === 'resize') {
    api.invoke('widget:element:move', { id: d.id, x: d.nx, y: d.ny, w: d.nw, h: d.nh }).catch(() => { /* ignore */ });
    return;
  }
  const items = [];
  for (const sid of d.ids) {
    const n = rendered.get(sid);
    if (!n) continue;
    items.push({ id: sid, x: Math.round(n.el.x), y: Math.round(n.el.y) });
  }
  if (!items.length) return;
  api.invoke('widget:elements:move', { items }).catch(() => { /* ignore */ });
}

/* ------------------------------ 框选 ------------------------------ */
function startMarquee(e) {
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  pick = {
    sx: e.clientX,
    sy: e.clientY,
    x: e.clientX,
    y: e.clientY,
    additive,
    base: additive ? new Set(selectedIds) : new Set(),
  };
  if (!additive) { selectedIds.clear(); primaryId = ''; applySelection(); updateHudPos(); }
  marqueeEl.hidden = false;
  marqueeEl.style.left = `${e.clientX}px`;
  marqueeEl.style.top = `${e.clientY}px`;
  marqueeEl.style.width = '0px';
  marqueeEl.style.height = '0px';
  try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
}

function moveMarquee(e) {
  if (!pick) return;
  const x1 = Math.min(pick.sx, e.clientX);
  const y1 = Math.min(pick.sy, e.clientY);
  const x2 = Math.max(pick.sx, e.clientX);
  const y2 = Math.max(pick.sy, e.clientY);
  pick.x = x2;
  pick.y = y2;
  marqueeEl.style.left = `${x1}px`;
  marqueeEl.style.top = `${y1}px`;
  marqueeEl.style.width = `${x2 - x1}px`;
  marqueeEl.style.height = `${y2 - y1}px`;

  const next = new Set(pick.base);
  for (const [id, node] of rendered) {
    const r = rectOf(node);
    if (r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1) next.add(id);
  }
  const primary = next.has(primaryId) ? primaryId : ([...next].pop() || '');
  setSelection([...next], primary);
}

function endMarquee() {
  pick = null;
  marqueeEl.hidden = true;
}

stage.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
window.addEventListener('blur', onPointerUp);

/* ------------------------------ 键盘 ------------------------------ */
window.addEventListener('keydown', (e) => {
  if (!editing) return;
  if (e.key === 'Escape') { e.preventDefault(); api.invoke('widget:edit', false).catch(() => {}); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    const all = [...rendered.keys()];
    setSelection(all, all[all.length - 1] || '');
    return;
  }
  if (!selectedIds.size) return;
  const step = e.shiftKey ? 10 : 1;
  const delta = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
  }[e.key];
  if (!delta) return;
  e.preventDefault();
  const items = [];
  for (const id of selectedIds) {
    const node = rendered.get(id);
    if (!node) continue;
    node.el.x = Math.max(0, node.el.x + delta[0]);
    node.el.y = Math.max(0, node.el.y + delta[1]);
    node.root.style.left = `${node.el.x}px`;
    node.root.style.top = `${node.el.y}px`;
    items.push({ id, x: Math.round(node.el.x), y: Math.round(node.el.y) });
  }
  updateHudPos();
  if (!items.length) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    api.invoke('widget:elements:move', { items }).catch(() => { /* ignore */ });
  }, 220);
});

/* ------------------------------ 对齐 ------------------------------ */
/** 单选：对齐到屏幕；多选：组内互相对齐（左对齐到最左那个…） */
function alignSelected(kind) {
  if (!selectedIds.size) return;
  const multi = selectedIds.size > 1;
  const box = boundsOf(selectedIds) || { x: 0, y: 0, w: 0, h: 0 };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const items = [];

  for (const id of selectedIds) {
    const node = rendered.get(id);
    if (!node) continue;
    const r = rectOf(node);
    let x = node.el.x;
    let y = node.el.y;

    if (multi) {
      if (kind === 'left') x = box.x;
      if (kind === 'hcenter') x = Math.round(box.x + (box.w - r.w) / 2);
      if (kind === 'right') x = box.x + box.w - r.w;
      if (kind === 'top') y = box.y;
      if (kind === 'vcenter') y = Math.round(box.y + (box.h - r.h) / 2);
      if (kind === 'bottom') y = box.y + box.h - r.h;
    } else {
      if (kind === 'left') x = 0;
      if (kind === 'hcenter') x = Math.round((W - r.w) / 2);
      if (kind === 'right') x = W - r.w;
      if (kind === 'top') y = 0;
      if (kind === 'vcenter') y = Math.round((H - r.h) / 2);
      if (kind === 'bottom') y = H - r.h;
    }

    x = Math.max(0, x);
    y = Math.max(0, y);
    node.el.x = x;
    node.el.y = y;
    node.root.style.left = `${x}px`;
    node.root.style.top = `${y}px`;
    items.push({ id, x: Math.round(x), y: Math.round(y) });
  }

  updateHudPos();
  if (items.length) api.invoke('widget:elements:move', { items }).catch(() => { /* ignore */ });
}

/* ------------------------------ 工具条 ------------------------------ */
function buildAddMenu() {
  hudMenu.innerHTML = F.ELEMENT_TYPES.map((t) => {
    const d = F.ELEMENT_DEFS[t];
    return `<button data-type="${t}"><span class="mi">${esc(d.short)}</span><span class="mtxt">${esc(d.label)}<small>${esc(d.desc)}</small></span></button>`;
  }).join('');
}

function syncSnap() {
  btnSnap.classList.toggle('on', snapOn);
  btnSnap.setAttribute('aria-pressed', String(snapOn));
}

btnSnap.onclick = (e) => {
  e.stopPropagation();
  snapOn = !snapOn;
  try { localStorage.setItem('dg.snap', snapOn ? '1' : '0'); } catch (_) { /* ignore */ }
  syncSnap();
};

$('hudAdd').onclick = (e) => {
  e.stopPropagation();
  hudMenu.hidden = !hudMenu.hidden;
};

hudMenu.onclick = async (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  hudMenu.hidden = true;
  const el = await api.invoke('widget:element:add', { type: btn.dataset.type }).catch(() => null);
  if (el && el.id) setSelection([el.id], el.id);
};

document.addEventListener('pointerdown', (e) => {
  if (!hudMenu.hidden && !e.target.closest('.hud-group')) hudMenu.hidden = true;
});

for (const b of document.querySelectorAll('#hudAlign .hud-ico')) {
  b.onclick = () => alignSelected(b.dataset.align);
}

$('hudDone').onclick = () => { api.invoke('widget:edit', false).catch(() => {}); };

/* ------------------------------ 字体 ------------------------------ */
async function ensureFonts(list) {
  if (!customFonts.length) return;
  const map = new Map(customFonts.map((f) => [f.family, f.url]));
  for (const el of list) {
    const fam = el.text && el.text.font;
    if (!fam || loadedFonts.has(fam)) continue;
    const url = map.get(fam);
    if (!url) continue;
    loadedFonts.add(fam);
    try {
      const face = new FontFace(fam, `url("${url}")`);
      await face.load();
      document.fonts.add(face);
      render();
    } catch (err) {
      loadedFonts.delete(fam);
      console.warn('[widget] 字体加载失败', fam, err && err.message);
    }
  }
}

/* ------------------------------ 状态同步 ------------------------------ */
function applyEdit(on) {
  const next = !!on;
  if (next === editing) return;
  editing = next;
  document.body.classList.toggle('editing', editing);
  hud.hidden = !editing;
  if (!editing) {
    selectedIds.clear();
    primaryId = '';
    hudMenu.hidden = true;
    clearGuides();
    endMarquee();
  }
  render();
}

function applyState(payload) {
  if (!payload) return;
  if (payload.widgets) widgets = payload.widgets;
  if (Array.isArray(payload.fonts)) customFonts = payload.fonts;
  if (typeof payload.edit === 'boolean' && payload.edit !== editing) {
    applyEdit(payload.edit);
    return;
  }
  // 自己拖动 / 对齐后主进程会把新坐标广播回来，画面已经是最新，不必整层重建
  if (payload.src === 'canvas' && !drag && !pick) {
    for (const el of (widgets.elements || [])) {
      const node = rendered.get(el.id);
      if (node) node.el = Object.assign(node.el, { x: el.x, y: el.y, w: el.w, h: el.h });
    }
    updateHudPos();
    return;
  }
  render();
}

api.on('widgets:update', (payload) => applyState(payload));

api.on('widget:battery', (b) => {
  const had = battery && battery.hasBattery;
  battery = b;
  // 台式机忽然被识别成「没有电池」时要整块拿掉，光刷新内容不够
  if (had !== (b && b.hasBattery)) render();
  else refreshBatteryNodes();
});

api.on('widget:edit', (on) => applyEdit(on));

(async () => {
  buildAddMenu();
  syncSnap();
  try {
    const boot = await api.invoke('widget:state');
    if (boot) {
      widgets = boot.widgets || widgets;
      battery = boot.battery || null;
      customFonts = Array.isArray(boot.fonts) ? boot.fonts : [];
      if (boot.edit) applyEdit(true);
      else render();
    }
  } catch (e) {
    console.error(e);
  }
  render();
  // 整秒刷新，秒数不会因为定时器漂移而跳字
  const loop = () => {
    try { refreshDynamic(); } catch (_) { /* ignore */ }
    setTimeout(loop, 1000 - (Date.now() % 1000) + 16);
  };
  loop();
})();

window.addEventListener('resize', () => render());
