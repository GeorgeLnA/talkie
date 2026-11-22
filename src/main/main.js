'use strict';
const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  globalShortcut,
  screen,
  nativeImage,
  safeStorage,
  systemPreferences,
  session,
  shell,
  net,
} = require('electron');
const core = require('./core');

const DISCOVERY_URL = 'https://raw.githubusercontent.com/GeorgeLnA/talkie/relay/server.json';
const RELEASES_API = 'https://api.github.com/repos/GeorgeLnA/talkie/releases/latest';
const RELEASES_PAGE = 'https://github.com/GeorgeLnA/talkie/releases/latest';
const DEFAULT_HOTKEYS = { talk: 'CommandOrControl+Shift+Space', listen: 'CommandOrControl+Shift+Enter' };
const MAX_MESSAGES = 100;
const isMac = process.platform === 'darwin';

if (process.env.TALKIE_PROFILE) {
  // lets two copies run side by side for testing
  app.setPath('userData', path.join(app.getPath('appData'), 'Talkie-' + process.env.TALKIE_PROFILE));
}
if (process.env.TALKIE_TEST) {
  // automated test: a fake microphone (a beeping tone) and no permission prompts
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}
if (!process.env.TALKIE_PROFILE && !app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- local storage ----------
const dataDir = () => app.getPath('userData');
const file = (n) => path.join(dataDir(), n);
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

let settings;
function loadSettings() {
  settings = {
    name: '',
    code: '',
    server: '',
    lastUrl: '',
    hotkeys: { ...DEFAULT_HOTKEYS },
    selected: [],
    dnd: false,
    soundInDnd: true,
    openAtLogin: true,
    pinned: {},
    ...readJson(file('settings.json'), {}),
  };
  settings.hotkeys = { ...DEFAULT_HOTKEYS, ...(settings.hotkeys || {}) };
}
function saveSettings() {
  writeJson(file('settings.json'), settings);
}

// Private keys are encrypted with the operating system's keychain when it is available.
function loadIdentity() {
  const encPath = file('identity.enc');
  const plainPath = file('identity.json');
  try {
    if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(encPath)));
    }
    if (fs.existsSync(plainPath)) return readJson(plainPath, null);
  } catch (e) {
    console.error('identity read failed', e.message);
  }
  return null;
}
function saveIdentity(id) {
  fs.mkdirSync(dataDir(), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(file('identity.enc'), safeStorage.encryptString(JSON.stringify(id)), { mode: 0o600 });
  } else {
    writeJson(file('identity.json'), id);
  }
}

// Messages are kept exactly as they arrived: still encrypted, opened only when played.
let messages = [];
function loadMessages() {
  messages = readJson(file('messages.json'), []);
}
function saveMessages() {
  messages = messages.slice(-MAX_MESSAGES);
  writeJson(file('messages.json'), messages);
}

// ---------- app state ----------
let identity = null;
let client = null;
let mainWin = null;
let overlay = null;
let tray = null;
let connState = 'offline';
let talking = null; // { tid, to, started, pending: [] }
const live = new Map(); // tid -> message record being received
const snoozeTimers = new Map();
let updateInfo = null;

function memberName(id) {
  const m = client && client.members.get(id);
  return m ? m.name : 'Someone';
}
function memberList() {
  if (!client) return [];
  return [...client.members.values()]
    .filter((m) => m.id !== client.id)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .map((m) => ({
      id: m.id,
      name: m.name,
      online: m.online,
      dnd: m.dnd,
      keyChanged: !!m.keyChanged,
      safety: core.safetyCode(m.signPub, m.boxPub),
    }));
}
function messageList() {
  return messages
    .slice()
    .reverse()
    .map((m) => ({ tid: m.tid, from: m.from, fromName: memberName(m.from), at: m.at, dur: m.dur, heard: m.heard, group: (m.to || []).length > 1 }));
}
function pending() {
  return messages.filter((m) => !m.heard && !m.snoozedUntil);
}

