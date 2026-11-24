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
const { spawn } = require('child_process');
const core = require('./core');

const DISCOVERY_URL = 'https://raw.githubusercontent.com/GeorgeLnA/talkie/relay/server.json';
const RELEASES_API = 'https://api.github.com/repos/GeorgeLnA/talkie/releases/latest';
const RELEASES_PAGE = 'https://github.com/GeorgeLnA/talkie/releases/latest';
const DEFAULT_HOTKEYS = { talk: 'CommandOrControl+Shift+Space', listen: 'CommandOrControl+Shift+Enter' };
const MAX_AUDIO = 100; // voice kept for the last 100 messages
const MAX_HISTORY = 3000; // text kept much longer
const HOLD_MS = 260; // held longer than this = hold to talk; shorter = open the picker
const isMac = process.platform === 'darwin';
// Lighter on memory and battery: the app draws a few small windows, it needs no graphics chip.
app.disableHardwareAcceleration();

if (process.env.TALKIE_PROFILE) {
  // lets two copies run side by side for testing
  app.setPath('userData', path.join(app.getPath('appData'), 'Talkie-' + process.env.TALKIE_PROFILE));
}
if (process.env.TALKIE_TEST) {
  // automated test: a fake microphone (a beeping tone) and no permission prompts
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // the fake microphone can "say" a recorded sentence, to test speech to text
  if (process.env.TALKIE_TEST_SAY) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.TALKIE_TEST_SAY);
    app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox'); // test only: lets the fake microphone read the file
  }
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
    jumpBack: false,
    pinned: {},
    ...readJson(file('settings.json'), {}),
  };
  settings.hotkeys = { ...DEFAULT_HOTKEYS, ...(settings.hotkeys || {}) };
}
function saveSettings() {
  writeJson(file('settings.json'), settings);
}

// Private keys: on Windows they are encrypted with the system keychain (DPAPI, no prompts).
// On Mac and Linux they sit in a file only your user account can read, like SSH keys:
// the Mac keychain would ask for your password after every update of an unsigned app.
const useKeychain = () => process.platform === 'win32' && safeStorage.isEncryptionAvailable();
function loadIdentity() {
  const encPath = file('identity.enc');
  const plainPath = file('identity.json');
  try {
    if (fs.existsSync(encPath) && useKeychain()) {
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
  if (useKeychain()) {
    fs.writeFileSync(file('identity.enc'), safeStorage.encryptString(JSON.stringify(id)), { mode: 0o600 });
  } else {
    writeJson(file('identity.json'), id);
  }
}

// Messages: voice is kept exactly as it arrived, still encrypted, opened only when played.
// Our own messages are kept too, sealed to ourselves. Older ones keep only their text.
let messages = [];
let chats = {}; // chat key -> { upto, lines, source, at }
function loadMessages() {
  messages = readJson(file('messages.json'), []);
  chats = readJson(file('chats.json'), {});
}
let saveTimer = null;
function saveMessages() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMessagesNow, 300);
}
function saveMessagesNow() {
  clearTimeout(saveTimer);
  messages = messages.slice(-MAX_HISTORY);
  const cut = messages.length - MAX_AUDIO;
  messages.forEach((m, i) => {
    if (i < cut && m.chunks) {
      delete m.chunks;
      delete m.key;
    }
  });
  writeJson(file('messages.json'), messages);
}
function saveChats() {
  writeJson(file('chats.json'), chats);
}
function chatKey(m) {
  const ids = new Set([m.from, ...(m.to || [])]);
  return [...ids].sort().join(',');
}

