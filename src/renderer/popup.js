'use strict';

const api = window.dg;
const $ = (id) => document.getElementById(id);

let params = null;
let state = null;
let query = '';
let browse = [];
let opening = false;

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
  showArchiveTools(false);
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

function fileTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileCell(it, tile) {
  const ext = it.isDir ? '文件夹' : (it.ext || '').replace('.', '').toUpperCase();
  const when = fileTime(it.mtime);
  const sub = when ? `${ext} · ${when}` : ext;
  const dir = it.isDir ? ' data-dir="1"' : '';
  const title = it.isDir ? '打开' : '拖动排序';
  if (tile) {
    return `<div class="cell tile" data-path="${esc(it.path)}" data-cat="${fileKind(it)}"${dir} title="${title}">
      ${iconOrFallback(it)}
      <div class="meta">
        <div class="nm" title="${esc(it.name)}">${esc(baseName(it.name, it.isDir ? '' : it.ext))}</div>
        <div class="ext">${esc(sub)}</div>
      </div>
    </div>`;
  }
  return `<div class="cell" data-path="${esc(it.path)}" data-cat="${fileKind(it)}"${dir} title="${title}">
    ${iconOrFallback(it)}
    <div class="nm" title="${esc(it.name)}">${esc(baseName(it.name, it.isDir ? '' : it.ext))}</div>
    <div class="ext">${esc(ext)}</div>
  </div>`;
}

function showArchiveTools(on) {
  $('viewSeg').classList.toggle('hide', !on);
  $('btnKind').classList.toggle('hide', !on);
  $('sortSeg').classList.toggle('hide', !on);
}

/* ------------------------------ 文件收纳 ------------------------------ */
function currentFolder() {
  return browse.length ? browse[browse.length - 1] : null;
}

function sortedBrowse(list) {
  const mode = (state.archive && state.archive.sort) || 'off';
  const arr = list.slice();
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  if (mode === 'name') arr.sort(byName);
  else if (mode === 'mtime') arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || byName(a, b));
  return arr;
}

function crumbBar() {
  const cur = currentFolder();
  if (!cur) return '';
  return `<div class="crumbbar"><button type="button" class="back" data-up="1">返回</button><span>${esc(cur.name)}</span></div>`;
}

async function enterDir(dir, name) {
  if (!dir || opening) return;
  opening = true;
  const r = await api.invoke('archive:readDir', dir);
  opening = false;
  if (!r || !r.ok) {
    toast((r && r.error) || '打不开这个文件夹');
    return;
  }
  const top = currentFolder();
  const same = top && top.path.toLowerCase() === String(r.path).toLowerCase();
  if (same) {
    top.items = r.items || [];
    if (name) top.name = name;
  } else {
    browse.push({ path: r.path, name: name || r.path, items: r.items || [] });
  }
  query = '';
  if ($('search')) $('search').value = '';
  render();
  if ($('body')) $('body').scrollTop = 0;
}

function goUp() {
  browse.pop();
  query = '';
  if ($('search')) $('search').value = '';
  render();
  if ($('body')) $('body').scrollTop = 0;
}

async function reloadBrowse() {
  const top = currentFolder();
  if (!top) return;
  const r = await api.invoke('archive:readDir', top.path);
  if (!r || !r.ok) {
    toast((r && r.error) || '文件夹不在了');
    browse.pop();
    render();
    return;
  }
  top.items = r.items || [];
  top.path = r.path;
  render();
}

