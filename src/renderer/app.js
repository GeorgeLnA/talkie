'use strict';
/* global talkie */
const $ = (id) => document.getElementById(id);
let S = null;
let screen = null;
let tab = 'chats';
let openChat = null; // chat key
let chatData = null;
let expanded = null;
let recordingKey = null;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function prettyKey(accel) {
  if (!accel) return 'None';
  const mac = S && S.platform === 'darwin';
  return accel
    .split('+')
    .map((p) => ({ CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Control: mac ? '⌃' : 'Ctrl', Shift: mac ? '⇧' : 'Shift', Alt: mac ? '⌥' : 'Alt', Enter: mac ? '↩' : 'Enter' }[p] || p))
    .join(mac ? '' : '+');
}
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function secs(d) {
  d = Math.max(1, Math.round(d || 0));
  return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0');
}
function show(name) {
  screen = name;
  for (const s of ['setup', 'app', 'chat', 'settings']) $(s).classList.toggle('hidden', s !== name);
}
function notice(text) {
  const n = $('notice');
  n.textContent = text;
  n.classList.remove('hidden');
  clearTimeout(notice.t);
  notice.t = setTimeout(() => n.classList.add('hidden'), 8000);
}

// ---------- render ----------
function render() {
  if (!S) return;
  if (!S.setup) {
    if (screen !== 'settings') show('setup');
    return;
  }
  if (!screen || screen === 'setup') show('app');
  document.body.classList.toggle('mac', S.platform === 'darwin');

  $('conn-text').textContent = { online: '', connecting: 'connecting...', offline: 'offline, retrying', no_server: 'cannot find the server', bad_code: 'wrong team code', update_required: 'update needed' }[S.conn] ?? S.conn;
  $('conn-orb').className = 'orb' + (S.conn !== 'online' ? ' off' : S.dnd ? ' dnd' : '');
  $('dnd').checked = !!S.dnd;
  if (S.conn === 'bad_code') {
    show('setup');
    $('setup-name').value = S.name || '';
    $('setup-err').textContent = 'That team code was not accepted. Check the email from George and try again.';
  }
  const up = $('update');
  if (S.update) {
    up.textContent = `Talkie ${S.update.version} is ready. Click to download.`;
    up.classList.remove('hidden');
  } else up.classList.add('hidden');

  const hk = prettyKey(S.hotkeys.talk);
  $('howto').replaceChildren(
    S.members.length
      ? el('span', {}, 'From any app: hold ', el('b', {}, hk), ' and talk, let go to send. Tap ', el('b', {}, hk), ' to choose who.')
      : el('span', {}, 'Nobody else has joined yet. Once they do, press ', el('b', {}, hk), ' from any app to talk.'),
  );

  $('tab-chats').classList.toggle('on', tab === 'chats');
  $('tab-people').classList.toggle('on', tab === 'people');
  $('pane-chats').classList.toggle('hidden', tab !== 'chats');
  $('pane-people').classList.toggle('hidden', tab !== 'people');

  // chats
  const cl = $('chats');
  cl.replaceChildren();
  for (const c of S.chats) {
    cl.append(
      el(
        'li',
        { class: 'chat-row' + (c.unheard ? ' new' : ''), onclick: () => openChatView(c.key) },
        el('div', { class: 'grow' }, el('div', { class: 'name' }, c.names + (c.unheard ? '  (' + c.unheard + ' new)' : '')), el('div', { class: 'status clip' }, c.preview)),
        el('div', { class: 'when' }, ago(c.last)),
      ),
    );
  }
  $('no-chats').classList.toggle('hidden', S.chats.length > 0);

  // people
  const pl = $('people');
  pl.replaceChildren();
  for (const m of S.members) {
    const status = m.keyChanged ? 'security key changed' : !m.online ? 'offline (gets it later)' : m.dnd ? 'do not disturb (gets a message)' : 'online';
    pl.append(
      el(
        'li',
        {},
        el('span', { class: 'avatar' }, (m.name || '?')[0].toUpperCase(), el('span', { class: 'dot ' + (m.online ? (m.dnd ? 'dnd' : 'on') : '') })),
        el('div', { class: 'grow' }, el('div', { class: 'name' }, m.name), el('div', { class: m.keyChanged ? 'warn' : 'status' }, status), expanded === m.id ? el('div', { class: 'safety-line' }, 'Safety code: ' + m.safety) : null),
        m.keyChanged
          ? el('button', { class: 'mini', onclick: () => talkie.send('trust-key', m.id), title: 'Only after you have checked the safety code with them' }, 'Trust')
          : el('button', { class: 'mini', title: 'Show safety code', onclick: () => { expanded = expanded === m.id ? null : m.id; render(); } }, 'Safety code'),
      ),
    );
  }
  $('no-people').classList.toggle('hidden', S.members.length > 0);

  // settings
  if (document.activeElement !== $('set-name')) $('set-name').value = S.name;
  if (recordingKey !== 'talk') $('hk-talk').textContent = prettyKey(S.hotkeys.talk);
  if (recordingKey !== 'listen') $('hk-listen').textContent = prettyKey(S.hotkeys.listen);
  $('jump').checked = !!S.jumpBack;
  $('sound-dnd').checked = !!S.soundInDnd;
  $('login').checked = !!S.openAtLogin;
  $('my-safety').textContent = S.safety;
  $('version').textContent = 'Talkie ' + S.version;
  $('caps').textContent =
    S.platform !== 'darwin'
      ? 'Speech to text and summaries are Mac-only for now.'
      : (S.transcribe ? 'Speech to text: on, done on this Mac. ' : 'Speech to text needs macOS 26. ') +
        (S.ai === 'available' ? 'Summaries: Apple Intelligence, on this Mac.' : 'Summaries: simple. Turn on Apple Intelligence (System Settings > Apple Intelligence & Siri) for better ones.');

  if (screen === 'chat' && openChat) refreshChat();
}

