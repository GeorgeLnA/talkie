'use strict';
/* global talkie */
const $ = (id) => document.getElementById(id);
let S = null;
let hover = false;

function prettyKey(accel) {
  const mac = navigator.platform.toLowerCase().includes('mac');
  return (accel || '')
    .split('+')
    .map((p) => ({ CommandOrControl: mac ? '⌘' : 'Ctrl', Shift: mac ? '⇧' : 'Shift', Alt: mac ? '⌥' : 'Alt', Control: mac ? '⌃' : 'Ctrl', Enter: mac ? '↩' : 'Enter' }[p] || p))
    .join(mac ? '' : '+');
}
function secs(d) {
  d = Math.max(0, Math.round(d || 0));
  return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0');
}
function pill(html, cls = '') {
  const p = $('pill');
  if (!html) return p.classList.add('hidden');
  p.className = 'pill ' + cls;
  p.replaceChildren(...html);
}
function b(t) {
  const e = document.createElement('b');
  e.textContent = t;
  return e;
}
function txt(t) {
  return document.createTextNode(t);
}

function render() {
  if (!S) return;
  const orb = $('orb');
  let cls = 'orb';
  if (S.conn !== 'online') cls += ' off';
  else if (S.dnd) cls += ' dnd';
  if (S.talking) cls += ' talking';
  else if (S.live) cls += ' live';
  else if (S.pending) cls += ' waiting';
  orb.className = cls;

  if (S.talking) {
    const t = (Date.now() - S.talking.started) / 1000;
    pill([b('Talking'), txt(' to ' + S.talking.to.join(', ') + '  ' + secs(t) + '  ·  ' + prettyKey(S.hotkeys.talk) + ' to send')], 'red');
  } else if (S.live) {
    pill([b(S.live.name), txt(S.live.replay ? '  (message)' : '  talking')]);
  } else if (S.incomingDnd && S.incomingDnd.length) {
    pill([b(S.incomingDnd.join(', ')), txt(' is leaving you a message...')]);
  } else if (hover) {
    const status = S.conn !== 'online' ? 'offline' : S.online + ' online' + (S.dnd ? '  ·  do not disturb' : '');
    pill([b('Talkie'), txt('  ' + status + '  ·  ' + prettyKey(S.hotkeys.talk) + ' to talk')]);
  } else pill(null);

  const box = $('box');
  if (S.pending && !S.live) {
    $('box-title').textContent = S.pending.name + ' wants to talk';
    $('box-sub').textContent = 'Voice message, ' + secs(S.pending.dur) + (S.pending.count > 1 ? '  ·  ' + (S.pending.count - 1) + ' more waiting' : '');
    box.classList.remove('hidden');
  } else box.classList.add('hidden');

  const t = $('toast');
  if (S.toast) {
    t.textContent = S.toast;
    t.classList.remove('hidden');
  } else t.classList.add('hidden');
}

// let clicks through except over the orb, pill and box
document.querySelectorAll('.hit').forEach((e) => {
  e.addEventListener('mouseenter', () => {
    hover = true;
    talkie.send('overlay-interactive', true);
    render();
  });
  e.addEventListener('mouseleave', () => {
    hover = false;
    talkie.send('overlay-interactive', false);
    render();
  });
});
$('top').addEventListener('click', () => (S && S.talking ? talkie.send('talk', { action: 'stop' }) : talkie.send('open-main')));
$('b-play').addEventListener('click', () => S.pending && talkie.send('play', S.pending.tid));
$('b-wait').addEventListener('click', () => S.pending && talkie.send('snooze', { tid: S.pending.tid, minutes: 5 }));
$('b-later').addEventListener('click', () => S.pending && talkie.send('later', S.pending.tid));
$('b-reply').addEventListener('click', () => {
  if (!S.pending) return;
  talkie.send('reply-to', S.pending.tid);
});
talkie.onState((s) => {
  S = s;
  render();
});
