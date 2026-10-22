'use strict';

const api = window.dg;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (s) =>
  String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;
let loginItem = false;
let taskbarStatus = null;
let currentPage = 'overview';
let selectedForGroup = new Set();
let openIconGroup = '';
let appInit = false;

/* ------------------------------ 通用 ------------------------------ */
function toast(text, type = 'ok') {
  const wrap = $('#toasts');
  const d = document.createElement('div');
  d.className = 'toast ' + type;
  d.textContent = text;
  wrap.appendChild(d);
  setTimeout(() => {
    d.style.transition = 'opacity .25s, transform .25s';
    d.style.opacity = '0';
    d.style.transform = 'translateY(8px)';
    setTimeout(() => d.remove(), 260);
  }, 2400);
}

const SVG = {
  up: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  center: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M8 12h8M4 17h16"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h3.6c.5 0 1 .2 1.4.6l1 1.2c.3.4.8.6 1.3.6H19a2 2 0 0 1 2 2v6.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/></svg>',
};

function iconHTML(it, cls = 'ico') {
  if (it.icon) return `<img class="${cls}" src="${it.icon}" alt="" />`;
  return `<div class="fb">${esc((it.name || '?').charAt(0).toUpperCase())}</div>`;
}

/* ------------------------------ 导航 ------------------------------ */
const PAGE_META = {
  overview: { t: '概览', d: '看一眼桌面整理得怎么样' },
  shortcuts: { t: '快捷方式', d: '调整图标顺序，决定哪些出现在 Dock', actions: '<button class="btn" id="aOpenFolder">打开文件夹</button><button class="btn" id="aTidy">收进文件夹</button><button class="btn" id="aScan">扫描桌面</button><button class="btn primary" id="aAdd">添加…</button>' },
  appearance: { t: '外观', d: '按图标、底板、位置分开调，预览会马上跟着变' },
  widgets: { t: '小组件', d: '时钟、日期、电量、文本、图片，摆在桌面任意位置' },
  groups: { t: '分组', d: '把同类图标收在一起', actions: '<button class="btn" id="aCollapseAll">解散全部</button>' },
  archive: { t: '文件', d: '桌面文件的统一入口' },
  about: { t: '关于', d: '版本与数据' },
};

function go(page) {
  if (page === 'taskbar') page = 'appearance'; // 任务栏已并入外观设置
  currentPage = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  const meta = PAGE_META[page] || {};
  $('#pageTitle').textContent = meta.t || '';
  $('#pageDesc').textContent = meta.d || '';
  $('#pageActions').innerHTML = meta.actions || '';
  wirePageActions();
  $('#content').scrollTop = 0;
  renderPage(page);
}

function wirePageActions() {
  const scan = $('#aScan');
  if (scan) scan.onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '扫描中…';
    await api.invoke('scan:prompt');
    await refreshUnused();
    renderShortcuts();
    btn.textContent = '扫描桌面';
    btn.disabled = false;
  };
  const openFolder = $('#aOpenFolder');
  if (openFolder) openFolder.onclick = () => api.invoke('vault:open', 'shortcuts');
  const add = $('#aAdd');
  if (add) add.onclick = async () => {
    const paths = await api.invoke('dialog:pickFiles');
    if (paths.length) {
      const n = await api.invoke('items:add', paths);
      toast(`已添加 ${n} 个程序`);
    }
  };
  const tidy = $('#aTidy');
  if (tidy) tidy.onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '整理中…';
    const n = await api.invoke('vault:importShortcuts');
    btn.disabled = false;
    btn.textContent = old;
    toast(n ? `已移入文件夹 ${n} 个，文件都还在` : '桌面上没有要移动的快捷方式');
  };
  const collapse = $('#aCollapseAll');
  if (collapse) collapse.onclick = async () => {
    for (const g of (state.items || []).filter((i) => i.kind === 'group')) {
      await api.invoke('group:delete', { id: g.id, keepChildren: true });
    }
    toast('分组已还原为独立图标');
  };
  const rtb = $('#aRefreshTb');
  if (rtb) rtb.onclick = async () => {
    rtb.disabled = true;
    taskbarStatus = await api.invoke('taskbar:status');
    renderTaskbar();
    rtb.disabled = false;
    toast('状态已刷新');
  };
}

$$('.nav-item').forEach((b) => (b.onclick = () => go(b.dataset.page)));

/* ------------------------------ 渲染入口 ------------------------------ */
function renderAll() {
  if (!state) return;
  renderOverview();
  renderShortcuts();
  renderGroups();
  renderArchive();
  renderAppearance();
  renderWidgets();
  renderTaskbar();
  $('#verTag').textContent = 'v' + state.version;
  $('#aboutVer').textContent = state.version;
  $('#cfgPath').textContent = state.configPath;
}

function renderPage(page) {
  if (!state) return;
  if (page === 'overview') renderOverview();
  if (page === 'shortcuts') renderShortcuts();
  if (page === 'groups') renderGroups();
  if (page === 'archive') renderArchive();
  if (page === 'appearance') { renderAppearance(); renderTaskbar(); }
  if (page === 'widgets') {
    renderWidgets();
    loadFontLists();
  }
}

function viewFingerprint(s) {
  if (!s) return '';
  const items = (s.items || []).map((i) => [
    i.id, i.kind, i.name, i.count, i.missing ? 1 : 0,
    i.kind === 'group' ? `${i.icon || '-'}/${(i.iconSrc || '').length}` : (i.icon || '').length,
    (i.preview || []).join(',').length,
    (i.children || []).map((c) => `${c.id}:${c.path}:${(c.icon || '').length}`).join(','),
  ].join(':')).join(';');
  const a = s.archive || {};
  const v = s.vault || {};
  const st = s.stats || {};
  return [
    items,
    (a.extensions || []).join(','),
    a.includeFolders ? 1 : 0,
    a.includeOther ? 1 : 0,
    st.archiveCount,
    v.desktopFiles,
    v.desktopShortcuts,
  ].join('|');
}

async function syncViews(prev, next) {
  const itemsChanged = viewFingerprint(prev) !== viewFingerprint(next);
  const appChanged = JSON.stringify((prev && prev.appearance) || null) !== JSON.stringify(next.appearance || null);
  const widgetsChanged = JSON.stringify((prev && prev.widgets) || null) !== JSON.stringify(next.widgets || null);
  const uiChanged = JSON.stringify((prev && prev.ui) || null) !== JSON.stringify(next.ui || null);
  if (itemsChanged && currentPage === 'shortcuts') await refreshUnused();
  if (itemsChanged || appChanged || uiChanged) renderOverview();
  if (currentPage === 'shortcuts' && itemsChanged) renderShortcuts();
  if (currentPage === 'groups' && itemsChanged) renderGroups();
  if (currentPage === 'archive' && itemsChanged) renderArchive();
  if (currentPage === 'appearance' && appChanged) renderAppearance();
  if (currentPage === 'widgets' && widgetsChanged) renderWidgets();
  if ($('#verTag')) $('#verTag').textContent = 'v' + (next.version || '');
  if ($('#aboutVer')) $('#aboutVer').textContent = next.version || '';
  if ($('#cfgPath')) $('#cfgPath').textContent = next.configPath || '';
}

/* ------------------------------ 概览 ------------------------------ */
function renderOverview() {
  const dockOn = !(state.ui && state.ui.dockVisible === false);
  $('#statShortcuts').textContent = state.stats.shortcuts;
  $('#statGroups').textContent = state.stats.groups;
  $('#statFiles').textContent = state.stats.archiveCount;
  $('#tileDock').textContent = dockOn ? '显示中' : '已隐藏';
  $('#tileLogin').textContent = loginItem ? '已开启' : '关闭';

  $('#tileDockBtn').classList.toggle('on', dockOn);
  $('#tileLoginBtn').classList.toggle('on', !!loginItem);

  $('#heroTitle').textContent = state.stats.shortcuts ? '已经收好了' : '还是空的';
  $('#heroDesc').textContent = state.stats.shortcuts
    ? `${state.stats.shortcuts} 个图标 · ${state.stats.groups} 个分组 · ${state.stats.archiveCount} 个文件`
    : '到「快捷方式」里扫描桌面，或直接把图标拖进 Dock。';
}

/* ------------------------------ 快捷方式 ------------------------------ */
function orderButtons(idx, total) {
  return `<button class="icon-action" data-act="up" title="上移" ${idx === 0 ? 'disabled' : ''}>${SVG.up}</button>
          <button class="icon-action" data-act="center" title="移到中间">${SVG.center}</button>
          <button class="icon-action" data-act="down" title="下移" ${idx >= total - 1 ? 'disabled' : ''}>${SVG.down}</button>`;
}

function dockSwitch(on) {
  return `<label class="switch dock-sw" title="${on ? '显示在 Dock' : '未显示'}">
    <input type="checkbox" data-act="toggle" ${on ? 'checked' : ''} />
    <span class="track"></span>
  </label>`;
}