// ---------- one chat ----------
async function openChatView(key) {
  openChat = key;
  chatData = null;
  show('chat');
  await refreshChat();
  summarise(false);
}
let refreshing = false;
async function refreshChat() {
  if (refreshing || !openChat) return;
  refreshing = true;
  try {
    chatData = await talkie.invoke('chat', openChat);
  } finally {
    refreshing = false;
  }
  if (!chatData) return;
  $('chat-title').textContent = chatData.names || 'Chat';
  const ul = $('chat-msgs');
  ul.replaceChildren();
  for (const m of chatData.messages.slice().reverse()) {
    ul.append(
      el(
        'li',
        { class: (m.mine ? 'mine' : '') + (m.heard ? '' : ' new') },
        el('div', { class: 'tl-head' }, el('b', {}, m.from), el('span', { class: 'muted small' }, ' ' + ago(m.at) + ' · ' + secs(m.dur)),
          m.audio ? el('button', { class: 'mini go', onclick: () => talkie.send('play', m.tid), 'aria-label': 'Play' }, '▶') : null),
        el('div', { class: 'tl-text' + (m.text ? '' : ' muted') }, m.text || (m.transcribing ? 'Turning into text...' : S && S.transcribe ? '(no words picked up)' : '(voice only)')),
      ),
    );
  }
  renderSummary();
}
function renderSummary() {
  const sum = chatData && chatData.summary;
  const ul = $('sum-lines');
  ul.replaceChildren();
  const labels = { decision: 'Decision', problem: 'Problem', solved: 'Solved', todo: 'To do', point: 'Point' };
  if (sum && sum.lines.length) for (const l of sum.lines) ul.append(el('li', { class: 'k-' + l.kind }, el('span', { class: 'tag' }, labels[l.kind] || 'Point'), ' ' + l.text));
  let note = '';
  if (!sum) note = 'Working on it...';
  else if (!sum.lines.length) note = chatData.messages.some((m) => m.text) ? 'No decisions, problems or fixes found yet.' : 'The summary appears once messages have been turned into text.';
  if (sum && sum.source === 'simple' && S && S.platform === 'darwin' && chatData.aiStatus !== 'available') note += (note ? ' ' : '') + 'Simple summary. Turn on Apple Intelligence for a better one.';
  $('sum-note').textContent = note;
}
async function summarise() {
  if (!openChat) return;
  const key = openChat;
  const r = await talkie.invoke('summarise', key);
  if (openChat === key && chatData) {
    chatData.summary = r;
    renderSummary();
  }
}