function snapshot() {
  return {
    setup: !!(identity && settings.name),
    name: settings.name,
    you: client ? client.id : null,
    safety: identity ? core.safetyCode(identity.signPub, identity.boxPub) : '',
    conn: connState,
    dnd: settings.dnd,
    soundInDnd: settings.soundInDnd,
    openAtLogin: settings.openAtLogin,
    hotkeys: settings.hotkeys,
    selected: settings.selected,
    members: memberList(),
    messages: messageList(),
    talking: talking ? { to: talking.to.map(memberName), started: talking.started } : null,
    update: updateInfo,
    version: app.getVersion(),
    platform: process.platform,
  };
}

function pushState() {
  const s = snapshot();
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', s);
  pushOverlay();
  refreshTray();
}

// ---------- overlay ----------
let overlayToast = null;
let liveNow = null; // { tid, name }
function overlayState() {
  const p = pending();
  const first = p[0];
  return {
    dnd: settings.dnd,
    conn: connState,
    talking: talking ? { to: talking.to.map(memberName), started: talking.started } : null,
    live: liveNow,
    incomingDnd: [...live.values()].filter((r) => !r.playLive).map((r) => memberName(r.from)),
    pending: first
      ? { tid: first.tid, from: first.from, name: memberName(first.from), dur: first.dur, count: p.length }
      : null,
    toast: overlayToast,
    online: memberList().filter((m) => m.online).length,
    hotkeys: settings.hotkeys,
  };
}
function pushOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay', overlayState());
}
function toast(text, ms = 4000) {
  overlayToast = text;
  pushOverlay();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    overlayToast = null;
    pushOverlay();
  }, ms);
}

function placeOverlay() {
  if (!overlay) return;
  const wa = screen.getPrimaryDisplay().workArea;
  overlay.setBounds({ x: wa.x + 10, y: wa.y + 10, width: 380, height: 190 });
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 380,
    height: 190,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    type: isMac ? 'panel' : 'toolbar',
    webPreferences: securePrefs('overlay-preload.js'),
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlay.once('ready-to-show', () => {
    placeOverlay();
    overlay.showInactive();
    pushOverlay();
  });
  screen.on('display-metrics-changed', placeOverlay);
  screen.on('display-added', placeOverlay);
  screen.on('display-removed', placeOverlay);
  hardenContents(overlay.webContents);
}

// ---------- main window ----------
function securePrefs(preload) {
  return {
    preload: path.join(__dirname, preload),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    backgroundThrottling: false,
  };
}
function hardenContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\/GeorgeLnA\/talkie/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 400,
    height: 660,
    minWidth: 340,
    minHeight: 480,
    show: false,
    title: 'Talkie',
    backgroundColor: '#0f1412',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: securePrefs('preload.js'),
  });
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.webContents.on('did-finish-load', pushState);
  hardenContents(mainWin.webContents);
}
function showMain() {
  if (!mainWin) return;
  if (isMac) app.focus({ steal: true });
  mainWin.show();
  mainWin.focus();
}

// ---------- tray ----------
function trayIcon() {
  const p = path.join(__dirname, '..', '..', 'build', isMac ? 'trayTemplate.png' : 'tray.png');
  const img = nativeImage.createFromPath(p);
  if (isMac) img.setTemplateImage(true);
  return img;
}
function refreshTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open Talkie', click: showMain },
    { type: 'separator' },
    {
      label: 'Do not disturb',
      type: 'checkbox',
      checked: settings.dnd,
      click: (item) => setDnd(item.checked),
    },
    { label: talking ? 'Stop talking' : 'Talk to selected', accelerator: settings.hotkeys.talk, click: toggleTalk },
    { label: 'Play next message', accelerator: settings.hotkeys.listen, click: () => playNext(), enabled: pending().length > 0 },
    { type: 'separator' },
    updateInfo ? { label: 'Update available: ' + updateInfo.version, click: () => shell.openExternal(RELEASES_PAGE) } : { label: 'Version ' + app.getVersion(), enabled: false },
    { label: 'Quit Talkie', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Talkie' + (settings.dnd ? ' (do not disturb)' : '') + (connState !== 'online' ? ' - offline' : ''));
}

// ---------- hotkeys ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const result = {};
  for (const [action, accel] of Object.entries(settings.hotkeys)) {
    if (!accel) continue;
    try {
      result[action] = globalShortcut.register(accel, action === 'talk' ? toggleTalk : () => playNext());
    } catch {
      result[action] = false;
    }
  }
  return result;
}

