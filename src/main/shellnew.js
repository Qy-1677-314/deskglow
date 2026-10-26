'use strict';
/**
 * 文件收纳的「新建」菜单，对齐资源管理器。
 * 类型来自本机 ShellNew 登记（资源管理器「新建」用的同一份列表）。
 * 文本文档始终提供：这台机器的登记里常常没有 .txt。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ps = require('./ps');

const TTL = 5 * 60 * 1000;
let cache = null;
let cacheAt = 0;
let pending = null;

function cleanMenuLabel(s) {
  return String(s || '')
    .replace(/\(&[^)]*\)/g, '')
    .replace(/&/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function isPlainExt(name) {
  return /^\.[a-z0-9]{1,8}$/i.test(String(name || ''));
}

function usableLabel(label, ext) {
  const s = cleanMenuLabel(label);
  if (s && !s.startsWith('@')) return s.slice(0, 80);
  if (ext && isPlainExt(ext)) return ext.slice(1).toUpperCase() + ' 文件';
  return '新建项';
}

function skipClass(name) {
  const key = String(name || '').toLowerCase();
  return !key || key === 'folder' || key === '.lnk' || key === '.url';
}

// 这些格式空文件打不开。0 字节的 Office 占位模板同样不能拿来复制。
const STRUCTURED_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip']);

/**
 * 同一扩展名下，有可用模板或固定内容时不再另建空文件。
 * resolveTemplate(fileName) 返回可用的绝对路径；空字符串表示模板缺失或是 0 字节占位。
 */
function choose(raw, resolveTemplateFile) {
  const order = asArray(raw && raw.order).map((x) => String(x || '')).filter(Boolean);
  const entries = asArray(raw && raw.entries);
  const byClass = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const key = String(e.className || '').toLowerCase();
    if (skipClass(key) || e.isFolder) continue;
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(e);
  }
  const classes = order.length ? order : [...byClass.keys()];
  const out = [];
  const seen = new Set();
  const push = (spec) => {
    const id = [spec.mode, spec.ext, spec.label, spec.template || '', spec.command || ''].join('|');
    if (seen.has(id)) return;
    seen.add(id);
    out.push(spec);
  };
  for (const cls of classes) {
    const key = String(cls).toLowerCase();
    if (skipClass(key)) continue;
    const group = byClass.get(key) || [];
    const ext = isPlainExt(cls) ? String(cls).toLowerCase() : '';
    const specs = [];
    for (const e of group) {
      const label = usableLabel(e.label, ext);
      const stem = cleanMenuLabel(e.stem || '');
      const base = { label, stem: stem && !stem.startsWith('@') ? stem : '', ext };
      if (e.fileName) {
        const found = typeof resolveTemplateFile === 'function'
          ? resolveTemplateFile(e.fileName)
          : String(e.fileName);
        if (found) specs.push({ ...base, mode: 'template', template: found });
      } else if (e.data) specs.push({ ...base, mode: 'data', data: String(e.data) });
      else if (e.command) specs.push({ ...base, mode: 'command', command: String(e.command), ext: '' });
      else if (e.nullFile && !e.noEmpty && !STRUCTURED_EXT.has(ext)) specs.push({ ...base, mode: 'empty' });
    }
    const hasPayload = specs.some((s) => s.mode === 'template' || s.mode === 'data');
    for (const spec of specs) {
      if (hasPayload && spec.mode === 'empty') continue;
      if (!ext && spec.mode !== 'command') continue;
      push(spec);
    }
  }
  if (!out.some((s) => s.ext === '.txt')) {
    out.unshift({ label: '文本文档', ext: '.txt', stem: '', mode: 'empty' });
  }
  const counts = new Map();
  for (const it of out) counts.set(it.label, (counts.get(it.label) || 0) + 1);
  return out.map((it) => {
    if ((counts.get(it.label) || 0) < 2 || !it.ext) return it;
    return { ...it, label: `${it.label} (${it.ext})` };
  }).slice(0, 30);
}

function resolveTemplate(fileName) {
  const name = String(fileName || '').trim();
  if (!name) return '';
  const bases = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Templates'),
    process.env.ProgramData && path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Templates'),
    process.env.WINDIR && path.join(process.env.WINDIR, 'ShellNew'),
  ].filter(Boolean);
  const candidates = [];
  if (path.isAbsolute(name)) candidates.push(name);
  else for (const b of bases) candidates.push(path.join(b, name));
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) return p;
    } catch (_) {}
  }
  return '';
}