function renderShortcuts() {
  const items = state.items || [];
  const movable = items.filter((i) => i.kind !== 'archive').length;
  $('#dockCount').textContent = state.stats.shortcuts;
  const rows = [];

  items.forEach((it, idx) => {
    if (it.kind === 'app') {
      rows.push(`<div class="row" data-id="${it.id}" data-kind="app" data-path="${esc(it.path)}">
        ${iconHTML(it)}
        <div class="info"><div class="name">${esc(it.name)}</div><div class="path">${esc(it.path)}</div></div>
        ${dockSwitch(true)}
        <div class="actions">
          ${orderButtons(idx, movable)}
          <button class="icon-action" data-act="group" title="移入分组">${SVG.folder}</button>
          <button class="icon-action danger" data-act="remove" title="从 Dock 移出">${SVG.trash}</button>
        </div>
      </div>`);
    } else if (it.kind === 'group') {
      rows.push(`<div class="row" data-id="${it.id}" data-kind="group">
        ${groupMark(it)}
        <div class="info"><div class="name">${esc(it.name)}</div><div class="path">${it.count} 个图标</div></div>
        ${dockSwitch(true)}
        <div class="actions">
          ${orderButtons(idx, movable)}
          <button class="icon-action" data-act="goto">打开</button>
        </div>
      </div>`);
    } else {
      rows.push(`<div class="row" data-id="${it.id}" data-kind="archive">
        <div class="fb" style="background:linear-gradient(150deg,#6c5ce7,#22d3ee)">收</div>
        <div class="info"><div class="name">${esc(it.name)} <span class="muted">· 固定在最后</span></div><div class="path">${it.count} 个桌面文件</div></div>
        <div class="actions"><button class="icon-action" data-act="goto">查看</button></div>
      </div>`);
    }
  });

  $('#shortcutList').innerHTML = rows.length ? rows.join('') : `<div class="list-empty">Dock 上还没有图标</div>`;

  const unused = state._unused || [];
  $('#unusedList').innerHTML = unused.length
    ? unused
        .map(
          (e) => `<div class="row" data-path="${esc(e.path)}">
        ${iconHTML(e)}
        <div class="info"><div class="name">${esc(e.name)}</div><div class="path">${esc(e.path)}</div></div>
        ${dockSwitch(false)}
      </div>`
        )
        .join('')
    : `<div class="list-empty">没有藏起来的快捷方式</div>`;

  if (!$('#btnAddAll').dataset.bound) {
    $('#btnAddAll').dataset.bound = '1';
    $('#btnAddAll').onclick = async () => {
      const paths = (state._unused || []).map((e) => e.path);
      if (!paths.length) return;
      const n = await api.invoke('items:add', paths);
      toast(n ? `已显示 ${n} 个` : '没有可添加的');
    };
  }
}

async function refreshUnused() {
  const list = await api.invoke('scan:list');
  const onDock = new Set((state.items || []).filter((i) => i.kind === 'app').map((i) => i.path.toLowerCase()));
  const inGroup = new Set();
  for (const it of state.items || []) {
    if (it.kind === 'group') for (const c of it.children || []) inGroup.add(c.path.toLowerCase());
  }
  state._unused = list.filter((e) => !onDock.has(e.path.toLowerCase()) && !inGroup.has(e.path.toLowerCase()));
}

function groupMark(g) {
  if (g.iconSrc) return `<span class="gc-face"><img src="${g.iconSrc}" alt="" /></span>`;
  if (g.icon && window.DGIcons) {
    const tile = DGIcons.tile(g.icon);
    if (tile) return `<span class="gc-face">${tile}</span>`;
  }
  return `<span class="gc-face count">${g.count}</span>`;
}

function iconPicks(g) {
  const presets = (window.DGIcons && DGIcons.presets) || [];
  const cur = g.icon || '';
  const bits = [
    `<button type="button" class="pick ${!cur && !g.iconSrc ? 'on' : ''}" data-gact="icon" data-icon="" title="默认拼图"><span class="mini-grid"></span></button>`,
  ];
  for (const p of presets) {
    bits.push(`<button type="button" class="pick ${cur === p.id ? 'on' : ''}" data-gact="icon" data-icon="${p.id}" title="${esc(p.name)}">${DGIcons.tile(p.id)}</button>`);
  }
  bits.push(`<button type="button" class="pick import ${g.iconSrc ? 'on' : ''}" data-gact="import" title="导入图片">+</button>`);
  return `<div class="icon-picks">${bits.join('')}</div>`;
}

/* ------------------------------ 分组 ------------------------------ */
function renderGroups() {
  const groups = (state.items || []).filter((i) => i.kind === 'group');
  $('#groupCount').textContent = groups.length;

  // 新建分组的候选
  const apps = (state.items || []).filter((i) => i.kind === 'app');
  if (!$('#groupPicker').dataset.rendered) {
    $('#groupPicker').innerHTML = apps.length
      ? apps
          .map(
            (it) => `<div class="row" data-pick="${it.id}">
          <div class="cbx">${SVG.check}</div>
          ${iconHTML(it)}
          <div class="info"><div class="name">${esc(it.name)}</div></div>
        </div>`
          )
          .join('')
      : `<div class="list-empty">Dock 上没有可归组的图标</div>`;
    $('#groupPicker').dataset.rendered = '1';
  }

  $('#groupList').innerHTML = groups.length
    ? groups
        .map(
          (g) => `<div class="group-card ${openIconGroup === g.id ? 'icons-open' : ''}" data-gid="${g.id}">
        <div class="gc-head">
          <button type="button" class="gc-face-btn" data-gact="icons" title="更换图标">${groupMark(g)}</button>
          <div style="flex:1;min-width:0">
            <div class="gc-name">${esc(g.name)}</div>
            <div class="gc-meta">${g.count} 个图标</div>
          </div>
          <button class="btn sm" data-gact="rename">重命名</button>
          <button class="btn sm" data-gact="dissolve">解散</button>
          <button class="btn sm danger" data-gact="delete">删除</button>
        </div>
        ${iconPicks(g)}
        <div class="gc-body">
          ${g.children
            .map(
              (c) => `<span class="mini-chip" data-cid="${c.id}">
              ${c.icon ? `<img src="${c.icon}" />` : `<b>${esc(c.name.charAt(0))}</b>`}
              ${esc(c.name)}
              <span class="x" data-cextract="1" title="移出分组">×</span>
            </span>`
            )
            .join('') || '<span class="muted" style="font-size:11.5px">空分组</span>'}
        </div>
      </div>`
        )
        .join('')
    : `<div class="list-empty">还没有分组<br/>在 Dock 上把两个图标拖到一起，或在上方勾选后创建</div>`;
}

/* ------------------------------ 文件收纳 ------------------------------ */
function renderArchive() {
  const a = state.archive;
  const v = state.vault || {};
  $('#swFolders').checked = !!a.includeFolders;
  $('#swOther').checked = !!a.includeOther;
  $('#archiveCount').textContent = state.archiveItems.length;

  if ($('#vaultRoot')) $('#vaultRoot').textContent = v.root || '—';
  if ($('#vaultShortcuts')) $('#vaultShortcuts').textContent = v.shortcuts || '—';
  if ($('#vaultArchive')) $('#vaultArchive').textContent = v.archive || '—';
  if ($('#vaultHint')) {
    const nf = Number(v.desktopFiles) || 0;
    $('#vaultHint').textContent = nf
      ? `桌面上还有 ${nf} 个文件可以直接收进来`
      : '桌面已经很干净了，没有需要收纳的文件';
  }

  $('#extList').innerHTML = a.extensions
    .map((x) => `<span class="ext-chip">${esc(x)}<button data-ext="${esc(x)}">×</button></span>`)
    .join('') || '<span class="muted" style="font-size:11.5px">尚未设置扩展名</span>';

  $('#archivePreview').innerHTML = state.archiveItems.length
    ? state.archiveItems
        .slice(0, 40)
        .map(
          (it) => `<div class="row" data-path="${esc(it.path)}">
        ${iconHTML(it)}
        <div class="info"><div class="name">${esc(it.name)}${it.isDir ? '' : esc(it.ext)}${it.inVault ? ' <span class="muted">· 收纳夹</span>' : ''}</div><div class="path">${esc(it.path)}</div></div>
        <span class="tag pill muted" style="height:20px">${it.isDir ? '文件夹' : esc(it.ext)}</span>
        <div class="actions"><button class="icon-action" data-act="open">打开</button></div>
      </div>`
        )
        .join('')
    : `<div class="list-empty">桌面上暂时没有符合规则的文件</div>`;
}

/* ------------------------------ 任务栏 ------------------------------ */
function renderTaskbar() {
  const s = taskbarStatus || {};
  const pin = $('#pillPin');
  const tray = $('#pillTray');
  if (!taskbarStatus) {
    pin.textContent = '检测中…';
    tray.textContent = '检测中…';
    return;
  }
  pin.className = 'pill ' + (s.pinnedCount ? 'warn' : 'ok');
  pin.textContent = s.pinnedCount ? `当前固定了 ${s.pinnedCount} 个图标` : '中间已无固定图标';
  tray.className = 'pill ' + (s.trayTotal && s.trayPromoted >= s.trayTotal ? 'ok' : 'muted');
  tray.textContent = s.trayTotal ? `${s.trayPromoted} / ${s.trayTotal} 个托盘图标已常显` : '未检测到托盘图标';
  $('#backupInfo').textContent = '备份状态：' + (s.backupExists ? '已有备份，可随时还原' : '暂无备份（首次执行时自动创建）');
}