// ---------- app state ----------
let identity = null;
let client = null;
let mainWin = null;
let overlay = null;
let tray = null;
let connState = 'offline';
let talking = null; // { tid, to, started, key, chunks, how }
let ui = 'idle'; // idle | pending (keys just pressed) | picker | hold (talking while held) | toggle (talking until next press)
let pickTargets = []; // who is highlighted in the picker
let helper = null;
let helperCaps = { transcribe: false, ai: 'unsupported' };
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
function memberName2(id) {
  return client && id === client.id ? 'You' : memberName(id);
}
function chatList() {
  const map = new Map();
  for (const m of messages) {
    const k = chatKey(m);
    const c = map.get(k) || { key: k, last: 0, count: 0, unheard: 0 };
    c.last = Math.max(c.last, m.at || 0);
    c.count++;
    if (!m.mine && !m.heard) c.unheard++;
    c.preview = m.text ? memberName2(m.from) + ': ' + m.text.slice(0, 90) : memberName2(m.from) + ' (voice)';
    map.set(k, c);
  }
  const me = client ? client.id : null;
  return [...map.values()]
    .sort((a, b) => b.last - a.last)
    .map((c) => ({ ...c, names: c.key.split(',').filter((id) => id !== me).map(memberName).join(', ') || 'You' }));
}
function chatDetail(key) {
  const list = messages.filter((m) => chatKey(m) === key);
  return {
    key,
    names: key.split(',').filter((id) => !client || id !== client.id).map(memberName).join(', '),
    others: key.split(',').filter((id) => !client || id !== client.id),
    messages: list.map((m) => ({ tid: m.tid, from: memberName2(m.from), mine: !!m.mine, at: m.at, dur: m.dur, text: m.text || '', heard: m.heard, audio: !!m.chunks, transcribing: !!m.transcribing })),
    summary: chats[key] || null,
    canSummarise: helperCaps.ai === 'available',
    aiStatus: helperCaps.ai,
  };
}
function pending() {
  return messages.filter((m) => !m.mine && !m.heard && !m.snoozedUntil);
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
    jumpBack: settings.jumpBack,
    helper: !!helper,
    transcribe: helperCaps.transcribe,
    ai: helperCaps.ai,
    members: memberList(),
    chats: chatList(),
    pendingCount: pending().length,
    talking: talking ? { to: talking.to.map(memberName), started: talking.started } : null,
    update: updateInfo,
    version: app.getVersion(),
    platform: process.platform,
  };
}

function pushState() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', snapshot());
  pushOverlay();
  refreshTray();
}

