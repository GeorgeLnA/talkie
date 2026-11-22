'use strict';
// The only bridge between the page and the app. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'select', 'talk', 'dnd', 'play', 'play-next', 'snooze', 'later', 'reply-to', 'talk-to',
  'delete-message', 'trust-key', 'rename', 'pref', 'open-releases',
  'audio-packet', 'capture-done', 'capture-error', 'playback-done',
]);
const INVOKE = new Set(['setup', 'hotkeys', 'state', 'leave-team']);
const LISTEN = new Set(['state', 'audio', 'sound', 'notice']);

contextBridge.exposeInMainWorld('talkie', {
  send: (ch, data) => SEND.has(ch) && ipcRenderer.send(ch, data),
  invoke: (ch, data) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, data) : Promise.reject(new Error('denied'))),
  on: (ch, fn) => {
    if (!LISTEN.has(ch)) return;
    ipcRenderer.on(ch, (_e, data) => fn(data));
  },
});
