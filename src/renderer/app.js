'use strict';
/* global TalkieAudio, talkie */
const $ = (id) => document.getElementById(id);
let S = null;
let expanded = null; // contact id showing its safety code
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

function prettyKey(accel, platform) {
  if (!accel) return 'None';
  const mac = platform === 'darwin';
  return accel
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl') return mac ? '⌘' : 'Ctrl';
      if (p === 'Command') return '⌘';
      if (p === 'Control') return mac ? '⌃' : 'Ctrl';
      if (p === 'Shift') return mac ? '⇧' : 'Shift';
      if (p === 'Alt') return mac ? '⌥' : 'Alt';
      if (p === 'Enter') return mac ? '↩' : 'Enter';
      return p;
    })
    .join(mac ? '' : '+');
}
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(ts).toLocaleDateString();
}
function secs(d) {
  d = Math.max(1, Math.round(d || 0));
  return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0');
}

function show(screen) {
  for (const s of ['setup', 'app', 'settings']) $(s).classList.toggle('hidden', s !== screen);
}

function notice(text) {
  const n = $('notice');
  n.textContent = text;
  n.classList.remove('hidden');
  clearTimeout(notice.t);
  notice.t = setTimeout(() => n.classList.add('hidden'), 7000);
}

// ---------- render ----------
function render() {
  if (!S) return;
  if (!S.setup) {
    if ($('settings').classList.contains('hidden')) show('setup');
    return;
  }
  if (!$('setup').classList.contains('hidden')) show('app');

  const connText = {
    online: '',
    connecting: 'connecting...',
    offline: 'offline, retrying',
    no_server: 'cannot find the server',
    bad_code: 'wrong team code',
    update_required: 'update needed',
  }[S.conn] || S.conn;
  $('conn-text').textContent = connText;
  $('conn-orb').className = 'orb' + (S.conn !== 'online' ? ' off' : S.dnd ? ' dnd' : '');
  $('dnd').checked = !!S.dnd;

  if (S.conn === 'bad_code') {
    show('setup');
    $('setup-name').value = S.name || '';
    $('setup-err').textContent = 'That team code was not accepted. Check the email from George and try again.';
  }

  // update banner
  const up = $('update');
  if (S.update) {
    up.textContent = `Talkie ${S.update.version} is ready. Click to download.`;
    up.classList.remove('hidden');
  } else up.classList.add('hidden');

  // contacts
  const ul = $('contacts');
  ul.replaceChildren();
  const sel = new Set(S.selected);
  for (const m of S.members) {
    const status = m.keyChanged ? 'security key changed' : !m.online ? 'offline (gets it later)' : m.dnd ? 'do not disturb (gets a message)' : 'online';
    const li = el(
      'li',
      {
        class: sel.has(m.id) ? 'sel' : '',
        onclick: (e) => {
          if (e.target.closest('button')) return;
          const next = new Set(S.selected);
          next.has(m.id) ? next.delete(m.id) : next.add(m.id);
          talkie.send('select', [...next]);
        },
      },
      el('span', { class: 'check' }, sel.has(m.id) ? '✓' : ''),
      el('span', { class: 'avatar' }, (m.name || '?')[0].toUpperCase(), el('span', { class: 'dot ' + (m.online ? (m.dnd ? 'dnd' : 'on') : '') })),
      el(
        'div',
        { class: 'who' },
        el('div', { class: 'name' }, m.name),
        el('div', { class: m.keyChanged ? 'warn' : 'status' }, status),
        expanded === m.id ? el('div', { class: 'safety-line' }, 'Safety code: ' + m.safety) : null,
      ),
      m.keyChanged
        ? el('button', { class: 'mini', onclick: () => talkie.send('trust-key', m.id), title: 'Only after you have checked the safety code with them' }, 'Trust')
        : el('button', { class: 'mini', title: 'Show safety code', onclick: () => { expanded = expanded === m.id ? null : m.id; render(); } }, 'i'),
    );
    ul.append(li);
  }
  $('no-contacts').classList.toggle('hidden', S.members.length > 0);
  $('select-all').textContent = S.members.length && S.selected.length === S.members.length ? 'Clear' : 'Select all';

  // talk button
  const t = $('talk');
  const on = !!S.talking;
  t.classList.toggle('on', on);
  t.disabled = S.conn !== 'online' || (!on && S.selected.length === 0);
  t.querySelector('.talk-label').textContent = on ? 'Release to send' : 'Hold to talk';
  const names = S.members.filter((m) => sel.has(m.id)).map((m) => m.name);
  const hk = prettyKey(S.hotkeys.talk, S.platform);
  $('talk-hint').textContent = on
    ? 'Talking to ' + S.talking.to.join(', ') + '. Press ' + hk + ' again to send.'
    : names.length
      ? 'To ' + names.join(', ') + '. Or press ' + hk + ' from any app.'
      : 'Tick someone above to talk.';

  // messages
  const ml = $('messages');
  ml.replaceChildren();
  for (const m of S.messages) {
    ml.append(
      el(
        'li',
        { class: m.heard ? '' : 'new' },
        el('button', { class: 'mini go', onclick: () => talkie.send('play', m.tid), 'aria-label': 'Play' }, '▶'),
        el('div', { class: 'meta' }, el('div', { class: 'from' }, m.fromName + (m.group ? ' (group)' : '')), el('div', { class: 'when' }, secs(m.dur) + ' · ' + ago(m.at))),
        el('button', { class: 'mini', onclick: () => talkie.send('talk-to', m.from), title: 'Talk back' }, 'Reply'),
        el('button', { class: 'x', onclick: () => talkie.send('delete-message', m.tid), 'aria-label': 'Delete' }, '×'),
      ),
    );
  }
  $('no-messages').classList.toggle('hidden', S.messages.length > 0);

  // settings
  if (document.activeElement !== $('set-name')) $('set-name').value = S.name;
  if (recordingKey !== 'talk') $('hk-talk').textContent = prettyKey(S.hotkeys.talk, S.platform);
  if (recordingKey !== 'listen') $('hk-listen').textContent = prettyKey(S.hotkeys.listen, S.platform);
  $('sound-dnd').checked = !!S.soundInDnd;
  $('login').checked = !!S.openAtLogin;
  $('my-safety').textContent = S.safety;
  $('version').textContent = 'Talkie ' + S.version;
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
  // creating the audio context here, inside a click, lets sound play later without asking
  TalkieAudio.getCtx();
  const r = await talkie.invoke('setup', { name, code });
  $('setup-go').disabled = false;
  if (!r.ok) $('setup-err').textContent = r.error;
  else show('app');
});
$('setup-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('setup-go').click());

$('dnd').addEventListener('change', (e) => talkie.send('dnd', e.target.checked));
$('select-all').addEventListener('click', () => {
  const all = S.members.map((m) => m.id);
  talkie.send('select', S.selected.length === all.length ? [] : all);
});
$('play-next').addEventListener('click', () => talkie.send('play-next'));
$('update').addEventListener('click', () => talkie.send('open-releases'));
$('gear').addEventListener('click', () => show('settings'));
$('back').addEventListener('click', () => show('app'));

// hold to talk (mouse), or click-click
let holdStart = 0;
$('talk').addEventListener('pointerdown', () => {
  TalkieAudio.getCtx();
  if (S.talking) {
    talkie.send('talk', { action: 'stop' });
    holdStart = 0;
    return;
  }
  holdStart = Date.now();
  talkie.send('talk', { action: 'start' });
});
$('talk').addEventListener('pointerup', () => {
  // a quick click keeps talking until the next click; holding sends on release
  if (holdStart && Date.now() - holdStart > 400) talkie.send('talk', { action: 'stop' });
  holdStart = 0;
});
$('talk').addEventListener('pointerleave', () => {
  if (holdStart && Date.now() - holdStart > 400) talkie.send('talk', { action: 'stop' });
  holdStart = 0;
});

$('set-name').addEventListener('change', (e) => talkie.send('rename', e.target.value));
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
  if (!parts.length) return null; // needs at least one modifier, so typing never triggers it
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

// ---------- from the main process ----------
talkie.on('state', (s) => {
  S = s;
  render();
});
talkie.on('notice', (t) => notice(t));
talkie.on('sound', (k) => TalkieAudio.sound(k));
talkie.on('audio', async (m) => {
  switch (m.cmd) {
    case 'capture-start':
      TalkieAudio.startCapture(
        m.tid,
        (bytes) => talkie.send('audio-packet', { tid: m.tid, bytes }),
        (message) => talkie.send('capture-error', { tid: m.tid, message }),
      );
      break;
    case 'capture-stop': {
      const dur = await TalkieAudio.stopCapture((bytes) => talkie.send('audio-packet', { tid: m.tid, bytes }));
      talkie.send('capture-done', { tid: m.tid, dur });
      break;
    }
    case 'live-start':
      TalkieAudio.liveStart(m.tid, (tid) => talkie.send('playback-done', { tid }));
      break;
    case 'live-packet':
      TalkieAudio.livePacket(m.tid, m.bytes);
      break;
    case 'live-end':
      TalkieAudio.liveEnd(m.tid);
      break;
    case 'play':
      TalkieAudio.play(m.tid, m.packets, (tid) => talkie.send('playback-done', { tid }));
      break;
  }
});

talkie.invoke('state').then((s) => {
  S = s;
  render();
});
setInterval(render, 30000); // keeps "x min ago" fresh

// test hook: lets the automated test read audio counters
window.__talkieStats = TalkieAudio.stats;