// ---------- overlay (top right, under the clock) ----------
// It is the only window that is always loaded. It also runs the audio engine.
// It shows only while something is happening: the picker, talking, a voice coming in, a waiting message.
let overlayToast = null;
let liveNow = null; // { tid, name }
const OW = 330;
const OH = 440;
function pickerItems() {
  const ms = memberList();
  const items = [];
  if (ms.length > 1) items.push({ id: '*', name: 'Everyone', to: ms.map((m) => m.id), status: '' });
  const last = (settings.selected || []).filter((id) => ms.some((m) => m.id === id));
  if (last.length > 1 && last.length < ms.length) {
    items.push({ id: 'g:' + last.join(','), name: last.map(memberName).join(' + '), to: last, status: 'last group' });
  }
  for (const m of ms) {
    items.push({ id: m.id, name: m.name, to: [m.id], status: m.keyChanged ? 'check safety code' : !m.online ? 'offline: gets it later' : m.dnd ? 'busy: gets a message' : 'online', online: m.online, dnd: m.dnd, blocked: m.keyChanged });
  }
  // highlight whoever you talked to last
  let hi = 0;
  const lastKey = last.slice().sort().join(',');
  const idx = items.findIndex((it) => it.to.slice().sort().join(',') === lastKey);
  if (idx >= 0) hi = idx;
  else if (items.length > 1 && items[0].id === '*') hi = 1;
  return { items, hi };
}
function overlayState() {
  const p = pending();
  const first = p[0];
  return {
    ui,
    mac: isMac,
    helper: !!helper,
    dnd: settings.dnd,
    conn: connState,
    picker: ui === 'picker' || ui === 'pending' ? pickerItems() : null,
    talking: talking ? { to: talking.to.map(memberName), started: talking.started, how: talking.how } : null,
    live: liveNow,
    incomingDnd: [...live.values()].filter((r) => !r.playLive).map((r) => memberName(r.from)),
    pending: first ? { tid: first.tid, from: first.from, name: memberName(first.from), dur: first.dur, count: p.length, text: first.text || '' } : null,
    toast: overlayToast,
    hotkeys: settings.hotkeys,
    test: !!process.env.TALKIE_TEST, // automated tests stay silent
  };
}
function overlayWanted(st) {
  return !!(st.picker || st.talking || st.live || st.incomingDnd.length || st.pending || st.toast);
}
function pushOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const st = overlayState();
  overlay.webContents.send('overlay', st);
  const want = overlayWanted(st);
  if (want && !overlay.isVisible()) {
    placeOverlay();
    overlay.showInactive();
  } else if (!want && overlay.isVisible()) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.hide();
  }
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
  // the screen the mouse is on, so it appears where you are looking
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  overlay.setBounds({ x: wa.x + wa.width - OW - 4, y: wa.y + 4, width: OW, height: OH });
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: OW,
    height: OH,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    alwaysOnTop: true,
    show: false,
    // On a Mac a "panel" can take the arrow keys without pulling you out of the app you are in.
    type: isMac ? 'panel' : 'toolbar',
    webPreferences: securePrefs('overlay-preload.js'),
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlay.webContents.on('did-finish-load', pushOverlay);
  overlay.on('blur', () => {
    // clicked somewhere else: close the picker, keep talking if you are
    if (ui === 'picker') closePicker();
  });
  screen.on('display-metrics-changed', placeOverlay);
  screen.on('display-removed', placeOverlay);
  hardenContents(overlay.webContents);
}
function sendAudio(cmd) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('audio', cmd);
}
function sound(kind) {
  sendAudio({ cmd: 'sound', kind });
}
// ask the audio engine for something and wait for its answer
const audioCalls = new Map();
let audioCallId = 0;
function audioCall(cmd, timeout = 20000) {
  return new Promise((resolve) => {
    const rid = ++audioCallId;
    const t = setTimeout(() => {
      audioCalls.delete(rid);
      resolve(null);
    }, timeout);
    audioCalls.set(rid, (v) => {
      clearTimeout(t);
      resolve(v);
    });
    sendAudio({ ...cmd, rid });
  });
}

// ---------- picker: choose who to talk to without leaving your app ----------
function openPicker() {
  if (!overlay) return;
  placeOverlay();
  const { items, hi } = pickerItems();
  pickTargets = items[hi] ? items[hi].to : [];
  if (!overlay.isVisible()) overlay.showInactive();
  overlay.setIgnoreMouseEvents(false);
  overlay.focus(); // the panel takes the arrow keys; your app stays in front
}
function closePicker() {
  if (ui === 'picker' || ui === 'pending') ui = talking ? ui : 'idle';
  if (helper) helperSend({ cmd: 'stop-hold' });
  if (overlay && !overlay.isDestroyed()) {
    overlay.blur();
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }
  pushOverlay();
}
function onTalkKey() {
  if (!identity || !settings.name) return showMain();
  if (talking) {
    // second press while talking sends it
    stopTalk();
    return;
  }
  if (ui === 'pending' || ui === 'hold') return; // key repeat
  const wasPicker = ui === 'picker';
  ui = 'pending';
  if (!wasPicker) openPicker();
  sendAudio({ cmd: 'warm' }); // open the microphone early so the first word is not lost
  pushOverlay();
  const press = Date.now();
  if (helper) {
    helperSend({ cmd: 'watch-hold', id: press });
    setTimeout(() => {
      if (ui !== 'pending') return;
      helperCall({ cmd: 'mods' }, 400).then((m) => {
        if (ui !== 'pending') return;
        if (m && m.cmd && m.shift) beginHold();
        else toPicker();
      });
    }, HOLD_MS);
  } else {
    // no helper (Windows, Linux): a press opens the picker; a second press talks to the highlighted person
    if (wasPicker) beginToggle(pickTargets);
    else toPicker();
  }
}
function toPicker() {
  ui = 'picker';
  pushOverlay();
}
function onHoldReleased() {
  if (ui === 'pending') toPicker();
  else if (ui === 'hold') stopTalk();
}
function beginHold() {
  const to = pickTargets.filter((id) => client && client.members.has(id));
  if (!to.length) return toPicker();
  if (!startTalk(to, 'hold')) return toPicker();
  ui = 'hold';
  pushOverlay();
}
function beginToggle(to) {
  to = (to || []).filter((id) => client && client.members.has(id));
  if (!to.length) return toPicker();
  if (!startTalk(to, 'toggle')) return;
  ui = 'toggle';
  // give the keyboard back to your app while you talk
  if (overlay) {
    overlay.blur();
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }
  pushOverlay();
}

