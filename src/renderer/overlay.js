'use strict';
/* global talkie, TalkieAudio */
const $ = (id) => document.getElementById(id);
let S = null;
let hi = 0; // highlighted row in the picker
let marked = new Set(); // rows added with Space, for talking to a group
let pickerWasOpen = false;
let timer = null;
const mac = navigator.platform.toLowerCase().includes('mac');

function prettyKey(accel) {
  return (accel || '')
    .split('+')
    .map((p) => ({ CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Shift: mac ? '⇧' : 'Shift', Alt: mac ? '⌥' : 'Alt', Control: mac ? '⌃' : 'Ctrl', Enter: mac ? '↩' : 'Enter', Space: mac ? 'Space' : 'Space' }[p] || p))
    .join(mac ? '' : '+');
}
function secs(d) {
  d = Math.max(0, Math.round(d || 0));
  return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0');
}
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function kbd(t) {
  return el('kbd', '', t);
}

// ---------- picker ----------
function items() {
  return (S && S.picker && S.picker.items) || [];
}
function targets() {
  const its = items();
  if (marked.size) {
    const ids = new Set();
    for (const id of marked) {
      const it = its.find((x) => x.id === id);
      if (it) it.to.forEach((t) => ids.add(t));
    }
    return [...ids];
  }
  return its[hi] ? its[hi].to : [];
}
function sendHi() {
  talkie.send('picker-hi', targets());
}
function renderPicker() {
  const p = $('picker');
  const its = items();
  const open = !!(S && S.picker);
  if (open && !pickerWasOpen) {
    hi = Math.min(S.picker.hi || 0, Math.max(0, its.length - 1));
    marked = new Set();
  }
  pickerWasOpen = open;
  const holdTalking = S && S.talking && S.ui === 'hold';
  if (!open && !holdTalking) return p.classList.add('hidden');
  p.classList.remove('hidden');
  p.classList.toggle('talking', !!holdTalking);
  $('p-dnd').classList.toggle('hidden', !S.dnd);
  const ul = $('p-list');
  ul.replaceChildren();
  if (open) {
    its.forEach((it, i) => {
      const dot = el('i', it.id === '*' || it.id.startsWith('g:') ? 'on' : it.online ? (it.dnd ? 'dnd' : 'on') : '');
      const li = el(
        'li',
        (i === hi ? 'hi ' : '') + (marked.has(it.id) ? 'marked ' : '') + (it.blocked ? 'blocked' : ''),
        el('span', 'p-check', marked.has(it.id) ? '✓' : ''),
        el('span', 'p-av', it.id === '*' ? '★' : (it.name || '?')[0].toUpperCase(), dot),
        el('span', 'p-name', it.name),
        el('span', 'p-status', it.status),
      );
      li.addEventListener('mouseenter', () => {
        hi = i;
        if (!marked.size) sendHi();
        renderPicker();
      });
      li.addEventListener('click', () => {
        hi = i;
        talkie.send('picker-talk', targets());
      });
      ul.append(li);
    });
  }
  $('p-empty').classList.toggle('hidden', !open || its.length > 0);
  const hint = $('p-hint');
  const hk = prettyKey(S.hotkeys.talk);
  if (holdTalking) {
    ul.replaceChildren(el('li', 'hi', el('span', 'p-av', '●'), el('span', 'p-name', S.talking.to.join(', ')), el('span', 'p-status', secs((Date.now() - S.talking.started) / 1000))));
    hint.replaceChildren('Talking. Let go of the keys to send.');
  } else if (!its.length) {
    hint.replaceChildren(kbd('esc'), ' close');
  } else if (S.helper) {
    hint.replaceChildren(kbd('↑↓'), ' choose  ', kbd('space'), ' add to group  ', kbd('↩'), ' talk  ', kbd('esc'), ' close', el('br'), 'Or hold ', kbd(hk), ' to talk while held.');
  } else {
    hint.replaceChildren(kbd('↑↓'), ' choose  ', kbd('space'), ' add  ', kbd('↩'), ' or ', kbd(hk), ' talk  ', kbd('esc'), ' close');
  }
}

