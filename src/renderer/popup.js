'use strict';

const api = window.dg;
const $ = (id) => document.getElementById(id);

let params = null;
let state = null;
let query = '';

const esc = (s) =>
  String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function iconOrFallback(it) {
  if (it.icon) return `<img class="ico" src="${it.icon}" alt="" draggable="false" />`;
  const ch = esc((it.name || '?').trim().charAt(0).toUpperCase());
  return `<div class="fb">${ch}</div>`;
}

/* 去掉扩展名，只显示文件名主体 */
function baseName(name, ext) {
  const n = String(name || '');
  if (!ext) return n;
  return n.toLowerCase().endsWith(ext.toLowerCase()) ? n.slice(0, -ext.length) : n;
}

/* ------------------------------ 分组 ------------------------------ */
function renderGroup() {
  const group = state.items.find((i) => i.id === params.id);
  if (!group) {
    $('body').innerHTML = `<div class="empty-state">该分组已不存在</div>`;
    $('count').textContent = '';
    return;
  }
  $('searchWrap').classList.add('hide');
  $('count').textContent = `${group.children.length} 个图标`;

  const gname = $('gname');
  gname.textContent = group.name;
  gname.onclick = () => startRename(group);
  $('btnKind').classList.add('hide');

  $('body').innerHTML = !group.children.length
    ? `<div class="empty-state">分组是空的<br/>把 Dock 上的图标拖进来试试</div>`
    : `<div class="grid">${group.children
      .map(
        (c) => `<div class="cell" data-child="${c.id}" title="拖动排序">
          ${iconOrFallback(c)}
          <div class="nm">${esc(c.name)}</div>
        </div>`
      )
      .join('')}</div>`;
}

function startRename(group) {
  const el = $('gname');
  el.contentEditable = 'true';
  el.focus();
  document.execCommand && document.execCommand('selectAll', false, null);
  const done = async (save) => {
    el.contentEditable = 'false';
    const v = el.textContent.trim();
    if (save && v) {
      await api.invoke('group:rename', { id: group.id, name: v });
    } else {
      el.textContent = group.name;
    }
  };
  el.addEventListener('blur', () => done(true), { once: true });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); el.textContent = group.name; el.blur(); }
  });
}

const KINDS = [
  ['folder', '文件夹', null],
  ['image', '图片', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.heic', '.tif', '.tiff']],
  ['video', '视频', ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.flv']],
  ['audio', '音频', ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma']],
  ['doc', '文档', ['.doc', '.docx', '.docm', '.rtf', '.odt', '.wps', '.pages', '.pdf']],
  ['sheet', '表格', ['.xls', '.xlsx', '.xlsm', '.csv', '.et', '.numbers']],
  ['slide', '演示', ['.ppt', '.pptx', '.pps', '.ppsx', '.key', '.dps']],
  ['pack', '压缩', ['.zip', '.rar', '.7z', '.tar', '.gz']],
  ['text', '文本', ['.txt', '.md', '.log', '.ini', '.json', '.xml', '.html', '.htm']],
  ['other', '其他', null],
];

function fileKind(it) {
  if (it.isDir) return 'folder';
  const ext = String(it.ext || '').toLowerCase();
  for (const [id, , list] of KINDS) {
    if (list && list.includes(ext)) return id;
  }
  return 'other';
}

function fileCell(it) {
  const ext = it.isDir ? '文件夹' : (it.ext || '').replace('.', '').toUpperCase();
  return `<div class="cell" data-path="${esc(it.path)}" data-cat="${fileKind(it)}" title="拖动排序">
    ${iconOrFallback(it)}
    <div class="nm" title="${esc(it.name)}">${esc(baseName(it.name, it.isDir ? '' : it.ext))}</div>
    <div class="ext">${esc(ext)}</div>
  </div>`;
}

/* ------------------------------ 文件收纳 ------------------------------ */
function renderArchive() {
  const all = state.archiveItems || [];
  $('searchWrap').classList.remove('hide');
  $('gname').textContent = '';
  $('gname').onclick = null;
  const grouped = !!(state.archive && state.archive.groupByExt);
  const kindBtn = $('btnKind');
  kindBtn.classList.remove('hide');
  kindBtn.classList.toggle('on', grouped);

  let list = all;
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    list = list.filter((it) => it.name.toLowerCase().includes(q));
  }

  $('count').textContent = `${list.length} 个文件`;

  if (!list.length) {
    $('body').innerHTML = `<div class="empty-state">${all.length ? '没有匹配的文件' : '桌面上暂时没有需要收纳的文件'}</div>`;
    return;
  }
  if (!grouped) {
    $('body').innerHTML = `<div class="grid">${list.map(fileCell).join('')}</div>`;
    return;
  }
  const buckets = new Map();
  for (const it of list) {
    const k = fileKind(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  $('body').innerHTML = KINDS.filter(([id]) => buckets.has(id))
    .map(([id, name]) => `<section class="sec" data-cat="${id}">
      <div class="sec-h">${name}</div>
      <div class="grid">${buckets.get(id).map(fileCell).join('')}</div>
    </section>`)
    .join('');
}

/* ------------------------------ 渲染 ------------------------------ */
function fit() {
  requestAnimationFrame(() => {
    const body = $('body');
    const foot = document.querySelector('.foot');
    if (!body || !foot) return;
    const inner = body.firstElementChild;
    const contentH = inner ? Math.ceil(inner.getBoundingClientRect().height) : 0;
    const need = Math.min(contentH, 420) + Math.ceil(foot.getBoundingClientRect().height) + 26 + 48 + 8;
    api.invoke('popup:fit', need);
  });
}

function render() {
  if (!state || !params) return;
  document.body.dataset.theme = state.appearance.theme || 'light';
  if (params.kind === 'archive') renderArchive();
  else renderGroup();
  fit();
}

/* ------------------------------ 事件 ------------------------------ */
function close() {
  api.invoke('popup:close');
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1800);
}

$('btnClose').addEventListener('click', close);

// 点击卡片外的透明留白也关闭
document.body.addEventListener('pointerdown', (e) => {
  if (e.target === document.body) close();
});

$('btnKind').addEventListener('click', () => {
  if (!state || !params || params.kind !== 'archive') return;
  const on = !(state.archive && state.archive.groupByExt);
  api.invoke('settings:patch', { archive: { groupByExt: on } });
});

$('body').addEventListener('click', async (e) => {
  if (blockClick) { blockClick = false; return; }
  const cell = e.target.closest('.cell');
  if (!cell) return;
  if (params.kind === 'group' && cell.dataset.child) {
    const group = state.items.find((i) => i.id === params.id);
    const child = group && group.children.find((c) => c.id === cell.dataset.child);
    if (child) {
      api.invoke('item:launch', child.path);
      close();
    }
    return;
  }
  if (cell.dataset.path) {
    api.invoke('item:launch', cell.dataset.path);
    close();
  }
});

$('body').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cell = e.target.closest('.cell');
  if (!cell) return;
  if (params.kind === 'group' && cell.dataset.child) {
    api.invoke('child:menu', { groupId: params.id, childId: cell.dataset.child });
    return;
  }
  if (cell.dataset.path) api.invoke('file:menu', cell.dataset.path);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== $('gname')) close();
});

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  render();
});

