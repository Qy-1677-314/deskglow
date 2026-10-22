'use strict';
const { app } = require('electron');
const ps = require('./ps');

const fallback = { pinnedCount: 0, trayTotal: 0, trayPromoted: 0, backupExists: false, osBuild: 0 };

async function status() {
  const r = await ps.runJson('taskbar.ps1', ['-Action', 'status', '-DataDir', app.getPath('userData')], { timeout: 30000 });
  if (!r.ok) return { ...fallback, error: r.error };
  return { ...fallback, ...r.data };
}

async function action(name) {
  const allow = ['apply-tray', 'apply-pin', 'restore-tray', 'restore-pin', 'restart-explorer'];
  if (!allow.includes(name)) return { ok: false, error: '不被允许的操作' };
  const r = await ps.runJson('taskbar.ps1', ['-Action', name, '-DataDir', app.getPath('userData')], { timeout: 90000 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, ...r.data };
}

module.exports = { status, action };
