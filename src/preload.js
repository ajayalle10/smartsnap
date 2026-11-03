'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('smartsnap', {
  collections: {
    list: invoke('collections:list'),
    create: invoke('collections:create'),
    rename: invoke('collections:rename'),
    remove: invoke('collections:delete'),
    open: invoke('collections:open'),
  },
  images: {
    select: invoke('images:select'),
    selectAll: invoke('images:selectAll'),
    reorder: invoke('images:reorder'),
    remove: invoke('images:delete'),
    setInfo: invoke('images:setInfo'),
    updateText: invoke('images:updateText'),
    saveEdit: invoke('images:saveEdit'),
    resetEdit: invoke('images:resetEdit'),
    importFiles: invoke('images:import'),
  },
  pairing: { info: invoke('pairing:info') },
  ocr: { run: invoke('ocr:run') },
  doc: {
    build: invoke('doc:build'),
    save: invoke('doc:save'),
    copy: invoke('doc:copy'),
    exportTxt: invoke('doc:exportTxt'),
  },
  on(channel, fn) {
    const allowed = ['image-added', 'image-updated', 'ocr:status'];
    if (!allowed.includes(channel)) throw new Error(`Unknown channel ${channel}`);
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