/* ------------------------------ 拖动排序 ------------------------------ */
let blockClick = false;
let drag = null;

function cellKey(cell) {
  return cell.dataset.child || cell.dataset.path || '';
}

function placeIds(scope, moving, over, before) {
  const cells = [...scope.querySelectorAll('.cell')];
  const ids = cells.map(cellKey).filter(Boolean);
  const id = cellKey(moving);
  const arr = ids.filter((x) => x !== id);
  let anchor = null;
  if (over && over !== moving) {
    if (before) anchor = cellKey(over);
    else {
      const i = cells.indexOf(over);
      let n = i + 1;
      if (cells[n] === moving) n += 1;
      anchor = cells[n] ? cellKey(cells[n]) : null;
    }
  }
  if (!anchor) arr.push(id);
  else {
    const at = arr.indexOf(anchor);
    if (at < 0) arr.push(id);
    else arr.splice(at, 0, id);
  }
  return arr;
}

$('body').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const cell = e.target.closest('.cell');
  if (!cell) return;
  drag = { cell, x: e.clientX, y: e.clientY, moved: false };
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
  drag.moved = true;
  drag.cell.classList.add('dragging');
  drag.cell.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const over = hit && hit.closest ? hit.closest('.cell') : null;
  document.querySelectorAll('.cell.over').forEach((el) => el.classList.remove('over'));
  const grouped = !!document.querySelector('.sec');
  const same = !grouped || !over || over.dataset.cat === drag.cell.dataset.cat;
  if (over && over !== drag.cell && same) over.classList.add('over');
  drag.over = over && same ? over : null;
});

window.addEventListener('pointerup', async (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.cell.style.pointerEvents = '';
  d.cell.classList.remove('dragging');
  document.querySelectorAll('.cell.over').forEach((el) => el.classList.remove('over'));
  if (!d.moved) return;
  blockClick = true;
  const over = d.over;
  if (!over || over === d.cell) return;
  const rect = over.getBoundingClientRect();
  const before = e.clientX - rect.left < rect.width / 2;
  const scope = (document.querySelector('.sec') && over.closest('.sec')) || over.closest('.grid') || $('body');
  const ids = placeIds(scope, d.cell, over, before);
  if (params && params.kind === 'group') {
    await api.invoke('group:reorder', { groupId: params.id, ids });
  } else if (params && params.kind === 'archive') {
    await api.invoke('archive:reorder', { paths: ids });
  }
});

/* ------------------------------ 拖入文件 → 放进软件文件夹 ------------------------------ */
function pathsFromDrop(dt) {
  const out = [];
  if (!dt) return out;
  for (const f of Array.from(dt.files || [])) {
    let p = '';
    try { p = api.getPathForFile(f); } catch (_) { p = f.path || ''; }
    if (p) out.push(p);
  }
  return out;
}

let dropDepth = 0;

const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // 无论是不是文件合集窗口，都要拦住，否则 Electron 会导航到文件
  if (!params || params.kind !== 'archive') return;
  dropDepth++;
  $('dropMask').classList.add('on');
});

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = params && params.kind === 'archive' ? 'copy' : 'none';
});

document.addEventListener('dragleave', () => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) $('dropMask').classList.remove('on');
});

document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropDepth = 0;
  $('dropMask').classList.remove('on');
  if (!params || params.kind !== 'archive') return;
  const paths = pathsFromDrop(e.dataTransfer);
  if (!paths.length) return;
  const r = await api.invoke('archive:addFiles', paths);
  if (r && r.moved) toast(`已收纳 ${r.moved} 个文件`);
  else toast('这些文件已经在收纳夹里了');
});

/* ------------------------------ 启动 ------------------------------ */
api.on('state:update', (s) => {
  state = s;
  render();
});

api.on('appearance:update', (a) => {
  if (!state || !a) return;
  state.appearance = a;
  document.body.dataset.theme = a.theme || 'light';
});

(async () => {
  params = await api.invoke('popup:params');
  state = await api.invoke('state:get');
  render();
  if (params && params.kind === 'archive') setTimeout(() => $('search').focus(), 250);
})();