/* ------------------------------ 外观 ------------------------------ */
const BG_PRESETS = ['', '#ffffff', '#f2f4fa', '#141721', '#232840', '#3a3f5c', '#6c5ce7', '#22d3ee', '#ff8a5c'];

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return '';
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(', ');
}

function rgbOf(a) {
  return hexToRgb(a.bgColor) || (a.theme === 'dark' ? '30, 32, 46' : '255, 255, 255');
}

/* 与 dock 同一套滤镜：描边只扩一次，投影只模糊原图，避免叠成粗黑边 */
function previewIconFilter(a) {
  const st = a.iconStroke || {};
  const sh = a.iconShadow || {};
  const strokeOn = !!st.on;
  const shadowOn = !!sh.on;
  if (!strokeOn && !shadowOn) return 'none';
  const morph = $('#strokeMorph');
  if (!morph) return 'none';
  const w = Math.max(0.5, Math.min(4, Number(st.width) || 1.5));
  const blur = shadowOn ? Math.max(0, Number(sh.blur) || 0) : 0;
  const y = shadowOn ? (Number(sh.y) || 0) : 0;
  const al = shadowOn ? Math.max(0, Math.min(0.7, (sh.alpha == null ? 22 : Number(sh.alpha)) / 100)) : 0;
  morph.setAttribute('radius', strokeOn ? String(w) : '0');
  $('#strokeFlood').setAttribute('flood-color', st.color || '#ffffff');
  $('#strokeFlood').setAttribute('flood-opacity', strokeOn ? '1' : '0');
  $('#shadowBlur').setAttribute('stdDeviation', (blur / 2).toFixed(2));
  $('#shadowOffset').setAttribute('dy', String(y));
  $('#shadowFlood').setAttribute('flood-color', sh.color || '#141838');
  $('#shadowFlood').setAttribute('flood-opacity', al.toFixed(3));
  return 'url(#iconFx)';
}

/* 与 dock.js 的 computeLayout 保持同一套算式，用于「塞进一行」 */
function layoutInfo(a) {
  const items = state.items || [];
  const nApps = items.filter((i) => i.kind !== 'archive').length;
  const hasArchive = items.some((i) => i.kind === 'archive');
  const total = nApps + (hasArchive ? 1 : 0);
  return { nApps, hasArchive, total, gap: a.gap, maxW: Math.max(380, Math.round(screen.availWidth * 0.94) - 48) };
}
const CHROME_W = 28;
const MIN_GAP = 2;

function singleRowWidth(iconSize, gap) {
  const a = state.appearance;
  const { nApps, hasArchive } = layoutInfo(a);
  const g = gap == null ? a.gap : gap;
  const itemW = iconSize + 12;
  const contentW = nApps ? nApps * itemW + (nApps - 1) * g : 190;
  return contentW + CHROME_W + (hasArchive ? 8 + 20 + itemW : 0);
}

/* 求「能排成一行」的最大图标尺寸，必要时同步压缩间距 */
function fitOneRow() {
  const a = state.appearance;
  const { nApps, hasArchive, maxW } = layoutInfo(a);
  if (!nApps) return { icon: a.iconSize, gap: a.gap };
  const n = nApps + (hasArchive ? 1 : 0);
  const base = CHROME_W + (hasArchive ? 8 + 20 : 0);
  const gaps = Math.max(1, nApps - 1);
  for (let icon = 96; icon >= 16; icon--) {
    const need = n * (icon + 12) + base;
    if (need + MIN_GAP * gaps <= maxW - 8) {
      const gap = Math.min(a.gap, Math.floor((maxW - 8 - need) / gaps));
      return { icon, gap: Math.max(MIN_GAP, gap) };
    }
  }
  return { icon: 16, gap: MIN_GAP };
}

function rowsAtCurrentSize() {
  const a = state.appearance;
  const { total, gap, maxW } = layoutInfo(a);
  if (!total) return 1;
  if (singleRowWidth(a.iconSize) <= maxW) return 1;
  const itemW = a.iconSize + 12;
  const capacity = Math.max(1, Math.floor((maxW - CHROME_W + gap) / (itemW + gap)));
  return Math.ceil(total / capacity);
}

function updateFitHint() {
  const el = $('#fitHint');
  if (!el) return;
  const a = state.appearance;
  const { total } = layoutInfo(a);
  if (!total) { el.textContent = '桌面上还没有图标'; return; }
  const rows = rowsAtCurrentSize();
  if (rows <= 1) {
    el.textContent = `${total} 个图标已排在一行`;
  } else {
    const f = fitOneRow();
    el.textContent = `${total} 个图标占 ${rows} 行 · 缩到 ${f.icon}px / 间距 ${f.gap} 可排成一行`;
  }
}

function renderSwatches(current) {
  const box = $('#swBg');
  if (!box) return;
  const cur = (current || '').toLowerCase();
  box.innerHTML = BG_PRESETS.map((c) => {
    const active = (c || '').toLowerCase() === cur ? ' active' : '';
    const style = c ? `background:${c}` : '';
    return `<button class="swatch${c ? '' : ' auto'}${active}" data-color="${c}" style="${style}" title="${c || '跟随深浅主题'}"></button>`;
  }).join('');
}

function renderAppearance() {
  const a = state.appearance;
  const set = (id, valId, v, fmt) => {
    const r = $('#' + id);
    if (r && document.activeElement !== r) r.value = v;
    const vEl = $('#' + valId);
    if (vEl) vEl.textContent = fmt ? fmt(v) : v;
  };
  set('rngIcon', 'valIcon', a.iconSize);
  set('rngGap', 'valGap', a.gap);
  set('rngOffset', 'valOffset', a.bottomOffset);
  set('rngOpacity', 'valOpacity', a.opacity, (v) => v + '%');
  set('rngBlur', 'valBlur', a.blur);
  set('rngRadius', 'valRadius', a.radius);
  $('#swLabels').checked = !!a.showLabels;
  $('#swGlass').checked = a.glassOn !== false;

  const hb = a.hoverBg || {};
  $('#swHoverBg').checked = hb.on !== false;
  $('#inHoverColor').value = hb.color || '#ffffff';

  const mg = a.magnify || {};
  set('rngMagScale', 'valMagScale', Math.round((mg.scale || 1.4) * 100), (v) => (v / 100).toFixed(2));
  set('rngMagCount', 'valMagCount', mg.count || 5);
  set('rngMagSpeed', 'valMagSpeed', mg.speed == null ? 220 : mg.speed, (v) => v + 'ms');

  renderSwatches(a.bgColor);
  $('#inBgColor').value = a.bgColor || (a.theme === 'dark' ? '#1e202e' : '#ffffff');

  const st = a.iconStroke || {};
  $('#swStroke').checked = !!st.on;
  set('rngStrokeW', 'valStrokeW', st.width == null ? 1.5 : st.width, (v) => Number(v).toFixed(1));
  $('#inStrokeColor').value = st.color || '#ffffff';

  const sh = a.iconShadow || {};
  $('#swShadow').checked = !!sh.on;
  set('rngShadowBlur', 'valShadowBlur', sh.blur == null ? 7 : sh.blur);
  set('rngShadowY', 'valShadowY', sh.y == null ? 3 : sh.y);
  set('rngShadowAlpha', 'valShadowAlpha', sh.alpha == null ? 22 : sh.alpha, (v) => v + '%');
  $('#inShadowColor').value = sh.color || '#141838';

  const bsh = a.barShadow || {};
  $('#swBarShadow').checked = !!bsh.on;
  set('rngBarBlur', 'valBarBlur', bsh.blur == null ? 24 : bsh.blur);
  set('rngBarY', 'valBarY', bsh.y == null ? 14 : bsh.y);
  set('rngBarAlpha', 'valBarAlpha', bsh.alpha == null ? 22 : bsh.alpha, (v) => v + '%');
  $('#inBarShadowColor').value = bsh.color || (a.theme === 'dark' ? '#000000' : '#1c204a');

  $$('#segTheme button').forEach((b) => b.classList.toggle('active', b.dataset.theme === (a.theme || 'light')));
  updateFitHint();
  updatePreview();
}

/* 关掉的一组选项变淡，避免去拧一个当前看不出效果的滑条 */
function syncAppearanceLocks() {
  const a = (state && state.appearance) || {};
  const glass = a.glassOn !== false;
  const glassCard = $('#blockGlass');
  if (glassCard) glassCard.classList.toggle('glass-off', !glass);
  const bar = $('#blockBarShadow');
  if (bar) {
    bar.classList.toggle('is-off', !(a.barShadow && a.barShadow.on));
    bar.classList.toggle('glass-off', !glass);
  }
  const hint = $('#barShadowHint');
  if (hint) hint.hidden = glass;
  const iconSh = $('#blockIconShadow');
  if (iconSh) iconSh.classList.toggle('is-off', !(a.iconShadow && a.iconShadow.on));
  const stroke = $('#blockStroke');
  if (stroke) stroke.classList.toggle('is-off', !(a.iconStroke && a.iconStroke.on));
  const hover = $('#blockHover');
  if (hover) hover.classList.toggle('is-off', !!(a.hoverBg && a.hoverBg.on === false));
}