// ---------- the Mac helper ----------
const helperCalls = new Map();
let helperId = 0;
function helperPath() {
  if (!isMac) return null;
  const p = app.isPackaged ? path.join(process.resourcesPath, 'talkie-helper') : path.join(__dirname, '..', '..', 'build', 'helper', 'talkie-helper');
  return fs.existsSync(p) ? p : null;
}
function startHelper() {
  const p = helperPath();
  if (!p) return;
  const child = spawn(p, ['com.leadandallure.talkie'], { stdio: ['pipe', 'pipe', 'ignore'] });
  helper = child;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onHelper(msg);
    }
  });
  child.on('exit', () => {
    if (helper === child) helper = null;
    if (!app.isQuitting) setTimeout(startHelper, 3000);
  });
  child.on('error', () => {});
}
function helperSend(obj) {
  if (helper && helper.stdin.writable) helper.stdin.write(JSON.stringify(obj) + '\n');
}
function helperCall(obj, timeout = 60000) {
  return new Promise((resolve) => {
    if (!helper) return resolve(null);
    const id = 'c' + ++helperId;
    const t = setTimeout(() => {
      helperCalls.delete(id);
      resolve(null);
    }, timeout);
    helperCalls.set(id, (v) => {
      clearTimeout(t);
      resolve(v);
    });
    helperSend({ ...obj, id });
  });
}
function onHelper(msg) {
  if (msg.ev === 'ready') {
    helperCaps = { transcribe: !!msg.transcribe, ai: msg.ai || 'unsupported' };
    helperSend({ cmd: 'jumpback', on: !!settings.jumpBack });
    pushState();
    // transcribe anything that arrived before the helper was ready
    for (const m of messages) if (m.chunks && m.text === undefined) queueTranscribe(m.tid);
    return;
  }
  if (msg.ev === 'hold-released') return onHoldReleased();
  if (msg.ev === 'jumped') return;
  const cb = msg.id != null && helperCalls.get(msg.id);
  if (cb) {
    helperCalls.delete(msg.id);
    cb(msg);
  }
}

// ---------- voice to text, on this computer ----------
const tq = [];
let tBusy = false;
function queueTranscribe(tid) {
  if (!helperCaps.transcribe || tq.includes(tid)) return;
  tq.push(tid);
  pumpTranscribe();
}
async function pumpTranscribe() {
  if (tBusy || !client) return;
  const tid = tq.shift();
  if (!tid) return;
  tBusy = true;
  const m = messages.find((x) => x.tid === tid);
  const wav = path.join(app.getPath('temp'), 'talkie-' + process.pid + '-' + tid + '.wav');
  try {
    const packets = m && m.chunks ? client.openEnvelope(m) : null;
    if (packets && packets.length) {
      m.transcribing = true;
      pushState();
      const bytes = await audioCall({ cmd: 'decode-wav', packets });
      if (bytes && bytes.length > 44) {
        fs.writeFileSync(wav, Buffer.from(bytes), { mode: 0o600 });
        if (process.env.TALKIE_TEST_KEEPWAV) fs.copyFileSync(wav, process.env.TALKIE_TEST_KEEPWAV + '-' + settings.name + '.wav');
        const r = await helperCall({ cmd: 'transcribe', path: wav, locale: app.getSystemLocale ? app.getSystemLocale() : app.getLocale() });
        m.text = r && typeof r.text === 'string' ? r.text : '';
      } else m.text = '';
      delete m.transcribing;
      saveMessages();
      pushState();
    }
  } catch (e) {
    console.error('transcribe', e.message);
    if (m) delete m.transcribing;
  } finally {
    try {
      fs.unlinkSync(wav);
    } catch {}
    tBusy = false;
    setImmediate(pumpTranscribe);
  }
}

