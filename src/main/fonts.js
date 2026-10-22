'use strict';
/*
 * 枚举本机已安装的字体家族。
 * 直接读 ttf/otf/ttc 文件里的 name 表，不依赖 System.Drawing，也不起 PowerShell。
 * 只读表头，几百个字体也就一两百毫秒，结果缓存十分钟。
 */
const fs = require('fs');
const path = require('path');

const FONT_EXT = ['.ttf', '.otf', '.ttc'];
const CACHE_MS = 10 * 60 * 1000;

let cache = { at: 0, list: [] };

function fontDirs() {
  const win = process.env.SystemRoot || 'C:\\Windows';
  const dirs = [path.join(win, 'Fonts')];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  return dirs;
}

/** name 表里挑家族名：typographic family(16) 优先，Windows 平台优先 */
function namesFromNameTable(tbl) {
  if (tbl.length < 6) return [];
  const count = tbl.readUInt16BE(2);
  const strOff = tbl.readUInt16BE(4);
  const found = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    if (p + 12 > tbl.length) break;
    const pid = tbl.readUInt16BE(p);
    const nid = tbl.readUInt16BE(p + 6);
    const len = tbl.readUInt16BE(p + 8);
    const off = tbl.readUInt16BE(p + 10);
    if (nid !== 1 && nid !== 16) continue;
    if (pid !== 3 && pid !== 0 && pid !== 1) continue;
    const start = strOff + off;
    if (len <= 0 || start + len > tbl.length) continue;
    let s;
    if (pid === 1) {
      s = tbl.toString('latin1', start, start + len);
    } else {
      s = '';
      for (let j = start; j + 1 < start + len; j += 2) s += String.fromCharCode(tbl.readUInt16BE(j));
    }
    s = s.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    if (s) found.push({ name: s, typographic: nid === 16, win: pid === 3 });
  }
  // 同一字体里英文名和中文名都收着，用户打哪种都能选中
  return found.sort((a, b) => (b.typographic - a.typographic) || (b.win - a.win)).map((x) => x.name);
}

function namesOfFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return [];
    const tag = head.toString('latin1', 0, 4);
    let offsets = [0];
    if (tag === 'ttcf') {
      const num = Math.min(head.readUInt32BE(8), 24);
      const buf = Buffer.alloc(num * 4);
      if (fs.readSync(fd, buf, 0, buf.length, 12) < buf.length) return [];
      offsets = [];
      for (let i = 0; i < num; i++) offsets.push(buf.readUInt32BE(i * 4));
    } else if (tag !== '\u0000\u0001\u0000\u0000' && tag !== 'OTTO' && tag !== 'true') {
      return [];
    }
    const out = [];
    for (const off of offsets) {
      const dir = Buffer.alloc(12);
      if (fs.readSync(fd, dir, 0, 12, off) < 12) continue;
      const numTables = dir.readUInt16BE(4);
      if (!numTables || numTables > 512) continue;
      const recs = Buffer.alloc(numTables * 16);
      const got = fs.readSync(fd, recs, 0, recs.length, off + 12);
      let nameOff = -1;
      let nameLen = 0;
      for (let i = 0; i * 16 + 16 <= got; i++) {
        if (recs.toString('latin1', i * 16, i * 16 + 4) !== 'name') continue;
        nameOff = recs.readUInt32BE(i * 16 + 8);
        nameLen = recs.readUInt32BE(i * 16 + 12);
        break;
      }
      if (nameOff < 0 || nameLen <= 0 || nameLen > 2 * 1024 * 1024) continue;
      const tbl = Buffer.alloc(nameLen);
      const n = fs.readSync(fd, tbl, 0, nameLen, nameOff);
      if (n > 0) out.push(...namesFromNameTable(tbl.slice(0, n)));
    }
    return out;
  } catch (_) {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

function listInstalled(force) {
  if (!force && Date.now() - cache.at < CACHE_MS && cache.list.length) return cache.list;
  const set = new Set();
  for (const dir of fontDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!FONT_EXT.includes(path.extname(n).toLowerCase())) continue;
      for (const fam of namesOfFile(path.join(dir, n))) set.add(fam);
    }
  }
  const list = Array.from(set).filter((s) => s && s.length <= 64).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  if (list.length) cache = { at: Date.now(), list };
  return list;
}

module.exports = { listInstalled };