// ---------- connection ----------
async function fetchJson(url) {
  const res = await net.fetch(url, { cache: 'no-store', headers: { 'user-agent': 'Talkie/' + app.getVersion() } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function discoverServer() {
  if (process.env.TALKIE_SERVER) return process.env.TALKIE_SERVER;
  if (settings.server) return settings.server;
  try {
    const j = await fetchJson(DISCOVERY_URL + '?t=' + Date.now());
    if (j && typeof j.url === 'string' && /^wss?:\/\//.test(j.url)) {
      settings.lastUrl = j.url;
      saveSettings();
      return j.url;
    }
  } catch (e) {
    console.error('discovery failed', e.message);
  }
  return settings.lastUrl || null;
}

async function connect() {
  if (client) client.close();
  client = new core.RelayClient({
    identity,
    name: settings.name,
    code: settings.code,
    pinned: settings.pinned,
    onPinned: (p) => {
      settings.pinned = p;
      saveSettings();
    },
  });
  client.dnd = settings.dnd;
  let failures = 0;
  client.on('status', async (s, detail) => {
    connState = s === 'error' ? connState : s;
    if (s === 'online') {
      failures = 0;
      if (settings.code) {
        // the team code is only needed once; forget it after joining
        settings.code = '';
        saveSettings();
      }
    }
    if (s === 'offline') {
      failures++;
      if (detail && detail.code === 4006) {
        connState = 'bad_code';
        settings.code = '';
        saveSettings();
      }
      if (detail && detail.code === 4003) connState = 'update_required';
      // the relay address may have changed: look it up again
      if (failures % 3 === 0) {
        const url = await discoverServer();
        if (url && url !== client.url) client.url = url;
      }
    }
    pushState();
  });
  client.on('server-error', (e) => {
    if (e.code === 'bad_code') connState = 'bad_code';
    sendMain('notice', e.message || e.code);
    pushState();
  });
  client.on('welcome', pushState);
  client.on('member', (m) => {
    pushState();
  });
  client.on('member-left', pushState);
  client.on('key-changed', (m) => sendMain('notice', `${m.name}'s security key changed. Check the safety code with them before talking.`));
  client.on('queued', onQueued);
  client.on('tx-start', onTxStart);
  client.on('tx-chunk', onTxChunk);
  client.on('tx-end', onTxEnd);
  client.on('tx-ack', (a) => {
    if (!talking || a.tid !== talking.tid) return;
    const dndNames = a.live.filter((id) => client.members.get(id) && client.members.get(id).dnd).map(memberName);
    const offNames = a.offline.map(memberName);
    const parts = [];
    if (dndNames.length) parts.push(dndNames.join(', ') + ' on do not disturb: saved as a message');
    if (offNames.length) parts.push(offNames.join(', ') + ' offline: delivered when back');
    if (parts.length) toast(parts.join('. '), 5000);
  });
  client.on('reply', (r) => {
    const n = memberName(r.from);
    if (r.kind === 'snooze') toast(`${n}: give me ${r.minutes} min`, 6000);
    else if (r.kind === 'heard') toast(`${n} listened to your message`, 4000);
    else if (r.kind === 'later') toast(`${n} will listen later`, 4000);
    sendMain('sound', 'notify-soft');
  });
  const url = await discoverServer();
  if (!url) {
    connState = 'no_server';
    pushState();
    setTimeout(connect, 15000);
    return;
  }
  client.connect(url);
}

function sendMain(ch, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data);
}

// ---------- receiving ----------
function onQueued(list) {
  const known = new Set(messages.map((m) => m.tid));
  const got = [];
  for (const env of list) {
    got.push(env.tid);
    if (known.has(env.tid)) continue;
    messages.push({ tid: env.tid, from: env.from, to: env.to, at: env.at, dur: env.dur, key: env.key, chunks: env.chunks, heard: false });
  }
  saveMessages();
  client.ackQueue(got);
  if (got.length) {
    sendMain('sound', 'notify');
  }
  pushState();
}

function onTxStart(t) {
  const playLive = !settings.dnd;
  const rec = { tid: t.tid, from: t.from, to: t.to, at: t.at, key: t.key, chunks: [], heard: playLive, playLive };
  live.set(t.tid, rec);
  if (playLive) {
    liveNow = { tid: t.tid, name: memberName(t.from) };
    sendMain('audio', { cmd: 'live-start', tid: t.tid });
  } else if (settings.soundInDnd) {
    sendMain('sound', 'notify');
  }
  pushState();
}
function onTxChunk(ch) {
  const rec = live.get(ch.tid);
  if (!rec) return;
  rec.chunks.push({ seq: ch.seq, n: ch.n, c: ch.c });
  if (rec.playLive) sendMain('audio', { cmd: 'live-packet', tid: ch.tid, bytes: ch.bytes });
}
function onTxEnd(e) {
  const rec = live.get(e.tid);
  if (!rec) return;
  live.delete(e.tid);
  rec.dur = e.dur;
  delete rec.playLive;
  if (rec.chunks.length) {
    messages.push(rec);
    saveMessages();
  }
  if (liveNow && liveNow.tid === e.tid) {
    liveNow = null;
    sendMain('audio', { cmd: 'live-end', tid: e.tid });
  }
  pushState();
}

function playMessage(tid) {
  const m = messages.find((x) => x.tid === tid);
  if (!m || !client) return;
  const packets = client.openEnvelope(m);
  if (!packets) {
    sendMain('notice', 'Could not open that message (the sender is no longer on the team).');
    return;
  }
  sendMain('audio', { cmd: 'play', tid, packets, name: memberName(m.from) });
  liveNow = { tid, name: memberName(m.from), replay: true };
  if (!m.heard) {
    m.heard = true;
    delete m.snoozedUntil;
    saveMessages();
    client.reply(m.from, m.tid, 'heard');
  }
  pushState();
}
function playNext() {
  const p = pending();
  if (p.length) playMessage(p[0].tid);
  else toast('No new messages', 2000);
}
function snooze(tid, minutes = 5) {
  const m = messages.find((x) => x.tid === tid);
  if (!m) return;
  m.snoozedUntil = Date.now() + minutes * 60000;
  saveMessages();
  client && client.reply(m.from, m.tid, 'snooze', minutes);
  clearTimeout(snoozeTimers.get(tid));
  snoozeTimers.set(
    tid,
    setTimeout(() => {
      delete m.snoozedUntil;
      saveMessages();
      sendMain('sound', 'notify');
      pushState();
    }, minutes * 60000),
  );
  pushState();
}
function later(tid) {
  const m = messages.find((x) => x.tid === tid);
  if (!m) return;
  // stays unheard in the list, but the box goes away
  m.snoozedUntil = Date.now() + 365 * 24 * 3600 * 1000;
  saveMessages();
  client && client.reply(m.from, m.tid, 'later');
  pushState();
}
function restoreSnoozes() {
  for (const m of messages) {
    if (!m.snoozedUntil || m.heard) continue;
    const left = m.snoozedUntil - Date.now();
    if (left > 30 * 24 * 3600 * 1000) continue; // "later": wait for the person
    if (left <= 0) delete m.snoozedUntil;
    else snoozeTimers.set(m.tid, setTimeout(() => {
      delete m.snoozedUntil;
      pushState();
    }, left));
  }
}

// ---------- talking ----------
function setDnd(on) {
  settings.dnd = !!on;
  saveSettings();
  client && client.setDnd(settings.dnd);
  pushState();
}

function startTalk(targets) {
  if (talking || !client) return;
  if (connState !== 'online') {
    toast('Not connected yet', 2500);
    return;
  }
  const to = (targets || settings.selected).filter((id) => client.members.has(id));
  if (!to.length) {
    showMain();
    sendMain('notice', 'Tick who you want to talk to first.');
    return;
  }
  const tx = client.startTx(to);
  if (!tx) return;
  talking = { tid: tx.tid, to: tx.to, started: Date.now() };
  sendMain('audio', { cmd: 'capture-start', tid: tx.tid });
  pushState();
}
function stopTalk() {
  if (!talking) return;
  sendMain('audio', { cmd: 'capture-stop', tid: talking.tid });
  // the renderer replies with capture-done once the last packet is out
  const tid = talking.tid;
  setTimeout(() => finishTalk(tid), 1500);
}
function finishTalk(tid, dur) {
  if (!talking || talking.tid !== tid) return;
  client.endTx(tid, dur || (Date.now() - talking.started) / 1000);
  talking = null;
  pushState();
}
function toggleTalk() {
  if (talking) stopTalk();
  else startTalk();
}

// ---------- updates ----------
function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
async function checkUpdate() {
  try {
    const j = await fetchJson(RELEASES_API);
    const v = String(j.tag_name || '').replace(/^v/, '');
    if (v && newer(v, app.getVersion())) {
      updateInfo = { version: v, url: RELEASES_PAGE };
      pushState();
    }
  } catch {}
}

// ---------- IPC (only from our own pages) ----------
function fromUs(e) {
  const url = e.senderFrame && e.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://');
}
function on(ch, fn) {
  ipcMain.on(ch, (e, arg) => {
    if (!fromUs(e)) return;
    try {
      fn(arg, e);
    } catch (err) {
      console.error(ch, err);
    }
  });
}
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, arg) => {
    if (!fromUs(e)) throw new Error('denied');
    return fn(arg, e);
  });
}

