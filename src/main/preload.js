'use strict';
// The only bridge between the main window and the app. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'talk', 'dnd', 'play', 'play-next', 'stop-audio', 'delete-message', 'delete-chat',
  'trust-key', 'rename', 'pref', 'open-releases',
]);
const INVOKE = new Set(['setup', 'hotkeys', 'state', 'leave-team', 'chat', 'summarise']);
const LISTEN = new Set(['state', 'notice']);

contextBridge.exposeInMainWorld('talkie', {
  send: (ch, data) => SEND.has(ch) && ipcRenderer.send(ch, data),
  invoke: (ch, data) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, data) : Promise.reject(new Error('denied'))),
  on: (ch, fn) => {
    if (!LISTEN.has(ch)) return;
    ipcRenderer.on(ch, (_e, data) => fn(data));
  },
});
