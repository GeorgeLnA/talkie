'use strict';
// Bridge for the overlay (picker, talking pill, message box) and the audio engine it hosts.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'play', 'snooze', 'later', 'reply-to', 'open-main', 'overlay-interactive', 'talk', 'stop-audio',
  'picker-hi', 'picker-talk', 'picker-close', 'picker-chats', 'picker-dnd', 'keys-up',
  'audio-packet', 'capture-done', 'capture-error', 'playback-done', 'audio-result',
]);

contextBridge.exposeInMainWorld('talkie', {
  send: (ch, data) => SEND.has(ch) && ipcRenderer.send(ch, data),
  onState: (fn) => ipcRenderer.on('overlay', (_e, s) => fn(s)),
  onAudio: (fn) => ipcRenderer.on('audio', (_e, m) => fn(m)),
});