// ---------- chat summaries ----------
const LABELS = { decision: 'Decision', problem: 'Problem', solved: 'Solved', todo: 'To do', point: 'Point' };
function simpleSummary(list) {
  // used when Apple's on-device model is not switched on: picks out the sentences that matter
  const rules = [
    ['decision', /\b(decided|decide|agreed|agree|let's|we'll|we will|going to|go with|settled on|the plan is)\b/i],
    ['solved', /\b(fixed|solved|sorted|resolved|works now|working now|the fix|workaround)\b/i],
    ['problem', /\b(problem|issue|bug|broken|error|stuck|can't|cannot|doesn't work|not working|failing|failed)\b/i],
    ['todo', /\b(need to|needs to|have to|i'll|i will|to do|follow up|tomorrow|by (monday|tuesday|wednesday|thursday|friday|tonight))\b/i],
  ];
  const lines = [];
  const seen = new Set();
  for (const m of list.slice().reverse()) {
    if (!m.text) continue;
    for (const sentence of m.text.split(/(?<=[.!?])\s+/)) {
      const r = rules.find(([, re]) => re.test(sentence));
      if (!r) continue;
      const t = sentence.trim().replace(/\s+/g, ' ').slice(0, 160);
      if (t.split(' ').length < 5 || seen.has(t.toLowerCase())) continue; // skip fragments and repeats
      seen.add(t.toLowerCase());
      lines.push({ kind: r[0], text: memberName2(m.from) + ': ' + t });
    }
    if (lines.length >= 10) break;
  }
  const order = ['decision', 'problem', 'solved', 'todo'];
  return lines.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 8);
}
function parseSummary(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^[\s\-*•\d.]+/, '').trim();
    const m = line.match(/^(Decision|Problem|Solved|To do|Point)\s*:\s*(.+)$/i);
    if (!m) continue;
    const kind = Object.keys(LABELS).find((k) => LABELS[k].toLowerCase() === m[1].toLowerCase()) || 'point';
    out.push({ kind, text: m[2].trim().slice(0, 200) });
  }
  return out.slice(0, 8);
}
async function summarise(key) {
  const list = messages.filter((m) => chatKey(m) === key);
  const withText = list.filter((m) => m.text);
  const prev = chats[key];
  if (prev && prev.upto === withText.length && (prev.source === 'apple' || helperCaps.ai !== 'available')) return prev;
  let res = null;
  if (withText.length && helperCaps.ai === 'available') {
    const transcript = withText.map((m) => memberName2(m.from) + ': ' + m.text).join('\n');
    const r = await helperCall({ cmd: 'summarize', text: transcript }, 90000);
    if (r && r.text) res = { lines: parseSummary(r.text), source: 'apple' };
  }
  if (!res) res = { lines: simpleSummary(withText), source: 'simple' };
  chats[key] = { ...res, upto: withText.length, at: Date.now() };
  saveChats();
  return chats[key];
}

// ---------- main window (chats, people, settings) ----------
// Made only when you open it, and closed for real when you close it, so it costs nothing in between.
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
    width: 420,
    height: 680,
    minWidth: 340,
    minHeight: 480,
    show: false,
    title: 'Talkie',
    backgroundColor: '#0f1412',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: { ...securePrefs('preload.js'), backgroundThrottling: true },
  });
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (isMac) app.focus({ steal: true });
    mainWin.show();
    mainWin.focus();
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (isMac && app.dock && settings.name) app.dock.hide();
  });
  mainWin.webContents.on('did-finish-load', pushState);
  hardenContents(mainWin.webContents);
}
function showMain() {
  if (isMac && app.dock) app.dock.show(); // while the window is open you can Cmd+Tab to it
  if (!mainWin || mainWin.isDestroyed()) return createMainWindow();
  if (isMac) app.focus({ steal: true });
  mainWin.show();
  mainWin.focus();
}

