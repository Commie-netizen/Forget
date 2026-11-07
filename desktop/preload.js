'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forgetDesktop', { version: process.versions.electron, app: 'Forget' });
contextBridge.exposeInMainWorld('forget', { pickFile: ({ kind } = {}) => ipcRenderer.invoke('forget:pick-file', kind) });
