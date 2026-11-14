'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 渲染进程只拿到下面这组白名单方法，不直接接触 Node / Electron
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:state'),
  start: () => ipcRenderer.invoke('app:start'),
  stop: () => ipcRenderer.invoke('app:stop'),
  restart: () => ipcRenderer.invoke('app:restart'),
  reembed: () => ipcRenderer.invoke('app:reembed'),
  openLog: () => ipcRenderer.invoke('app:open-log'),
  saveSettings: (patch) => ipcRenderer.invoke('app:settings', patch),
  toggleFullscreen: () => ipcRenderer.invoke('app:fullscreen'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('app:always-on-top'),
  toggleToolbar: () => ipcRenderer.invoke('app:toolbar'),
  pickUxplay: () => ipcRenderer.invoke('app:pick-uxplay'),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  hide: () => ipcRenderer.invoke('app:hide'),
  setPanelOpen: (open) => ipcRenderer.invoke('app:panel', open),
  openUserdata: () => ipcRenderer.invoke('app:open-userdata'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.invoke('app:quit'),

  onState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
  onNotice: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('notice', listener);
    return () => ipcRenderer.removeListener('notice', listener);
  }
});