function prepare(raw) {
  return choose(raw, resolveTemplate);
}

function readRaw() {
  const out = ps.tmpFile('shellnew.json');
  return ps.runScript('shellnew.ps1', ['-OutFile', out], { timeout: 20000 }).then((r) => {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) {}
    try { fs.unlinkSync(out); } catch (_) {}
    if (!r.ok || !data) return { order: [], entries: [] };
    return data;
  });
}

function list() {
  if (cache && Date.now() - cacheAt < TTL) return Promise.resolve(cache);
  if (pending) return pending;
  pending = readRaw()
    .then((raw) => {
      cache = prepare(raw);
      cacheAt = Date.now();
      pending = null;
      return cache;
    })
    .catch(() => {
      pending = null;
      cache = prepare({ order: [], entries: [] });
      cacheAt = Date.now();
      return cache;
    });
  return pending;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
    if (i > 999) break;
  }
  return p;
}

function safeStem(spec) {
  let stem = spec.stem || '';
  if (!stem) {
    const label = spec.label || '文件';
    const gap = /^[A-Za-z0-9]/.test(label) ? ' ' : '';
    stem = `新建${gap}${label}`;
  }
  stem = stem.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!stem) stem = '新建文件';
  const ext = spec.ext || '';
  if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length).trim() || '新建文件';
  return stem;
}

function explain(e) {
  const code = e && e.code;
  if (code === 'EPERM' || code === 'EACCES') return '没有权限在这里新建';
  if (code === 'ENOSPC') return '磁盘空间不够';
  if (code === 'ENOENT') return '文件夹不在了';
  return '没能创建文件';
}

function splitCommand(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  let exe = '';
  let rest = '';
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 1) return null;
    exe = s.slice(1, end);
    rest = s.slice(end + 1).trim();
  } else {
    const i = s.search(/\s/);
    exe = i < 0 ? s : s.slice(0, i);
    rest = i < 0 ? '' : s.slice(i + 1).trim();
  }
  if (!exe) return null;
  const args = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(rest))) args.push(m[1] !== undefined ? m[1] : m[2]);
  return { exe, args };
}

function runCommand(command, filePath) {
  let cmd = String(command || '');
  if (filePath && cmd.includes('%1')) {
    const q = '"' + String(filePath).replace(/"/g, '') + '"';
    cmd = cmd.replace(/%1/g, () => q);
  }
  const parts = splitCommand(cmd);
  if (!parts) return { ok: false, error: '没能打开新建' };
  try {
    if (!fs.existsSync(parts.exe)) return { ok: false, error: '新建程序不在了' };
  } catch (_) {
    return { ok: false, error: '没能打开新建' };
  }
  try {
    const child = spawn(parts.exe, parts.args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (_) {
    return { ok: false, error: '没能打开新建' };
  }
  return { ok: true };
}

function create(dir, spec) {
  if (!dir || !spec) return { ok: false, error: '不能在这里新建文件' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: explain(e) }; }
  if (spec.mode === 'command') {
    let filePath = '';
    if (String(spec.command || '').includes('%1') && spec.ext) {
      filePath = uniquePath(dir, safeStem(spec) + spec.ext);
      try { fs.writeFileSync(filePath, ''); } catch (e) { return { ok: false, error: explain(e) }; }
    }
    const started = runCommand(spec.command, filePath);
    if (!started.ok) {
      if (filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }
      return started;
    }
    return { ok: true, opened: true, path: filePath, name: filePath ? path.basename(filePath) : spec.label };
  }
  const ext = spec.ext || '';
  const dest = uniquePath(dir, safeStem(spec) + ext);
  try {
    if (spec.mode === 'template') {
      if (!spec.template || !fs.existsSync(spec.template)) return { ok: false, error: '模板不在了' };
      fs.copyFileSync(spec.template, dest);
    } else if (spec.mode === 'data') {
      const buf = Buffer.from(spec.data || '', 'base64');
      if (!buf.length) return { ok: false, error: '没有文件内容' };
      fs.writeFileSync(dest, buf);
    } else {
      fs.writeFileSync(dest, '');
    }
  } catch (e) {
    try { fs.unlinkSync(dest); } catch (_) {}
    return { ok: false, error: explain(e) };
  }
  return { ok: true, path: dest, name: path.basename(dest) };
}

module.exports = { list, create, choose, cleanMenuLabel, splitCommand };