// ---------- tray (menu bar icon) ----------
function trayIcon() {
  const p = path.join(__dirname, '..', '..', 'build', isMac ? 'trayTemplate.png' : 'tray.png');
  const img = nativeImage.createFromPath(p);
  if (isMac) img.setTemplateImage(true);
  return img;
}
function refreshTray() {
  if (!tray) return;
  const sig = JSON.stringify([settings.dnd, !!talking, pending().length, !!updateInfo, connState, settings.jumpBack, settings.hotkeys]);
  if (sig === refreshTray.sig) return;
  refreshTray.sig = sig;
  const menu = Menu.buildFromTemplate([
    { label: 'Open Talkie (chats and settings)', click: showMain },
    { type: 'separator' },
    { label: talking ? 'Send' : 'Talk...', accelerator: settings.hotkeys.talk, click: onTalkKey },
    { label: 'Play next message', accelerator: settings.hotkeys.listen, click: () => playNext(), enabled: pending().length > 0 },
    {
      label: 'Do not disturb',
      type: 'checkbox',
      checked: settings.dnd,
      click: (item) => setDnd(item.checked),
    },
    { type: 'separator' },
    updateInfo ? { label: 'Update available: ' + updateInfo.version, click: () => shell.openExternal(RELEASES_PAGE) } : { label: 'Version ' + app.getVersion() + (connState === 'online' ? '' : ' (offline)'), enabled: false },
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
      result[action] = globalShortcut.register(accel, action === 'talk' ? onTalkKey : () => playNext());
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
    sound('notify-soft');
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
  else if (ch === 'notice') toast(data, 7000);
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
  if (got.length) sound('notify');
  for (const tid of got) queueTranscribe(tid);
  pushState();
}

function onTxStart(t) {
  const playLive = !settings.dnd;
  const rec = { tid: t.tid, from: t.from, to: t.to, at: t.at, key: t.key, chunks: [], heard: playLive, playLive };
  live.set(t.tid, rec);
  if (playLive) {
    liveNow = { tid: t.tid, name: memberName(t.from) };
    sendAudio({ cmd: 'live-start', tid: t.tid });
  } else if (settings.soundInDnd) {
    sound('notify');
  }
  pushState();
}
function onTxChunk(ch) {
  const rec = live.get(ch.tid);
  if (!rec) return;
  rec.chunks.push({ seq: ch.seq, n: ch.n, c: ch.c });
  if (rec.playLive) sendAudio({ cmd: 'live-packet', tid: ch.tid, bytes: ch.bytes });
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
    queueTranscribe(rec.tid);
  }
  if (liveNow && liveNow.tid === e.tid) {
    sendAudio({ cmd: 'live-end', tid: e.tid });
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
  sendAudio({ cmd: 'play', tid, packets, name: memberName(m.from) });
  liveNow = { tid, name: memberName(m.from), replay: true };
  if (!m.heard && !m.mine) {
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
      sound('notify');
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

function startTalk(targets, how = 'toggle') {
  if (talking || !client) return false;
  if (connState !== 'online') {
    toast('Not connected yet. Check your internet.', 3000);
    return false;
  }
  const to = (targets || []).filter((id) => client.members.has(id));
  if (!to.length) return false;
  const tx = client.startTx(to);
  if (!tx) return false;
  talking = { tid: tx.tid, to: tx.to, started: Date.now(), key: tx.key, chunks: [], how };
  settings.selected = tx.to;
  saveSettings();
  sendAudio({ cmd: 'capture-start', tid: tx.tid });
  pushState();
  return true;
}
function stopTalk() {
  if (!talking || talking.stopping) return;
  talking.stopping = true;
  sendAudio({ cmd: 'capture-stop', tid: talking.tid });
  // the audio engine answers with capture-done once the last packet is out
  const tid = talking.tid;
  setTimeout(() => finishTalk(tid), 1500);
  if (ui === 'hold' || ui === 'toggle' || ui === 'pending') closePicker();
}
function finishTalk(tid, dur) {
  if (!talking || talking.tid !== tid) return;
  const t = talking;
  const d = dur || (Date.now() - t.started) / 1000;
  client.endTx(tid, d);
  talking = null;
  ui = 'idle';
  if (t.chunks.length) {
    // keep our own copy, sealed to ourselves, for the chat history
    messages.push({ tid, from: client.id, to: t.to, at: t.started, dur: d, key: client.sealForSelf(t.key), chunks: t.chunks, heard: true, mine: true });
    saveMessages();
    queueTranscribe(tid);
  }
  closePicker();
  pushState();
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
  // picker (overlay) -> main
  on('picker-hi', (to) => {
    if (Array.isArray(to)) pickTargets = to.filter((x) => typeof x === 'string').slice(0, 50);
  });
  on('picker-talk', (to) => {
    if (!Array.isArray(to)) return;
    if (talking) return stopTalk();
    beginToggle(to.filter((x) => typeof x === 'string').slice(0, 50));
  });
  on('picker-close', () => closePicker());
  on('keys-up', () => {
    // fallback for the hold when there is no helper: the overlay saw the keys go up
    if (!helper) onHoldReleased();
  });
  on('talk', (arg) => {
    if (arg && arg.action === 'start' && Array.isArray(arg.to)) startTalk(arg.to, arg.how === 'hold' ? 'hold' : 'toggle');
    else if (arg && arg.action === 'stop') stopTalk();
    else if (talking) stopTalk();
  });
  on('dnd', (onOff) => setDnd(onOff));
  on('play', (tid) => playMessage(tid));
  on('play-next', () => playNext());
  on('stop-audio', () => {
    sendAudio({ cmd: 'stop-all' });
    liveNow = null;
    pushState();
  });
  on('snooze', ({ tid, minutes }) => snooze(tid, minutes));
  on('later', (tid) => later(tid));
  on('reply-to', (tid) => {
    const m = messages.find((x) => x.tid === tid);
    if (!m) return;
    // answering straight away: the box goes, the message stays in the chat
    if (!m.heard) {
      m.heard = true;
      delete m.snoozedUntil;
      saveMessages();
      client && client.reply(m.from, m.tid, 'heard');
    }
    beginToggle([m.from]);
  });
  on('delete-message', (tid) => {
    messages = messages.filter((m) => m.tid !== tid);
    saveMessages();
    pushState();
  });
  on('delete-chat', (key) => {
    messages = messages.filter((m) => chatKey(m) !== key);
    delete chats[key];
    saveMessages();
    saveChats();
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
    if (key === 'jumpBack') {
      settings.jumpBack = !!value;
      helperSend({ cmd: 'jumpback', on: settings.jumpBack });
    }
    saveSettings();
    pushState();
  });
  on('open-main', showMain);
  on('open-releases', () => shell.openExternal(RELEASES_PAGE));
  on('overlay-interactive', (yes) => {
    if (!overlay) return;
    if (ui === 'picker' || ui === 'pending') return; // the picker keeps the mouse
    overlay.setIgnoreMouseEvents(!yes, { forward: true });
  });
  // audio engine -> main
  on('audio-packet', ({ tid, bytes }) => {
    if (!talking || talking.tid !== tid || !bytes || !bytes.length) return;
    const ch = client.sendPacket(tid, new Uint8Array(bytes));
    if (ch) talking.chunks.push(ch);
  });
  on('capture-done', ({ tid, dur }) => finishTalk(tid, dur));
  on('capture-error', ({ tid, message }) => {
    if (talking && talking.tid === tid) finishTalk(tid);
    toast('Microphone problem: ' + message + (isMac ? '. Open System Settings > Privacy & Security > Microphone and turn on Talkie.' : ''), 9000);
  });
  on('playback-done', ({ tid }) => {
    if (liveNow && liveNow.tid === tid) {
      liveNow = null;
      pushState();
    }
  });
  on('audio-result', ({ rid, value }) => {
    const cb = audioCalls.get(rid);
    if (cb) {
      audioCalls.delete(rid);
      cb(value);
    }
  });
  handle('state', () => snapshot());
  handle('chat', (key) => (typeof key === 'string' ? chatDetail(key) : null));
  handle('summarise', async (key) => (typeof key === 'string' ? summarise(key) : null));
  handle('leave-team', () => {
    if (client) client.leave();
    for (const f of ['identity.enc', 'identity.json', 'messages.json', 'chats.json']) {
      try {
        fs.unlinkSync(file(f));
      } catch {}
    }
    identity = null;
    messages = [];
    chats = {};
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
      stats = await overlay.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.__talkieStats || {}))');
    } catch {}
    log({ conn: connState, ui, members: memberList().map((m) => m.name + (m.online ? '+' : '-') + (m.dnd ? 'D' : '')), messages: messages.length, texts: messages.map((m) => (m.mine ? 'me:' : '') + (m.text === undefined ? '?' : m.text)), pending: pending().length, talking: !!talking, live: !!liveNow, overlayVisible: overlay.isVisible(), helper: helperCaps, stats });
    const target = process.env.TALKIE_TEST_TALK_TO;
    if (target && !talked && connState === 'online') {
      const m = memberList().find((x) => x.name === target && x.online);
      if (!m) return;
      talked = true;
      log({ action: 'talk-start', to: target });
      beginToggle([m.id]);
      setTimeout(() => {
        log({ action: 'talk-stop' });
        stopTalk();
      }, Number(process.env.TALKIE_TEST_SECS || 3) * 1000);
    }
    if (process.env.TALKIE_TEST_PLAY && pending().length) playNext();
    if (process.env.TALKIE_TEST_PICKER && !runTestMode.picked && connState === 'online') {
      runTestMode.picked = true;
      const front = async () => ((await helperCall({ cmd: 'front' }, 2000)) || {}).app;
      log({ action: 'picker-open', frontBefore: await front() });
      onTalkKey();
      setTimeout(async () => log({ action: 'picker-shown', ui, visible: overlay.isVisible(), focused: overlay.isFocused(), bounds: overlay.getBounds(), frontDuring: await front() }), 1200);
      setTimeout(async () => {
        if (!process.env.TALKIE_TEST_KEEP) closePicker();
        setTimeout(async () => log({ action: 'picker-closed', ui, visible: overlay.isVisible(), frontAfter: await front() }), 500);
      }, 2500);
    }
    if (process.env.TALKIE_TEST_SUMMARY && !runTestMode.summed && messages.some((m) => m.text)) {
      runTestMode.summed = true;
      const key = chatKey(messages.find((m) => m.text));
      log({ action: 'summary', result: await summarise(key) });
    }
  }, 1000);
}

// ---------- start ----------
app.on('second-instance', showMain);
app.on('before-quit', () => {
  app.isQuitting = true;
  saveMessagesNow();
  if (helper) helper.kill();
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
  createOverlay();
  startHelper();
  tray = new Tray(trayIcon());
  tray.on('click', () => (isMac ? tray.popUpContextMenu() : showMain()));
  refreshTray();
  registerHotkeys();
  applyLoginItem();
  restoreSnoozes();

  if (process.env.TALKIE_TEST) runTestMode();
  if (process.env.TALKIE_TEST_MAIN) {
    showMain();
    mainWin.webContents.once('did-finish-load', () => setTimeout(() => mainWin.webContents.executeJavaScript("document.querySelector('.chat-row') && document.querySelector('.chat-row').click()"), 2500));
  }
  if (identity && settings.name) connect();
  else showMain();
  checkUpdate();
  setInterval(checkUpdate, 6 * 3600 * 1000);
});