window.addEventListener('keydown', (e) => {
  if (!S || !S.picker || S.ui !== 'picker') return;
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const its = items();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
    e.preventDefault();
    if (!its.length) return;
    const d = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
    hi = (hi + d + its.length) % its.length;
    if (!marked.size) sendHi();
    renderPicker();
  } else if (e.key === ' ') {
    e.preventDefault();
    const it = its[hi];
    if (!it) return;
    marked.has(it.id) ? marked.delete(it.id) : marked.add(it.id);
    sendHi();
    renderPicker();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const to = targets();
    if (to.length) talkie.send('picker-talk', to);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    talkie.send('picker-close');
  } else if (/^[1-9]$/.test(e.key) && its[Number(e.key) - 1]) {
    hi = Number(e.key) - 1;
    marked = new Set();
    talkie.send('picker-talk', targets());
  }
});
window.addEventListener('keyup', (e) => {
  // without the Mac helper, this is how the hold ends
  if (S && (S.ui === 'pending' || S.ui === 'hold') && ['Meta', 'Control', 'Shift'].includes(e.key)) talkie.send('keys-up');
});

// ---------- the rest ----------
function render() {
  if (!S) return;
  renderPicker();
  const top = $('top');
  const orb = $('orb');
  const pill = $('pill');
  const holdTalking = S.talking && S.ui === 'hold';
  let show = true;
  if (S.talking && !holdTalking) {
    orb.className = 'orb talking';
    pill.className = 'pill red';
    pill.replaceChildren(el('b', '', 'Talking'), ' to ' + S.talking.to.join(', ') + '  ' + secs((Date.now() - S.talking.started) / 1000) + '  ', el('span', 'k', prettyKey(S.hotkeys.talk) + ' or click to send'));
  } else if (S.live) {
    orb.className = 'orb live';
    pill.className = 'pill';
    pill.replaceChildren(el('b', '', S.live.name), S.live.replay ? '  message' : '  talking', '  ', el('span', 'k', 'click to stop'));
  } else if (S.incomingDnd && S.incomingDnd.length) {
    orb.className = 'orb waiting';
    pill.className = 'pill';
    pill.replaceChildren(el('b', '', S.incomingDnd.join(', ')), ' is leaving you a message...');
  } else show = false;
  top.classList.toggle('hidden', !show);

  const box = $('box');
  if (S.pending && !S.live && !S.picker && !S.talking) {
    $('box-title').textContent = S.pending.name + ' wants to talk';
    const extra = S.pending.count > 1 ? '  ·  ' + (S.pending.count - 1) + ' more waiting' : '';
    $('box-sub').textContent = (S.pending.text ? '"' + S.pending.text.slice(0, 110) + (S.pending.text.length > 110 ? '..."' : '"') : 'Voice message, ' + secs(S.pending.dur)) + extra;
    box.classList.remove('hidden');
  } else box.classList.add('hidden');

  const t = $('toast');
  if (S.toast) {
    t.textContent = S.toast;
    t.classList.remove('hidden');
  } else t.classList.add('hidden');

  // the talking timer ticks only while talking
  if (S.talking && !timer) timer = setInterval(render, 500);
  if (!S.talking && timer) {
    clearInterval(timer);
    timer = null;
  }
}

// clicks pass through the empty parts of this window to the app underneath
document.querySelectorAll('.hit').forEach((e) => {
  e.addEventListener('mouseenter', () => talkie.send('overlay-interactive', true));
  e.addEventListener('mouseleave', () => talkie.send('overlay-interactive', false));
});
$('top').addEventListener('click', () => {
  if (S && S.talking) talkie.send('talk', { action: 'stop' });
  else if (S && S.live) talkie.send('stop-audio');
});
$('toast').addEventListener('click', () => talkie.send('open-main'));
$('b-play').addEventListener('click', () => S.pending && talkie.send('play', S.pending.tid));
$('b-wait').addEventListener('click', () => S.pending && talkie.send('snooze', { tid: S.pending.tid, minutes: 5 }));
$('b-later').addEventListener('click', () => S.pending && talkie.send('later', S.pending.tid));
$('b-reply').addEventListener('click', () => S.pending && talkie.send('reply-to', S.pending.tid));

talkie.onState((s) => {
  S = s;
  TalkieAudio.setMuted(!!s.test);
  render();
});

// ---------- audio engine commands ----------
talkie.onAudio(async (m) => {
  switch (m.cmd) {
    case 'sound':
      TalkieAudio.sound(m.kind);
      break;
    case 'warm':
      TalkieAudio.warm();
      break;
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
    case 'stop-all':
      TalkieAudio.stopAll();
      break;
    case 'decode-wav': {
      let value = null;
      try {
        value = await TalkieAudio.decodeToWav(m.packets);
      } catch {}
      talkie.send('audio-result', { rid: m.rid, value });
      break;
    }
  }
});

// test hook: lets the automated test read audio counters
window.__talkieStats = TalkieAudio.stats;