function renderArchive() {
  const inside = currentFolder();
  const all = inside ? sortedBrowse(inside.items || []) : (state.archiveItems || []);
  const arc = state.archive || {};
  $('searchWrap').classList.remove('hide');
  $('gname').textContent = '';
  $('gname').onclick = null;
  showArchiveTools(true);
  const grouped = !!arc.groupByExt;
  const tile = arc.view === 'tile';
  const sort = arc.sort || 'off';
  $('btnKind').classList.toggle('on', grouped);
  $('viewSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === (tile ? 'tile' : 'icon')));
  $('sortSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.sort === sort));

  let list = all;
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    list = list.filter((it) => String(it.name || '').toLowerCase().includes(q));
  }

  $('count').textContent = inside ? `${list.length} 项` : `${list.length} 个文件`;
  const cell = (it) => fileCell(it, tile);
  const gridCls = tile ? 'grid tiles' : 'grid';
  const bar = crumbBar();

  if (!list.length) {
    const empty = query.trim()
      ? '没有匹配的文件'
      : inside
        ? '这个文件夹是空的<br/>右键可以新建文件夹'
        : '桌面上暂时没有需要收纳的文件<br/>右键可以新建文件夹';
    $('body').innerHTML = `${bar}<div class="empty-state">${empty}</div>`;
    return;
  }
  if (!grouped) {
    $('body').innerHTML = `${bar}<div class="${gridCls}">${list.map(cell).join('')}</div>`;
    return;
  }
  const buckets = new Map();
  for (const it of list) {
    const k = fileKind(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  $('body').innerHTML = bar + KINDS.filter(([id]) => buckets.has(id))
    .map(([id, name]) => `<section class="sec" data-cat="${id}">
      <div class="sec-h">${name}</div>
      <div class="${gridCls}">${buckets.get(id).map(cell).join('')}</div>
    </section>`)
    .join('');
}

/* ------------------------------ 渲染 ------------------------------ */
function fit() {
  requestAnimationFrame(() => {
    const body = $('body');
    const foot = document.querySelector('.foot');
    if (!body || !foot) return;
    let contentH = 0;
    for (const el of body.children) contentH += Math.ceil(el.getBoundingClientRect().height);
    const prompt = $('folderPrompt');
    const promptH = prompt && !prompt.classList.contains('hide') ? Math.ceil(prompt.getBoundingClientRect().height) : 0;
    const need = Math.min(contentH, 420) + promptH + Math.ceil(foot.getBoundingClientRect().height) + 26 + 48 + 8;
    api.invoke('popup:fit', need);
  });
}

function contentKey() {
  if (!state || !params) return '';
  if (params.kind === 'archive') return (state.archiveItems || []).map((it) => it.path).join('\n');
  const group = (state.items || []).find((i) => i.id === params.id);
  return group ? (group.children || []).map((c) => `${c.id}:${c.path}`).join('\n') : '';
}

let fitKey = '';

function render() {
  if (!state || !params) return;
  document.body.dataset.theme = state.appearance.theme || 'light';
  if (params.kind === 'archive') renderArchive();
  else renderGroup();
  const key = contentKey();
  if (key !== fitKey) {
    fitKey = key;
    fit();
  }
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

function patchArchive(part) {
  return api.invoke('settings:patch', { archive: part });
}

$('btnKind').addEventListener('click', () => {
  if (!state || !params || params.kind !== 'archive') return;
  const on = !(state.archive && state.archive.groupByExt);
  patchArchive({ groupByExt: on });
});

$('viewSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn || !state || !params || params.kind !== 'archive') return;
  if ((state.archive && state.archive.view) === btn.dataset.view) return;
  if (!state.archive && btn.dataset.view === 'icon') return;
  patchArchive({ view: btn.dataset.view });
});

$('sortSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (!btn || !state || !params || params.kind !== 'archive') return;
  const cur = (state.archive && state.archive.sort) || 'off';
  if (cur === btn.dataset.sort) return;
  patchArchive({ sort: btn.dataset.sort });
});

$('btnRefresh').addEventListener('click', async () => {
  $('btnRefresh').disabled = true;
  await api.invoke('views:refresh');
  if (browse.length) await reloadBrowse();
  $('btnRefresh').disabled = false;
  toast('已重新读取');
});

function showFolderPrompt() {
  const box = $('folderPrompt');
  box.classList.remove('hide');
  const input = $('folderName');
  input.value = '';
  input.focus();
}

function hideFolderPrompt() {
  $('folderPrompt').classList.add('hide');
  $('folderName').value = '';
}

async function createFolder() {
  const name = $('folderName').value.trim();
  if (!name) return;
  const dir = currentFolder() ? currentFolder().path : '';
  const r = await api.invoke('archive:mkdir', dir ? { name, dir } : name);
  if (r && r.ok) {
    hideFolderPrompt();
    toast(`已创建「${r.name || name}」`);
    if (browse.length) await reloadBrowse();
  } else {
    toast((r && r.error) || '没能创建文件夹');
  }
}

$('folderOk').addEventListener('click', createFolder);
$('folderCancel').addEventListener('click', hideFolderPrompt);
$('folderName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); createFolder(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideFolderPrompt(); }
});

api.on('archive:nameFolder', showFolderPrompt);
api.on('archive:enter', (info) => {
  if (!info || !info.path || !params || params.kind !== 'archive') return;
  enterDir(info.path, info.name);
});

$('body').addEventListener('click', async (e) => {
  if (e.target.closest('[data-up]')) {
    goUp();
    return;
  }
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
  if (cell.dataset.dir === '1') {
    const nm = cell.querySelector('.nm');
    enterDir(cell.dataset.path, nm ? nm.textContent : '');
    return;
  }
  if (cell.dataset.path) {
    api.invoke('item:launch', cell.dataset.path);
    close();
  }
});

$('body').addEventListener('contextmenu', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  e.preventDefault();
  if (params.kind === 'group' && cell.dataset.child) {
    api.invoke('child:menu', { groupId: params.id, childId: cell.dataset.child });
    return;
  }
  if (cell.dataset.path) api.invoke('file:menu', cell.dataset.path);
});

$('card').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.cell')) return;
  if (!params || params.kind !== 'archive') return;
  e.preventDefault();
  api.invoke('archive:blankMenu');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.activeElement === $('gname')) return;
  if (!$('folderPrompt').classList.contains('hide')) { hideFolderPrompt(); return; }
  if (browse.length && params && params.kind === 'archive') { goUp(); return; }
  close();
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
    const sort = (state.archive && state.archive.sort) || 'off';
    if (sort !== 'off') {
      toast('先把自动排序关掉，才能手动排');
      return;
    }
    const top = currentFolder();
    if (top) {
      const map = new Map((top.items || []).map((it) => [it.path, it]));
      const next = ids.map((id) => map.get(id)).filter(Boolean);
      for (const it of top.items || []) if (!next.includes(it)) next.push(it);
      top.items = next;
      render();
      return;
    }
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
  const dir = currentFolder() ? currentFolder().path : '';
  const r = await api.invoke('archive:addFiles', dir ? { paths, dir } : paths);
  if (browse.length) await reloadBrowse();
  if (r && r.moved) toast(dir ? `已放进这个文件夹 ${r.moved} 个` : `已收纳 ${r.moved} 个文件`);
  else toast(dir ? '没有可放进来的文件' : '这些文件已经在收纳夹里了');
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