// ---------- events ----------
$('setup-go').addEventListener('click', async () => {
  const name = $('setup-name').value.trim();
  const code = $('setup-code').value.trim();
  $('setup-err').textContent = '';
  if (!name || !code) {
    $('setup-err').textContent = 'Please fill in your name and the team code.';
    return;
  }
  $('setup-go').disabled = true;
  const r = await talkie.invoke('setup', { name, code });
  $('setup-go').disabled = false;
  if (!r.ok) $('setup-err').textContent = r.error;
  else show('app');
});
$('setup-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('setup-go').click());
$('dnd').addEventListener('change', (e) => talkie.send('dnd', e.target.checked));
$('update').addEventListener('click', () => talkie.send('open-releases'));
$('gear').addEventListener('click', () => show('settings'));
$('back').addEventListener('click', () => show('app'));
$('tab-chats').addEventListener('click', () => { tab = 'chats'; render(); });
$('tab-people').addEventListener('click', () => { tab = 'people'; render(); });
$('chat-back').addEventListener('click', () => { openChat = null; show('app'); render(); });
$('sum-refresh').addEventListener('click', () => summarise());
$('chat-delete').addEventListener('click', () => {
  if (!openChat || !confirm('Delete this chat and its messages from this computer?')) return;
  talkie.send('delete-chat', openChat);
  openChat = null;
  show('app');
});
// hold to talk to this chat (or click once to start, again to send)
let holdStart = 0;
$('chat-talk').addEventListener('pointerdown', () => {
  if (S.talking) {
    talkie.send('talk', { action: 'stop' });
    holdStart = 0;
    return;
  }
  if (!chatData || !chatData.others.length) return;
  holdStart = Date.now();
  talkie.send('talk', { action: 'start', to: chatData.others, how: 'toggle' });
});
const releaseTalk = () => {
  if (holdStart && Date.now() - holdStart > 400) talkie.send('talk', { action: 'stop' });
  holdStart = 0;
};
$('chat-talk').addEventListener('pointerup', releaseTalk);
$('chat-talk').addEventListener('pointerleave', releaseTalk);

$('set-name').addEventListener('change', (e) => talkie.send('rename', e.target.value));
$('jump').addEventListener('change', (e) => talkie.send('pref', { key: 'jumpBack', value: e.target.checked }));
$('sound-dnd').addEventListener('change', (e) => talkie.send('pref', { key: 'soundInDnd', value: e.target.checked }));
$('login').addEventListener('change', (e) => talkie.send('pref', { key: 'openAtLogin', value: e.target.checked }));
$('leave').addEventListener('click', async () => {
  if (!confirm('Leave the team? Your messages and keys on this computer will be deleted.')) return;
  await talkie.invoke('leave-team');
  show('setup');
});

// shortcut recorder
function accelFrom(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push(S.platform === 'darwin' && e.ctrlKey && !e.metaKey ? 'Control' : 'CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(k)) return null;
  let key = k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k;
  if (/^Arrow/.test(key)) key = key.replace('Arrow', '');
  if (!parts.length) return null;
  parts.push(key);
  return parts.join('+');
}
for (const which of ['talk', 'listen']) {
  $('hk-' + which).addEventListener('click', () => {
    recordingKey = which;
    $('hk-' + which).textContent = 'Press keys...';
    $('hk-' + which).classList.add('rec');
  });
}
window.addEventListener('keydown', async (e) => {
  if (!recordingKey) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    $('hk-' + recordingKey).classList.remove('rec');
    recordingKey = null;
    render();
    return;
  }
  const accel = accelFrom(e);
  if (!accel) return;
  const which = recordingKey;
  recordingKey = null;
  $('hk-' + which).classList.remove('rec');
  const r = await talkie.invoke('hotkeys', { [which]: accel });
  $('hk-msg').textContent = r.ok ? 'Saved.' : r.error;
  render();
});

talkie.on('state', (s) => {
  S = s;
  render();
});
talkie.on('notice', (t) => notice(t));
talkie.invoke('state').then((s) => {
  S = s;
  render();
});
setInterval(render, 60000); // keeps "x min ago" fresh
