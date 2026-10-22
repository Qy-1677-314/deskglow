/* 分组图标：常用预设。自定义图片由主进程转成 data URL 放在 iconSrc。 */
(function () {
  const PRESETS = [
    { id: 'work', name: '办公', a: '#3b82f6', b: '#60a5fa', svg: '<path d="M8 7.5V6.2A1.2 1.2 0 0 1 9.2 5h5.6A1.2 1.2 0 0 1 16 6.2v1.3"/><path d="M4.5 7.5h15v10.2a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M4.5 12.5h15"/>' },
    { id: 'game', name: '游戏', a: '#f97316', b: '#fb7185', svg: '<path d="M7 10.2h10a3.6 3.6 0 0 1 3.6 3.6v1.2a2.6 2.6 0 0 1-2.6 2.6h-1.1L15.2 16H8.8l-1.7 1.6H6a2.6 2.6 0 0 1-2.6-2.6v-1.2A3.6 3.6 0 0 1 7 10.2z"/><path d="M8 13.2v2.6M6.7 14.5h2.6"/><circle cx="15.2" cy="13.4" r="0.7" fill="#fff" stroke="none"/><circle cx="17" cy="15" r="0.7" fill="#fff" stroke="none"/>' },
    { id: 'study', name: '学习', a: '#10b981', b: '#34d399', svg: '<path d="M4.5 6.5h6.4A1.8 1.8 0 0 1 12.7 8.3V19a1.8 1.8 0 0 0-1.8-1.5H4.5z"/><path d="M19.5 6.5h-6.4A1.8 1.8 0 0 0 11.3 8.3V19a1.8 1.8 0 0 1 1.8-1.5h6.4z"/>' },
    { id: 'chat', name: '社交', a: '#8b5cf6', b: '#c084fc', svg: '<path d="M6 7.2h12a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H11l-3.4 2.5v-2.5H6a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z"/>' },
    { id: 'music', name: '影音', a: '#ec4899', b: '#fb7185', svg: '<path d="M9 17.2a2 2 0 1 1-1.6-2"/><path d="M16.2 15.2a2 2 0 1 1-1.6-2"/><path d="M11 15.2V6.6l7-1.5v8.2"/>' },
    { id: 'photo', name: '图片', a: '#06b6d4', b: '#67e8f9', svg: '<rect x="4.5" y="6" width="15" height="12" rx="2"/><circle cx="9" cy="10" r="1.2"/><path d="m6.8 16 3.2-3 2.2 2 2.3-2.3L17.2 16"/>' },
    { id: 'code', name: '开发', a: '#334155', b: '#64748b', svg: '<path d="m9 8-3.5 4L9 16"/><path d="m15 8 3.5 4L15 16"/>' },
    { id: 'tools', name: '工具', a: '#f59e0b', b: '#fbbf24', svg: '<path d="M14.6 6.2a3 3 0 0 0-4 3.9L5.2 15.5 8.5 18.8l5.4-5.4a3 3 0 0 0 3.9-4l-2.1 2.1-2.2-2.2z"/>' },
  ];

  function markup(svg) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;
  }

  function find(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  function tile(id) {
    const p = find(id);
    if (!p) return '';
    return `<div class="preset" style="background:linear-gradient(150deg,${p.a},${p.b})">${markup(p.svg)}</div>`;
  }

  window.DGIcons = { presets: PRESETS, tile, markup };
})();