function updatePreview() {
  const a = state.appearance;
  const dock = $('#pDock');
  const rgb = rgbOf(a);
  const top = Math.min(1, (a.opacity / 100) * 1.2);
  const bottom = Math.min(1, (a.opacity / 100) * 0.9);
  const glass = a.glassOn !== false;
  dock.style.padding = `${Math.round(a.iconSize * 0.14)}px ${Math.round(a.iconSize * 0.2)}px`;
  dock.style.gap = Math.max(3, a.gap * 0.6) + 'px';
  dock.style.borderRadius = Math.min(22, a.radius * 0.62) + 'px';
  dock.style.background = glass ? `linear-gradient(168deg, rgba(${rgb},${top}), rgba(${rgb},${bottom}))` : 'transparent';
  dock.style.borderColor = glass ? '' : 'transparent';
  dock.style.backdropFilter = glass ? `blur(${Math.min(16, a.blur)}px)` : 'none';
  const inset = a.theme === 'dark' ? 'inset 0 1px 0 rgba(255,255,255,0.10)' : 'inset 0 1px 0 rgba(255,255,255,0.7)';
  dock.style.boxShadow = glass ? inset : 'none';

  const shade = $('#pShade');
  const bsh = a.barShadow || {};
  if (shade) {
    const on = glass && !!bsh.on;
    shade.style.display = on ? 'block' : 'none';
    const al = Math.max(0, Math.min(0.8, (bsh.alpha == null ? 22 : Number(bsh.alpha)) / 100));
    const srgb = hexToRgb(bsh.color) || (a.theme === 'dark' ? '0, 0, 0' : '28, 32, 74');
    const blur = Math.max(0, Number(bsh.blur) || 0);
    const y = Number(bsh.y) || 0;
    shade.style.height = Math.max(16, Math.min(32, Math.round(12 + blur * 0.28 + Math.max(0, y) * 0.18))) + 'px';
    shade.style.background = `linear-gradient(to bottom, rgba(${srgb},${al.toFixed(3)}) 0%, rgba(${srgb},${(al * 0.32).toFixed(3)}) 46%, transparent 100%)`;
  }

  const filter = previewIconFilter(a);
  $$('#pDock .p-item').forEach((n) => {
    const s = Math.max(12, a.iconSize * 0.42);
    n.style.width = s + 'px';
    n.style.height = s + 'px';
    n.style.borderRadius = Math.round(s * 0.26) + 'px';
    n.style.filter = filter;
  });
  syncAppearanceLocks();
}

/* ------------------------------ 小组件 ------------------------------ */
const num = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const WF = window.DGFmt;
const WDEFS = WF.ELEMENT_DEFS;
const WTYPES = WF.ELEMENT_TYPES;

let wFonts = { system: [], custom: [] };
const wOpen = new Set();          // 展开了哪些元素
const wPending = new Map();       // id -> { 路径: 值 }，等着合并发送
let wFlushTimer = null;

const WCHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

function wElements() {
  const w = state && state.widgets;
  return w && Array.isArray(w.elements) ? w.elements : [];
}

function wEl(id) {
  return wElements().find((e) => e && e.id === id) || null;
}

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, val) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

const wColorVal = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : '#ffffff');

