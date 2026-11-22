'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set(['play', 'snooze', 'later', 'reply-to', 'open-main', 'overlay-interactive', 'talk']);

contextBridge.exposeInMainWorld('talkie', {
  send: (ch, data) => SEND.has(ch) && ipcRenderer.send(ch, data),
  onState: (fn) => ipcRenderer.on('overlay', (_e, s) => fn(s)),
});