function setupIpc() {
  handle('setup', async ({ name, code }) => {
    name = String(name || '').trim().slice(0, 32);
    code = String(code || '').trim().slice(0, 40);
    if (!name || !code) return { ok: false, error: 'Please fill in your name and the team code.' };
    if (!identity) {
      identity = core.createIdentity();
      saveIdentity(identity);
    }
    settings.name = name;
    settings.code = code;
    saveSettings();
    if (isMac) {
      try {
        await systemPreferences.askForMediaAccess('microphone');
      } catch {}
    }
    await connect();
    return { ok: true };
  });
  on('select', (ids) => {
    if (!Array.isArray(ids)) return;
    settings.selected = ids.filter((x) => typeof x === 'string').slice(0, 50);
    saveSettings();
    pushState();
  });
  on('talk', (arg) => {
    if (arg && arg.action === 'start') startTalk(arg.to);
    else if (arg && arg.action === 'stop') stopTalk();
    else toggleTalk();
  });
  on('dnd', (onOff) => setDnd(onOff));
  on('play', (tid) => playMessage(tid));
  on('play-next', () => playNext());
  on('snooze', ({ tid, minutes }) => snooze(tid, minutes));
  on('later', (tid) => later(tid));
  on('reply-to', (tid) => {
    const m = messages.find((x) => x.tid === tid);
    if (!m) return;
    // answering straight away: the box goes, the message stays in the list
    if (!m.heard) {
      m.snoozedUntil = Date.now() + 365 * 24 * 3600 * 1000;
      saveMessages();
    }
    settings.selected = [m.from];
    saveSettings();
    startTalk([m.from]);
  });
  on('talk-to', (id) => {
    if (typeof id !== 'string') return;
    settings.selected = [id];
    saveSettings();
    startTalk([id]);
  });
  on('delete-message', (tid) => {
    messages = messages.filter((m) => m.tid !== tid);
    saveMessages();
    pushState();
  });
  on('trust-key', (id) => client && client.trustNewKey(id));
  on('rename', (name) => {
    name = String(name || '').trim().slice(0, 32);
    if (!name) return;
    settings.name = name;
    saveSettings();
    client && client.rename(name);
    pushState();
  });
  handle('hotkeys', (hk) => {
    const next = { ...settings.hotkeys };
    for (const k of ['talk', 'listen']) if (typeof hk[k] === 'string') next[k] = hk[k].slice(0, 60);
    const prev = settings.hotkeys;
    settings.hotkeys = next;
    const res = registerHotkeys();
    if (Object.values(res).some((v) => v === false)) {
      settings.hotkeys = prev;
      registerHotkeys();
      return { ok: false, error: 'That shortcut is already used by another app. Try another.' };
    }
    saveSettings();
    pushState();
    return { ok: true };
  });
  on('pref', ({ key, value }) => {
    if (key === 'soundInDnd') settings.soundInDnd = !!value;
    if (key === 'openAtLogin') {
      settings.openAtLogin = !!value;
      applyLoginItem();
    }
    saveSettings();
    pushState();
  });
  on('open-main', showMain);
  on('open-releases', () => shell.openExternal(RELEASES_PAGE));
  on('overlay-interactive', (yes) => {
    if (overlay) overlay.setIgnoreMouseEvents(!yes, { forward: true });
  });
  // audio engine -> main
  on('audio-packet', ({ tid, bytes }) => {
    if (talking && talking.tid === tid && bytes && bytes.length) client.sendPacket(tid, new Uint8Array(bytes));
  });
  on('capture-done', ({ tid, dur }) => finishTalk(tid, dur));
  on('capture-error', ({ tid, message }) => {
    if (talking && talking.tid === tid) finishTalk(tid);
    showMain();
    sendMain('notice', 'Microphone problem: ' + message + (isMac ? ' (System Settings > Privacy & Security > Microphone > turn on Talkie)' : ''));
  });
  on('playback-done', ({ tid }) => {
    if (liveNow && liveNow.tid === tid) {
      liveNow = null;
      pushState();
    }
  });
  handle('state', () => snapshot());
  handle('leave-team', () => {
    if (client) client.leave();
    for (const f of ['identity.enc', 'identity.json', 'messages.json']) {
      try {
        fs.unlinkSync(file(f));
      } catch {}
    }
    identity = null;
    messages = [];
    settings.name = '';
    settings.pinned = {};
    settings.selected = [];
    saveSettings();
    pushState();
    return { ok: true };
  });
}