/* ---------------- 控件 ---------------- */
function wRow(label, ctl, hint) {
  return `<div class="slider-row"><div class="lbl">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="ctl">${ctl}</div></div>`;
}
function wSw(path, on) {
  return `<label class="switch"><input type="checkbox" data-p="${path}"${on ? ' checked' : ''}><span class="track"></span></label>`;
}
function wRng(path, val, min, max, step, suffix) {
  return `<input type="range" data-p="${path}" data-suffix="${suffix || ''}" min="${min}" max="${max}" step="${step}" value="${val}"><span class="val">${val}${suffix || ''}</span>`;
}
function wNum(path, val, min, max) {
  return `<input class="win" type="number" data-p="${path}" min="${min}" max="${max}" step="1" value="${val}">`;
}
function wTxt(path, val, ph) {
  return `<div class="field"><input data-p="${path}" value="${esc(val)}" placeholder="${esc(ph || '')}" spellcheck="false" /></div>`;
}
function wColor(path, val) {
  return `<label class="color-dot"><input type="color" data-p="${path}" value="${wColorVal(val)}" /></label>`;
}
function wSelect(path, val, options, numeric) {
  const opts = options.map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(val) ? ' selected' : ''}>${esc(o.t)}</option>`).join('');
  return `<select class="wsel" data-p="${path}"${numeric ? ' data-num="1"' : ''}>${opts}</select>`;
}
function wChips(path, presets, cur) {
  return `<div class="wchips">${presets.map((p) => `<button class="wchip${p === cur ? ' on' : ''}" data-p="${path}" data-fmt="${esc(p)}">${esc(p)}</button>`).join('')}</div>`;
}
function wSeg(path, options, cur, bool) {
  return `<div class="wseg" data-seg="${path}"${bool ? ' data-bool="1"' : ''}>${options.map((o) => `<button data-val="${esc(o.v)}"${String(o.v) === String(cur) ? ' class="active"' : ''}>${esc(o.t)}</button>`).join('')}</div>`;
}

/* ---------------- 各类型的参数 ---------------- */
function wTypeBlock(el) {
  const d = el.data || {};
  if (el.type === 'clock') {
    return `<div class="wgroup"><div class="wgroup-t">时间</div>
      ${wRow('格式', wTxt('data.pattern', d.pattern, 'HH:mm'), 'YYYY 年 · MM 月 · DD 日 · HH:mm 时:分 · ddd 周几')}
      ${wChips('data.pattern', WF.TIME_PRESETS, d.pattern)}
      ${wRow('时区', wSelect('data.tz', d.tz, WF.TZ_LIST.map((t) => ({ v: t.id, t: t.label }))))}
      ${wRow('12 小时制', wSw('data.h12', d.h12), '格式里没写 AM/PM 会自动补上')}
    </div>`;
  }
  if (el.type === 'date') {
    return `<div class="wgroup"><div class="wgroup-t">日期</div>
      ${wRow('格式', wTxt('data.pattern', d.pattern, 'YYYY年M月D日 ddd'), '支持 [方括号] 里写死文字')}
      ${wChips('data.pattern', WF.DATE_PRESETS, d.pattern)}
      ${wRow('农历', wSw('data.lunar', d.lunar), '在日期下面多一行农历')}
      ${wRow('农历字号', wRng('data.lunarSize', d.lunarSize, 6, 40, 1, 'px'))}
      ${wRow('节日', wSw('data.holiday', d.holiday), '春节、中秋、清明、母亲节等')}
      ${wRow('节日字号', wRng('data.holidaySize', d.holidaySize, 6, 40, 1, 'px'))}
    </div>`;
  }
  if (el.type === 'battery') {
    const tc = el.text.color || '#ffffff';
    return `<div class="wgroup"><div class="wgroup-t">电量</div>
      ${wRow('文案', wTxt('data.pattern', d.pattern, '{p}%'), '{p} 百分比 · {s} 状态 · {t} 剩余时间')}
      ${wChips('data.pattern', WF.BATTERY_PRESETS, d.pattern)}
      ${wRow('电池图标', wSw('data.icon', d.icon))}
      ${wRow('电量条', wSw('data.bar', d.bar))}
      ${wRow('百分比', wSw('data.text', d.text))}
      ${wRow('百分比位置', wSeg('data.inline', [{ v: '1', t: '叠在电池里' }, { v: '0', t: '排在旁边' }], d.inline ? '1' : '0', true), '叠在电池里时，外框会跟着数字自动变宽')}
      ${wRow('电池高度', wRng('data.iconSize', d.iconSize, 10, 80, 1, 'px'), '叠放时决定电池外框的高度')}
      ${wRow('电量条尺寸', `${wNum('data.barW', d.barW, 10, 400)}<span class="wunit">×</span>${wNum('data.barH', d.barH, 2, 24)}`, '宽 × 高')}
      ${wRow('低于阈值变色', wRng('data.low', d.low, 5, 60, 5, '%'))}
    </div>
    <div class="wgroup"><div class="wgroup-t">颜色</div>
      ${wRow('电池图标', `${wColor('data.iconColor', d.iconColor || tc)}<button class="wlink" data-clear="data.iconColor">跟随文字</button>`)}
      ${wRow('电量条', `${wColor('data.barColor', d.barColor || tc)}<button class="wlink" data-clear="data.barColor">跟随文字</button>`)}
      ${wRow('百分比', `${wColor('data.textColor', d.textColor || tc)}<button class="wlink" data-clear="data.textColor">跟随文字</button>`)}
      ${wRow('低电颜色', wColor('data.lowColor', d.lowColor))}
    </div>`;
  }
  if (el.type === 'text') {
    return `<div class="wgroup"><div class="wgroup-t">文本</div>
      <textarea class="wtext" data-p="data.content" rows="3" spellcheck="false">${esc(d.content || '')}</textarea>
    </div>`;
  }
  return `<div class="wgroup"><div class="wgroup-t">图片</div>
    ${wRow('文件', `<button class="btn sm" data-act="pick-image">选择图片</button>`, d.src ? '已选择，可再换一张' : '支持 png / jpg / webp / gif / svg')}
    ${wRow('填充方式', wSeg('data.fit', [{ v: 'contain', t: '完整显示' }, { v: 'cover', t: '铺满裁剪' }, { v: 'fill', t: '拉伸' }], d.fit))}
  </div>`;
}

function wFontRow(t) {
  const cur = t.font || '';
  return `<div class="wfontrow">
    <div class="field"><input data-p="text.font" list="wFontList" value="${esc(cur)}" placeholder="系统默认字体" spellcheck="false" /></div>
    <button class="wlink" data-act="import-font">导入字体</button>
  </div>`;
}

function wBodyHtml(el) {
  const t = el.text || {};
  const bg = el.bg || {};
  const sh = el.shadow || {};
  const isImage = el.type === 'image';
  return `
    <div class="wgroup"><div class="wgroup-t">位置与大小</div>
      ${wRow('名称', wTxt('name', el.name, '给这个元素起个名字'))}
      ${wRow('位置', `${wNum('x', el.x, 0, 12000)}<span class="wunit">,</span>${wNum('y', el.y, 0, 12000)}`, '相对屏幕左上角的像素位置')}
      ${wRow('大小', `${wNum('w', el.w, 0, 4000)}<span class="wunit">×</span>${wNum('h', el.h, 0, 4000)}`, '填 0 表示跟着内容自动')}
      ${wRow('旋转', wRng('rotate', el.rotate, -180, 180, 1, '°'))}
      ${wRow('不透明度', wRng('opacity', el.opacity, 5, 100, 1, '%'))}
      ${wRow('显示', wSw('visible', el.visible), '关掉后桌面上不出现')}
    </div>
    ${wTypeBlock(el)}
    ${isImage ? '' : `<div class="wgroup"><div class="wgroup-t">文字</div>
      ${wRow('字体', wFontRow(t))}
      ${wRow('字号', wRng('text.size', t.size, 6, 160, 1, 'px'))}
      ${wRow('字重', wSelect('text.weight', t.weight, [
        { v: 300, t: '细' }, { v: 400, t: '常规' }, { v: 500, t: '中等' },
        { v: 600, t: '半粗' }, { v: 700, t: '粗' }, { v: 800, t: '特粗' },
      ], true))}
      ${wRow('斜体', wSw('text.italic', t.italic))}
      ${wRow('下划线', wSw('text.underline', t.underline))}
      ${wRow('字间距', wRng('text.letter', t.letter, -4, 20, 0.5, 'px'))}
      ${wRow('行间距', wRng('text.line', t.line, 0.9, 2.4, 0.05, '倍'))}
      ${wRow('颜色', wColor('text.color', t.color))}
      ${wRow('对齐', wSeg('align', [{ v: 'left', t: '左' }, { v: 'center', t: '中' }, { v: 'right', t: '右' }], el.align))}
    </div>
    <div class="wgroup"><div class="wgroup-t">文字阴影</div>
      ${wRow('开启', wSw('text.shadow.on', t.shadow && t.shadow.on))}
      ${wRow('模糊', wRng('text.shadow.blur', (t.shadow && t.shadow.blur) || 0, 0, 40, 1, 'px'))}
      ${wRow('下移', wRng('text.shadow.y', (t.shadow && t.shadow.y) || 0, -20, 20, 1, 'px'))}
      ${wRow('颜色', wColor('text.shadow.color', t.shadow && t.shadow.color))}
    </div>`}
    <div class="wgroup"><div class="wgroup-t">背景与边框</div>
      ${wRow('背景', wSw('bg.on', bg.on), '打开后是个圆角色块')}
      ${wRow('背景色', wColor('bg.color', bg.color))}
      ${wRow('背景不透明度', wRng('bg.alpha', bg.alpha, 0, 100, 1, '%'))}
      ${wRow('圆角', wRng('radius', el.radius, 0, 80, 1, 'px'))}
      ${wRow('内边距', wRng('pad', el.pad, 0, 40, 1, 'px'))}
      ${wRow('块阴影', wSw('shadow.on', sh.on))}
      ${wRow('阴影模糊', wRng('shadow.blur', sh.blur, 0, 60, 1, 'px'))}
      ${wRow('阴影下移', wRng('shadow.y', sh.y, -20, 30, 1, 'px'))}
      ${wRow('阴影颜色', wColor('shadow.color', sh.color))}
    </div>
    <div class="wacts">
      <button class="btn sm" data-act="up">上移</button>
      <button class="btn sm" data-act="down">下移</button>
      <button class="btn sm" data-act="dup">复制</button>
      <button class="btn sm danger" data-act="del">删除</button>
    </div>`;
}

function wItemHtml(raw, open) {
  const el = WF.normalizeElement(raw);
  const def = WDEFS[el.type] || WDEFS.text;
  return `<div class="witem${open ? ' open' : ''}" data-id="${esc(el.id)}">
    <div class="wrow">
      <button class="whead" data-act="toggle" type="button">
        <span class="wbadge">${esc(def.short)}</span>
        <span class="wname"><b>${esc(el.name)}</b><small>${esc(WF.summary(el))}</small></span>
      </button>
      <label class="wsw" title="关掉后桌面上不显示这个元素">
        <input type="checkbox" data-act="vis"${el.visible === false ? '' : ' checked'}>
        <span class="track"></span>
      </label>
      <button class="wchev" data-act="toggle" type="button" aria-label="展开参数">${WCHEV}</button>
    </div>
    <div class="wbody"${open ? '' : ' hidden'}>${open ? wBodyHtml(el) : ''}</div>
  </div>`;
}

// 常见的几款先排在前面，省得在一长串里翻
const W_FONT_PICK = [
  '微软雅黑', 'Microsoft YaHei', '等线', 'DengXian', '黑体', 'SimHei', '宋体', 'SimSun',
  '楷体', 'KaiTi', '仿宋', 'FangSong', 'Segoe UI', 'Consolas', 'Cascadia Code', 'Cascadia Mono',
];

function renderFontList() {
  const dl = $('#wFontList');
  if (!dl) return;
  const custom = wFonts.custom || [];
  const system = wFonts.system || [];
  const has = new Set(system);
  const rec = W_FONT_PICK.filter((n) => has.has(n));
  const rest = system.filter((n) => !rec.includes(n));
  const opts = ['<option value="">系统默认</option>'];
  for (const f of custom) opts.push(`<option value="${esc(f.family)}">${esc(f.name)}（已导入）</option>`);
  for (const n of rec) opts.push(`<option value="${esc(n)}">${esc(n)}（推荐）</option>`);
  for (const n of rest) opts.push(`<option value="${esc(n)}">${esc(n)}</option>`);
  dl.innerHTML = opts.join('');
}

function refreshWSummaries() {
  for (const item of $$('.witem')) {
    const el = wEl(item.dataset.id);
    if (!el) continue;
    const n = WF.normalizeElement(el);
    const b = $('b', item);
    const small = $('small', item);
    const sw = $('.wsw input', item);
    if (b) b.textContent = n.name;
    if (small) small.textContent = WF.summary(n);
    if (sw) sw.checked = n.visible !== false;
  }
}

function renderWidgets() {
  if (!state || !state.widgets) return;
  const list = $('#wElList');
  if (!list) return;
  const els = wElements();
  const sw = $('#swWidgets');
  if (sw) sw.checked = state.widgets.enabled !== false;
  const count = $('#wCount');
  if (count) count.textContent = els.length ? `${els.length} 个元素` : '';
  const empty = $('#wEmpty');
  if (empty) empty.hidden = els.length > 0;
  list.innerHTML = els.map((e) => wItemHtml(e, wOpen.has(e.id))).join('');
  renderFontList();
  const info = $('#wFontInfo');
  if (info) info.textContent = (wFonts.custom || []).length ? `已导入 ${wFonts.custom.length} 个字体` : '';
}

/* ---------------- 写入 ---------------- */
function queuePatch(id, path, value) {
  if (!wPending.has(id)) wPending.set(id, {});
  wPending.get(id)[path] = value;
  clearTimeout(wFlushTimer);
  wFlushTimer = setTimeout(flushPatches, 140);
}

function flushPatches() {
  const batch = new Map(wPending);
  wPending.clear();
  for (const [id, patch] of batch) {
    api.invoke('widget:element:patch', { id, patch }).catch(() => {});
  }
}

function onWidgetInput(e) {
  const t = e.target;
  // 行尾的「启用」开关：直接切 visible，不走 data-p 那套
  if (t.matches('input[data-act="vis"]')) {
    const box = t.closest('.witem');
    const id = box && box.dataset.id;
    const el = id ? wEl(id) : null;
    if (!el) return;
    setPath(el, 'visible', t.checked);
    queuePatch(id, 'visible', t.checked);
    return;
  }
  const path = t.dataset.p;
  if (!path) return;
  const item = t.closest('.witem');
  if (!item) return;
  const id = item.dataset.id;
  const el = wEl(id);
  if (!el) return;

  let value;
  if (t.type === 'checkbox') value = t.checked;
  else if (t.dataset.num || t.type === 'number' || t.type === 'range') {
    if (String(t.value).trim() === '') return;
    value = Number(t.value);
    if (!Number.isFinite(value)) return;
  } else value = t.value;

  setPath(el, path, value);
  if (t.type === 'range') {
    const box = t.parentElement && t.parentElement.querySelector('.val');
    if (box) box.textContent = t.value + (t.dataset.suffix || '');
  }
  queuePatch(id, path, value);
  if (path === 'name' || path === 'visible') refreshWSummaries();

  // 颜色「跟随文字」后，色块本身也要同步，不然显示的是旧颜色
  if (path === 'text.color') {
    for (const b of $$('.wlink[data-clear]', item)) {
      const p = b.dataset.clear;
      if (!getPath(el, p)) {
        const box = b.parentElement.querySelector(`input[type="color"][data-p="${p}"]`);
        if (box) box.value = wColorVal(t.value);
      }
    }
  }
}

function onWidgetClick(e) {
  const item = e.target.closest('.witem');
  const id = item ? item.dataset.id : '';
  const el = id ? wEl(id) : null;

  const chip = e.target.closest('.wchip');
  if (chip && el) {
    const path = chip.dataset.p;
    const value = chip.dataset.fmt;
    setPath(el, path, value);
    for (const c of chip.parentElement.querySelectorAll('.wchip')) c.classList.toggle('on', c === chip);
    const input = item.querySelector(`input[data-p="${path}"]`);
    if (input) input.value = value;
    queuePatch(id, path, value);
    refreshWSummaries();
    return;
  }

  const seg = e.target.closest('.wseg button');
  if (seg && el) {
    const box = seg.closest('.wseg');
    const path = box.dataset.seg;
    const value = box.dataset.bool ? seg.dataset.val === '1' : seg.dataset.val;
    setPath(el, path, value);
    for (const b of box.querySelectorAll('button')) b.classList.toggle('active', b === seg);
    queuePatch(id, path, value);
    return;
  }

  const clearBtn = e.target.closest('[data-clear]');
  if (clearBtn && el) {
    const path = clearBtn.dataset.clear;
    setPath(el, path, '');
    const box = clearBtn.parentElement.querySelector(`input[type="color"][data-p="${path}"]`);
    if (box) box.value = wColorVal(el.text.color);
    queuePatch(id, path, '');
    return;
  }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  const kind = act.dataset.act;

  if (kind === 'vis') return;  // 启用开关走 change，别顺手把行展开

  if (kind === 'toggle') {
    if (wOpen.has(id)) wOpen.delete(id);
    else wOpen.add(id);
    renderWidgets();
    return;
  }
  if (kind === 'up' || kind === 'down') {
    api.invoke('widget:element:order', { id, dir: kind }).catch(() => {});
    return;
  }
  if (kind === 'dup') {
    api.invoke('widget:element:duplicate', { id }).then((el2) => {
      if (el2 && el2.id) { wOpen.add(el2.id); renderWidgets(); }
    }).catch(() => {});
    return;
  }
  if (kind === 'del') {
    api.invoke('widget:element:remove', { id }).then(() => {
      wOpen.delete(id);
      toast('元素已删除');
    }).catch(() => {});
    return;
  }
  if (kind === 'pick-image') {
    act.disabled = true;
    api.invoke('widget:element:image', { id }).then((r) => {
      act.disabled = false;
      if (r && r.ok) toast('图片已更新');
      else if (r && r.error) toast(r.error, 'err');
    }).catch(() => { act.disabled = false; });
    return;
  }
  if (kind === 'import-font') {
    act.disabled = true;
    api.invoke('font:import').then((r) => {
      act.disabled = false;
      if (!r) return;
      if (r.list) wFonts.custom = r.list;
      renderFontList();
      if (r.ok && r.added && r.added.length) {
        toast(`已导入 ${r.added.length} 个字体`);
        const f = r.added[0];
        if (el && f) {
          setPath(el, 'text.font', f.family);
          const input = item.querySelector('input[data-p="text.font"]');
          if (input) input.value = f.family;
          queuePatch(id, 'text.font', f.family);
        }
      }
      const info = $('#wFontInfo');
      if (info) info.textContent = (wFonts.custom || []).length ? `已导入 ${wFonts.custom.length} 个字体` : '';
    }).catch(() => { act.disabled = false; });
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindEvents() {
  // 窗口控制
  $('#btnMin').onclick = () => api.invoke('win:minimize');
  $('#btnMax').onclick = () => api.invoke('win:maximize');
  $('#btnClose').onclick = () => api.invoke('win:close');

  // 概览
  $('#btnGotoShortcuts').onclick = () => go('shortcuts');

  $('#tileDockBtn').onclick = async () => {
    const hidden = state.ui && state.ui.dockVisible === false;
    await api.invoke('dock:show', hidden);
    renderOverview();
    toast(hidden ? 'Dock 已显示' : 'Dock 已隐藏');
  };
  $('#tileLoginBtn').onclick = async () => {
    loginItem = await api.invoke('app:loginItem', !loginItem);
    toast(loginItem ? '已设置开机自启' : '已关闭开机自启');
    renderOverview();
  };

  // 快捷方式列表（事件委托）
  $('#shortcutList').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-act="toggle"]');
    if (!input) return;
    const row = input.closest('.row');
    if (!row) return;
    if (input.checked) return;
    const ok = await api.invoke('items:confirmRemove', row.dataset.id);
    if (!ok) input.checked = true;
  });

  $('#shortcutList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="toggle"]') || e.target.closest('.dock-sw')) return;
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (!btn) {
      if (row.dataset.kind === 'group') {
        await api.invoke('popup:open', { kind: 'group', id, anchor: { cx: window.screenX + window.innerWidth / 2, cy: window.screenY + window.innerHeight - 80 } });
      }
      return;
    }
    const act = btn.dataset.act;
    const idx = state.items.findIndex((i) => i.id === id);
    if (act === 'up' && idx > 0) {
      await api.invoke('items:move', { id, targetId: state.items[idx - 1].id, after: false });
    }
    if (act === 'center') await api.invoke('items:center', id);
    if (act === 'down' && idx < state.items.length - 1) {
      await api.invoke('items:move', { id, targetId: state.items[idx + 1].id, after: true });
    }
    if (act === 'remove') {
      const ok = await api.invoke('items:confirmRemove', id);
      if (!ok) return;
    }
    if (act === 'group') await api.invoke('items:pickGroup', id);
    if (act === 'goto') {
      if (row.dataset.kind === 'group') {
        await api.invoke('popup:open', { kind: 'group', id, anchor: { cx: window.screenX + window.innerWidth / 2, cy: window.screenY + window.innerHeight - 80 } });
      } else {
        await api.invoke('popup:open', { kind: 'archive', id, anchor: { cx: window.screenX + window.innerWidth / 2, cy: window.screenY + window.innerHeight - 80 } });
      }
    }
  });

  $('#unusedList').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-act="toggle"]');
    const row = input && input.closest('.row');
    if (!row) return;
    const p = row.dataset.path;
    if (input.checked) {
      const n = await api.invoke('items:add', [p]);
      if (!n) input.checked = false;
      else toast('已显示在 Dock');
    } else {
      input.checked = false;
    }
  });

  // 分组
  $('#groupPicker').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.pick;
    if (selectedForGroup.has(id)) { selectedForGroup.delete(id); row.classList.remove('sel'); }
    else { selectedForGroup.add(id); row.classList.add('sel'); }
  });

  $('#btnNewGroup').onclick = async () => {
    const name = $('#newGroupName').value.trim();
    if (!selectedForGroup.size) return toast('请先勾选要归组的图标', 'err');
    const id = await api.invoke('group:create', { name: name || '新建分组', itemIds: Array.from(selectedForGroup) });
    selectedForGroup.clear();
    $('#newGroupName').value = '';
    $('#groupPicker').dataset.rendered = '';
    toast('分组已创建');
  };

  $('#groupList').addEventListener('click', async (e) => {
    const card = e.target.closest('.group-card');
    if (!card) return;
    const gid = card.dataset.gid;
    const gbtn = e.target.closest('[data-gact]');
    if (gbtn) {
      const act = gbtn.dataset.gact;
      if (act === 'dissolve') {
        await api.invoke('group:delete', { id: gid, keepChildren: true });
        toast('分组已解散，图标已回到 Dock');
      }
      if (act === 'delete') {
        await api.invoke('group:delete', { id: gid, keepChildren: false });
        toast('分组已删除');
      }
      if (act === 'icons') {
        openIconGroup = card.classList.contains('icons-open') ? '' : gid;
        card.classList.toggle('icons-open');
        return;
      }
      if (act === 'icon') {
        await api.invoke('group:setIcon', { id: gid, icon: gbtn.dataset.icon || '' });
        return;
      }
      if (act === 'import') {
        const r = await api.invoke('group:importIcon', gid);
        if (r && r.error) toast(r.error, 'err');
        else if (r && r.ok) toast('图标已更换');
        return;
      }
      if (act === 'rename') {
        const nameEl = card.querySelector('.gc-name');
        const g = state.items.find((i) => i.id === gid);
        nameEl.innerHTML = `<input class="field" style="height:26px;width:180px" value="${esc(g.name)}" />`;
        const input = nameEl.querySelector('input');
        input.focus(); input.select();
        const commit = async () => {
          const v = input.value.trim();
          if (v) await api.invoke('group:rename', { id: gid, name: v });
          else renderGroups();
        };
        input.onblur = commit;
        input.onkeydown = (ev) => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') renderGroups(); };
      }
      return;
    }
    const x = e.target.closest('[data-cextract]');
    if (x) {
      const cid = x.parentElement.dataset.cid;
      await api.invoke('group:removeChild', { groupId: gid, childId: cid, toDock: true });
      toast('已移出分组');
    }
  });

  // 文件收纳
  $('#swFolders').onchange = (e) => api.invoke('settings:patch', { archive: { includeFolders: e.target.checked } });
  $('#swOther').onchange = (e) => api.invoke('settings:patch', { archive: { includeOther: e.target.checked } });

  // DeskGlow 软件文件夹
  $('#btnOpenVault').onclick = () => api.invoke('vault:open', 'root');
  $('#btnImportFiles').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '收纳中…';
    const r = await api.invoke('vault:importFiles');
    btn.disabled = false;
    btn.textContent = old;
    const n = (r && r.moved) || 0;
    if (n) toast(`已把 ${n} 个文件移进 DeskGlow\\文件收纳`);
    else toast('桌面上没有需要收纳的文件');
  };
  $('#btnPickArchive').onclick = async () => {
    const paths = await api.invoke('dialog:pickArchiveFiles');
    if (!paths.length) return;
    const r = await api.invoke('archive:addFiles', paths);
    toast(r && r.moved ? `已收纳 ${r.moved} 个文件` : '没有可移动的文件');
  };
  $('#extList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ext]');
    if (!b) return;
    const ext = b.dataset.ext;
    const list = state.archive.extensions.filter((x) => x !== ext);
    api.invoke('settings:patch', { archive: { extensions: list } });
  });
  $('#btnAddExt').onclick = () => {
    let v = $('#extInput').value.trim().toLowerCase();
    if (!v) return;
    if (!v.startsWith('.')) v = '.' + v;
    if (state.archive.extensions.includes(v)) return toast('该扩展名已存在', 'err');
    api.invoke('settings:patch', { archive: { extensions: [...state.archive.extensions, v] } });
    $('#extInput').value = '';
  };
  $('#extInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAddExt').click(); });

  $('#archivePreview').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) api.invoke('item:launch', row.dataset.path);
  });

  // 任务栏
  const runTb = async (action, okText, btn) => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '执行中…';
    const r = await api.invoke('taskbar:action', action);
    btn.disabled = false;
    btn.textContent = old;
    if (r.ok) toast(okText);
    else toast('操作失败：' + (r.error || '未知错误'), 'err');
    taskbarStatus = await api.invoke('taskbar:status');
    renderTaskbar();
  };

  $('#btnPinOn').onclick = (e) => {
    if (!confirm('将清空任务栏中间所有固定的程序图标（不影响正在运行的程序）。\nDeskGlow 会先自动备份，可随时还原。\n\n继续吗？')) return;
    runTb('apply-pin', '固定图标已清空，资源管理器正在重启', e.target);
  };
  $('#btnPinRestore').onclick = (e) => {
    if (!confirm('将从备份还原任务栏固定项，并重启资源管理器。继续吗？')) return;
    runTb('restore-pin', '固定项已还原', e.target);
  };
  $('#btnTrayOn').onclick = (e) => {
    if (!confirm('将把右侧所有托盘图标设为「始终显示」（不再折叠进 ^ 菜单）。\n需要重启资源管理器才能生效。\n\n继续吗？')) return;
    runTb('apply-tray', '托盘图标已设为全部常显', e.target);
  };
  $('#btnTrayRestore').onclick = (e) => {
    if (!confirm('将还原托盘显示设置并重启资源管理器。继续吗？')) return;
    runTb('restore-tray', '托盘设置已还原', e.target);
  };
  $('#btnExplorer').onclick = (e) => runTb('restart-explorer', '资源管理器已重启', e.target);

  // 外观分区跳转
  const jumps = $('#appearanceJumps');
  if (jumps) {
    jumps.addEventListener('click', (e) => {
      const b = e.target.closest('[data-jump]');
      if (!b) return;
      const el = document.getElementById(b.dataset.jump);
      if (!el) return;
      $$('#appearanceJumps button').forEach((x) => x.classList.toggle('on', x === b));
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // 外观
  let patchTimer = null;
  const patchAppearance = (patch, immediateLabel) => {
    state.appearance = { ...state.appearance, ...patch };
    updatePreview();
    updateFitHint();
    clearTimeout(patchTimer);
    patchTimer = setTimeout(() => api.invoke('settings:patch', { appearance: state.appearance }), 90);
  };

  const patchNested = (key, sub) => {
    const cur = state.appearance[key] || {};
    patchAppearance({ [key]: { ...cur, ...sub } });
  };

  const bindRange = (id, valId, key, transform, fmt) => {
    const r = $('#' + id);
    r.oninput = () => {
      const v = Number(r.value);
      $('#' + valId).textContent = fmt ? fmt(v) : v;
      patchAppearance({ [key]: transform ? transform(v) : v });
    };
  };
  bindRange('rngIcon', 'valIcon', 'iconSize');
  bindRange('rngGap', 'valGap', 'gap');
  bindRange('rngOffset', 'valOffset', 'bottomOffset');
  bindRange('rngOpacity', 'valOpacity', 'opacity', null, (v) => v + '%');
  bindRange('rngBlur', 'valBlur', 'blur');
  bindRange('rngRadius', 'valRadius', 'radius');

  // 一键塞进一行
  $('#btnFitRow').onclick = () => {
    const f = fitOneRow();
    if (state.appearance.iconSize <= f.icon && state.appearance.gap <= f.gap) {
      toast('当前尺寸已经放得下一行');
      return;
    }
    patchAppearance({ iconSize: f.icon, gap: f.gap, layout: 'auto' });
    renderAppearance();
    toast(`已调整为 ${f.icon}px / 间距 ${f.gap}，全部排进一行`);
  };

  // 背景颜色
  $('#swBg').onclick = (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    patchAppearance({ bgColor: b.dataset.color || '' });
    renderSwatches(b.dataset.color || '');
  };
  $('#inBgColor').oninput = (e) => {
    const v = e.target.value;
    patchAppearance({ bgColor: v });
    renderSwatches(v);
  };

  // 玻璃底板
  $('#swGlass').onchange = (e) => patchAppearance({ glassOn: e.target.checked });

  // 准星放大
  $('#rngMagScale').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valMagScale').textContent = (v / 100).toFixed(2);
    patchNested('magnify', { scale: v / 100 });
  };
  $('#rngMagCount').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valMagCount').textContent = v;
    patchNested('magnify', { count: v });
  };
  $('#rngMagSpeed').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valMagSpeed').textContent = v + 'ms';
    patchNested('magnify', { speed: v });
  };

  // 悬停浅色底
  $('#swHoverBg').onchange = (e) => patchNested('hoverBg', { on: e.target.checked });
  $('#inHoverColor').oninput = (e) => patchNested('hoverBg', { color: e.target.value });

  // 描边
  $('#swStroke').onchange = (e) => patchNested('iconStroke', { on: e.target.checked });
  $('#rngStrokeW').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valStrokeW').textContent = v.toFixed(1);
    patchNested('iconStroke', { width: v });
  };
  $('#inStrokeColor').oninput = (e) => patchNested('iconStroke', { color: e.target.value });

  // 阴影
  $('#swShadow').onchange = (e) => patchNested('iconShadow', { on: e.target.checked });
  $('#rngShadowBlur').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valShadowBlur').textContent = v;
    patchNested('iconShadow', { blur: v });
  };
  $('#rngShadowY').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valShadowY').textContent = v;
    patchNested('iconShadow', { y: v });
  };
  $('#rngShadowAlpha').oninput = (e) => {
    const v = Number(e.target.value);
    $('#valShadowAlpha').textContent = v + '%';
    patchNested('iconShadow', { alpha: v });
  };
  $('#inShadowColor').oninput = (e) => patchNested('iconShadow', { color: e.target.value });

  // 栏阴影（整条 Dock 的投影）
  $('#swBarShadow').onchange = (e) => patchNested('barShadow', { on: e.target.checked });
  $('#rngBarBlur').oninput = (e) => { const v = Number(e.target.value); $('#valBarBlur').textContent = v; patchNested('barShadow', { blur: v }); };
  $('#rngBarY').oninput = (e) => { const v = Number(e.target.value); $('#valBarY').textContent = v; patchNested('barShadow', { y: v }); };
  $('#rngBarAlpha').oninput = (e) => { const v = Number(e.target.value); $('#valBarAlpha').textContent = v + '%'; patchNested('barShadow', { alpha: v }); };
  $('#inBarShadowColor').oninput = (e) => patchNested('barShadow', { color: e.target.value });

  $$('#segTheme button').forEach((b) => {
    b.onclick = () => {
      $$('#segTheme button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      patchAppearance({ theme: b.dataset.theme });
    };
  });
  $('#swLabels').onchange = (e) => patchAppearance({ showLabels: e.target.checked });
  $('#btnResetAppearance').onclick = async () => {
    await api.invoke('settings:patch', {
      appearance: {
        iconSize: 52, gap: 11, opacity: 64, blur: 26, theme: 'light', showLabels: false,
        hoverScale: 1.16, bottomOffset: 8, radius: 26,
        bgColor: '',
        glassOn: true,
        hoverBg: { on: true, color: '#ffffff', alpha: 70 },
        magnify: { count: 5, scale: 1.40, speed: 220 },
        iconStroke: { on: false, width: 1.5, color: '#ffffff' },
        iconShadow: { on: true, blur: 7, y: 3, color: '#141838', alpha: 22 },
        barShadow: { on: true, blur: 24, y: 14, color: '#1c204a', alpha: 22 },
      },
    });
    toast('外观已恢复默认');
  };

  // 小组件
  const list = $('#wElList');
  if (list) {
    list.addEventListener('input', onWidgetInput);
    list.addEventListener('change', onWidgetInput);
    list.addEventListener('click', onWidgetClick);
  }

  if ($('#swWidgets')) $('#swWidgets').onchange = (e) => {
    api.invoke('settings:patch', { widgets: { enabled: e.target.checked } }).catch(() => {});
    if (state && state.widgets) state.widgets.enabled = e.target.checked;
  };

  if ($('#btnWEdit')) $('#btnWEdit').onclick = async () => {
    await api.invoke('widget:edit', true).catch(() => {});
  };

  // 添加元素：面板里的小菜单
  const addMenu = $('#wAddMenu');
  if (addMenu) {
    addMenu.innerHTML = WTYPES.map((t) => {
      const d = WDEFS[t];
      return `<button data-type="${t}"><span class="mi">${esc(d.short)}</span><span>${esc(d.label)}<small>${esc(d.desc)}</small></span></button>`;
    }).join('');
    addMenu.onclick = async (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      addMenu.hidden = true;
      const el = await api.invoke('widget:element:add', { type: btn.dataset.type }).catch(() => null);
      if (el && el.id) { wOpen.add(el.id); renderWidgets(); }
    };
  }

  const toggleAdd = (box) => (e) => {
    e.stopPropagation();
    const m = $('#wAddMenu');
    if (!m) return;
    m.hidden = !m.hidden;
  };
  if ($('#btnWAdd')) $('#btnWAdd').onclick = toggleAdd();
  if ($('#btnWAdd2')) $('#btnWAdd2').onclick = toggleAdd();
  document.addEventListener('pointerdown', (e) => {
    const m = $('#wAddMenu');
    if (m && !m.hidden && !e.target.closest('.wadd-wrap')) m.hidden = true;
  });

  if ($('#btnWImport')) $('#btnWImport').onclick = async () => {
    const btn = $('#btnWImport');
    btn.disabled = true;
    const r = await api.invoke('preset:import').catch(() => null);
    btn.disabled = false;
    if (!r || !r.ok) {
      if (r && r.error) toast(r.error, 'err');
      return;
    }
    if (r.mode === 'replace') wOpen.clear();
    renderWidgets();
    toast(`已${r.mode === 'append' ? '追加' : '导入'} ${r.count} 个元素`);
  };

  if ($('#btnWExport')) $('#btnWExport').onclick = async () => {
    if (!wElements().length) { toast('还没有元素可以导出', 'err'); return; }
    const btn = $('#btnWExport');
    btn.disabled = true;
    const r = await api.invoke('preset:export').catch(() => null);
    btn.disabled = false;
    if (!r || !r.ok) {
      if (r && r.error) toast(r.error, 'err');
      return;
    }
    const extra = [r.fonts ? `${r.fonts} 个字体` : '', r.images ? `${r.images} 张图片` : ''].filter(Boolean).join('、');
    toast(`预设已保存${extra ? '（含 ' + extra + '）' : ''}`);
    if (r.skipped && r.skipped.length) toast(`${r.skipped.length} 个资源太大，没有打包进去`, 'err');
  };

  // 恢复默认：点两次才执行，避免误触把摆好的元素全清掉
  let resetArmed = 0;
  if ($('#btnWReset')) $('#btnWReset').onclick = async (e) => {
    const btn = e.currentTarget;
    if (!resetArmed) {
      resetArmed = setTimeout(() => {
        resetArmed = 0;
        btn.textContent = '恢复默认元素';
        btn.classList.remove('danger');
      }, 3200);
      btn.textContent = '再点一次确认';
      btn.classList.add('danger');
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = 0;
    btn.textContent = '恢复默认元素';
    btn.classList.remove('danger');
    await api.invoke('widget:reset').catch(() => {});
    wOpen.clear();
    renderWidgets();
    toast('已恢复默认元素');
  };

  if ($('#btnWFolder')) $('#btnWFolder').onclick = () => api.invoke('app:openConfigDir');

  // 关于
  $('#btnOpenCfg').onclick = () => api.invoke('app:openConfigDir');
  if ($('#btnUpdate')) $('#btnUpdate').onclick = () => api.invoke('app:applyUpdate');
  $('#btnRestart').onclick = () => api.invoke('app:restart');
  $('#btnQuit').onclick = () => api.invoke('app:quit');

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); api.invoke('items:add', []); }
  });
}

/* ------------------------------ 启动 ------------------------------ */
api.on('state:update', async (s) => {
  const prev = state;
  state = s;
  if (!appInit) return;
  await syncViews(prev, s);
});

api.on('appearance:update', (a) => {
  if (!state || !a) return;
  state.appearance = a;
  renderOverview();
  if (currentPage === 'appearance') renderAppearance();
});

api.on('widgets:update', (payload) => {
  if (!state || !payload || !payload.widgets) return;
  const prevIds = wElements().map((e) => e.id).join(',');
  const nextIds = (payload.widgets.elements || []).map((e) => e && e.id).join(',');
  state.widgets = payload.widgets;
  if (Array.isArray(payload.fonts)) wFonts.custom = payload.fonts;
  if (currentPage !== 'widgets') return;
  // 自己改的只刷新摘要，不然每敲一个字输入框都会重建
  if (payload.src !== 'panel' || prevIds !== nextIds) renderWidgets();
  else refreshWSummaries();
});

api.on('widget:edit', (on) => {
  const btn = $('#btnWEdit');
  if (btn) btn.textContent = on ? '正在编辑…' : '可视化编辑';
});

function loadFontLists() {
  if (wFonts.system.length) { renderFontList(); return; }
  api.invoke('font:list').then((r) => {
    if (!r) return;
    if (Array.isArray(r.system)) wFonts.system = r.system;
    if (Array.isArray(r.custom)) wFonts.custom = r.custom;
    if (currentPage === 'widgets') {
      renderFontList();
      const info = $('#wFontInfo');
      if (info) info.textContent = (wFonts.custom || []).length ? `已导入 ${wFonts.custom.length} 个字体` : '';
    }
  }).catch(() => {});
}

api.on('toast', (t) => toast(t.text, t.type || 'ok'));

api.on('focus:tab', (tab) => go(tab));

/* ------------------------------ 拖入文件 ------------------------------ */
// 面板里拖入文件 = 放进「文件收纳」；同时阻止 Electron 默认的“导航到文件”
const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

document.addEventListener('dragenter', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const paths = [];
  for (const f of Array.from(e.dataTransfer.files || [])) {
    let p = '';
    try { p = api.getPathForFile(f); } catch (_) { p = f.path || ''; }
    if (p) paths.push(p);
  }
  if (!paths.length) return;
  const r = await api.invoke('archive:addFiles', paths);
  toast(r && r.moved ? `已收纳 ${r.moved} 个文件到 DeskGlow\\文件收纳` : '这些文件已经在收纳夹里了');
});

(async () => {
  const boot = await api.invoke('app:bootstrap');
  if (!state) state = boot.state;
  taskbarStatus = boot.taskbar;
  loginItem = boot.loginItem;
  bindEvents();
  appInit = true;
  await refreshUnused();
  renderAll();
  renderTaskbar();
  go('overview');
})();
