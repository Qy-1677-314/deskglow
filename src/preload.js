'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();

function on(channel, cb) {
  if (!listeners.has(channel)) {
    const handler = (_e, payload) => {
      for (const fn of listeners.get(channel)) {
        try { fn(payload); } catch (err) { console.error(err); }
      }
    };
    ipcRenderer.on(channel, handler);
    listeners.set(channel, new Set());
  }
  listeners.get(channel).add(cb);
  return () => listeners.get(channel)?.delete(cb);
}

contextBridge.exposeInMainWorld('dg', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // 只在穿过玻璃条边界时用一次，把穿透开关同步设上，免得右键已经落下穿透还没生效
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  on,
  // 拖入文件时取得真实磁盘路径（Electron 32+ 移除了 File.path）
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
});