function applyLoginItem() {
  if (process.env.TALKIE_PROFILE || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, openAsHidden: true });
  } catch {}
}

// ---------- automated test mode ----------
function runTestMode() {
  const log = (o) => console.log('TEST ' + JSON.stringify(o));
  if (!identity) {
    identity = core.createIdentity();
    saveIdentity(identity);
  }
  settings.name = process.env.TALKIE_TEST_NAME || 'Tester';
  settings.code = process.env.TALKIE_TEST_CODE || '';
  settings.dnd = !!process.env.TALKIE_TEST_DND;
  saveSettings();
  let talked = false;
  setInterval(async () => {
    let stats = {};
    try {
      stats = await mainWin.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.__talkieStats || {}))');
    } catch {}
    log({ conn: connState, members: memberList().map((m) => m.name + (m.online ? '+' : '-') + (m.dnd ? 'D' : '')), messages: messages.length, pending: pending().length, talking: !!talking, live: !!liveNow, stats, overlay: overlayState() });
    const target = process.env.TALKIE_TEST_TALK_TO;
    if (target && !talked && connState === 'online') {
      const m = memberList().find((x) => x.name === target && x.online);
      if (!m) return;
      talked = true;
      settings.selected = [m.id];
      log({ action: 'talk-start', to: target });
      startTalk([m.id]);
      setTimeout(() => {
        log({ action: 'talk-stop' });
        stopTalk();
      }, 3000);
    }
    if (process.env.TALKIE_TEST_PLAY && pending().length) playNext();
  }, 1000);
}

// ---------- start ----------
app.on('second-instance', showMain);
app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', showMain);

app.whenReady().then(async () => {
  // Only the microphone, only for our own pages. Everything else is refused.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = permission === 'media' && (details.requestingUrl || '').startsWith('file://');
    cb(ok);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
    return permission === 'media' && String(origin || '').startsWith('file://');
  });

  loadSettings();
  loadMessages();
  identity = loadIdentity();
  if (isMac && app.dock && settings.name) app.dock.hide();

  setupIpc();
  createMainWindow();
  createOverlay();
  tray = new Tray(trayIcon());
  tray.on('click', () => (isMac ? tray.popUpContextMenu() : showMain()));
  refreshTray();
  registerHotkeys();
  applyLoginItem();
  restoreSnoozes();

  if (process.env.TALKIE_TEST) runTestMode();
  if (identity && settings.name) {
    connect();
  } else {
    mainWin.once('ready-to-show', showMain);
  }
  checkUpdate();
  setInterval(checkUpdate, 6 * 3600 * 1000);
  setInterval(pushOverlay, 1000); // keeps the talking timer ticking
});
