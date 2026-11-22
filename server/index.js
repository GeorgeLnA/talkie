'use strict';
/*
 * Talkie relay server.
 *
 * The relay only forwards sealed envelopes. Voice is encrypted on the sender's
 * device with a fresh key per transmission, and that key is sealed separately
 * to each recipient's public key, so the relay (and anyone who breaks into it)
 * cannot listen. The relay knows: who is on the team, who is online, who is
 * talking to whom and when, and the size of each message.
 *
 * Joining needs the team code. After joining, a device proves who it is by
 * signing a fresh random challenge with its private key on every connection.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const nacl = require('tweetnacl');

const PORT = parseInt(process.env.TALKIE_PORT || '8787', 10);
const HOST = process.env.TALKIE_HOST || '127.0.0.1';
const DATA = process.env.TALKIE_DATA || path.join(__dirname, 'data');
const PROTOCOL = 1;

const LIMITS = {
  maxPayload: 64 * 1024, // one websocket message
  maxChunkB64: 24 * 1024, // one encrypted audio packet
  maxTxSeconds: 180, // one transmission
  maxTxChunks: 2400, // 100 ms packets
  maxQueuePerUser: 60,
  queueTtlMs: 7 * 24 * 3600 * 1000,
  maxNameLen: 32,
  maxMembers: 200,
  authFailWindowMs: 10 * 60 * 1000,
  authFailMax: 8,
  msgPerSecond: 60,
};

fs.mkdirSync(path.join(DATA, 'queue'), { recursive: true, mode: 0o700 });

// ---------- storage ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const CONFIG_FILE = path.join(DATA, 'config.json');
const MEMBERS_FILE = path.join(DATA, 'members.json');

function loadConfig() {
  let cfg = readJson(CONFIG_FILE, null);
  const envCode = process.env.TALKIE_TEAM_CODE;
  if (envCode) {
    cfg = { ...hashCode(envCode), createdAt: Date.now() };
    writeJson(CONFIG_FILE, cfg);
  }
  if (!cfg) {
    const code = newTeamCode();
    cfg = { ...hashCode(code), createdAt: Date.now() };
    writeJson(CONFIG_FILE, cfg);
    console.log('\n  New team code (shown once, share it only with your team): ' + code + '\n');
  }
  return cfg;
}
function newTeamCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return 'TK-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
function normaliseCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashCode(code, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(normaliseCode(code), salt, 32).toString('hex');
  return { salt, hash };
}
function checkCode(code) {
  const { hash } = hashCode(code, config.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(config.hash, 'hex'));
}

const config = loadConfig();
let members = readJson(MEMBERS_FILE, {}); // id -> { id, name, signPub, boxPub, joinedAt }
function saveMembers() {
  writeJson(MEMBERS_FILE, members);
}

function queueFile(id) {
  return path.join(DATA, 'queue', id + '.json');
}
function loadQueue(id) {
  const now = Date.now();
  return readJson(queueFile(id), []).filter((m) => now - m.at < LIMITS.queueTtlMs);
}
function saveQueue(id, q) {
  if (q.length === 0) {
    try {
      fs.unlinkSync(queueFile(id));
    } catch {}
    return;
  }
  writeJson(queueFile(id), q.slice(-LIMITS.maxQueuePerUser));
}

// ---------- helpers ----------
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
function b64(s, maxLen) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && B64.test(s);
}
function fromB64(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
function idFor(signPub) {
  return crypto.createHash('sha256').update(fromB64(signPub)).digest('hex').slice(0, 20);
}
function cleanName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, LIMITS.maxNameLen);
}
const TID = /^[A-Za-z0-9_-]{8,40}$/;

// ---------- state ----------
const online = new Map(); // id -> Set<ws>
const dnd = new Map(); // id -> bool
const txs = new Map(); // tid -> { from, to:Set, offline:Set, envelopes: Map<id, env>, chunks, started }
const authFails = new Map(); // ip -> [timestamps]

function publicMember(m) {
  return {
    id: m.id,
    name: m.name,
    signPub: m.signPub,
    boxPub: m.boxPub,
    boxSig: m.boxSig,
    online: online.has(m.id),
    dnd: !!dnd.get(m.id),
  };
}
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendTo(id, obj) {
  const set = online.get(id);
  if (!set) return false;
  for (const ws of set) send(ws, obj);
  return true;
}
function broadcast(obj, exceptId) {
  for (const [id, set] of online) {
    if (id === exceptId) continue;
    for (const ws of set) send(ws, obj);
  }
}
function presence(id) {
  const m = members[id];
  if (m) broadcast({ t: 'member', member: publicMember(m) }, id);
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  // Only trust forwarding headers when the connection comes from the local tunnel.
  if (local) return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || remote;
  return remote;
}
function tooManyFails(ip) {
  const now = Date.now();
  const list = (authFails.get(ip) || []).filter((t) => now - t < LIMITS.authFailWindowMs);
  authFails.set(ip, list);
  return list.length >= LIMITS.authFailMax;
}
function recordFail(ip) {
  const list = authFails.get(ip) || [];
  list.push(Date.now());
  authFails.set(ip, list);
}

// ---------- http + websocket ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, app: 'talkie', protocol: PROTOCOL }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Talkie relay. Download the app at https://github.com/GeorgeLnA/talkie\n');
});

const wss = new WebSocketServer({ server, maxPayload: LIMITS.maxPayload, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const state = { id: null, nonce: null, signPub: null, bucket: LIMITS.msgPerSecond, last: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  const authTimer = setTimeout(() => {
    if (!state.id) ws.close(4001, 'auth timeout');
  }, 15000);

  ws.on('message', (raw, isBinary) => {
    // simple token bucket so one client cannot flood the relay
    const now = Date.now();
    state.bucket = Math.min(LIMITS.msgPerSecond, state.bucket + ((now - state.last) / 1000) * LIMITS.msgPerSecond);
    state.last = now;
    if (state.bucket < 1) return;
    state.bucket -= 1;
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      if (!state.id) handlePreAuth(ws, state, msg, ip);
      else handle(ws, state, msg);
    } catch (e) {
      console.error('handler error', e && e.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!state.id) return;
    const set = online.get(state.id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        online.delete(state.id);
        dnd.delete(state.id);
        presence(state.id);
      }
    }
    // a sender who drops mid-transmission: finish it so queued copies are kept
    for (const [tid, tx] of txs) if (tx.ws === ws) finishTx(tid, { cut: true });
  });
});

function handlePreAuth(ws, state, msg, ip) {
  if (msg.t === 'hello') {
    if (!b64(msg.signPub, 64) || fromB64(msg.signPub).length !== 32) return ws.close(4002, 'bad key');
    if (msg.protocol !== PROTOCOL) {
      send(ws, { t: 'error', code: 'update_required', message: 'Please update Talkie to the latest version.' });
      return ws.close(4003, 'protocol');
    }
    state.signPub = msg.signPub;
    state.nonce = crypto.randomBytes(32).toString('base64');
    const known = !!members[idFor(msg.signPub)];
    send(ws, { t: 'challenge', nonce: state.nonce, known });
    return;
  }
  if (msg.t === 'auth') {
    if (!state.nonce) return ws.close(4002, 'no challenge');
    if (tooManyFails(ip)) {
      send(ws, { t: 'error', code: 'rate_limited', message: 'Too many attempts. Try again in 10 minutes.' });
      return ws.close(4004, 'rate limited');
    }
    const okSig =
      b64(msg.sig, 120) &&
      nacl.sign.detached.verify(
        new TextEncoder().encode('talkie-auth-v1:' + state.nonce),
        fromB64(msg.sig),
        fromB64(state.signPub),
      );
    state.nonce = null; // single use
    if (!okSig) {
      recordFail(ip);
      return ws.close(4005, 'bad signature');
    }
    const id = idFor(state.signPub);
    let m = members[id];
    if (!m) {
      if (!msg.code || !checkCode(msg.code)) {
        recordFail(ip);
        send(ws, { t: 'error', code: 'bad_code', message: 'That team code is not right. Check the email from George.' });
        return ws.close(4006, 'bad code');
      }
      if (!b64(msg.boxPub, 64) || fromB64(msg.boxPub).length !== 32) return ws.close(4002, 'bad box key');
      // the encryption key must be signed by the identity key, so no one can swap it later
      const okBox =
        b64(msg.boxSig, 120) &&
        nacl.sign.detached.verify(
          new TextEncoder().encode('talkie-box-v1:' + msg.boxPub),
          fromB64(msg.boxSig),
          fromB64(state.signPub),
        );
      if (!okBox) return ws.close(4002, 'bad box signature');
      if (Object.keys(members).length >= LIMITS.maxMembers) return ws.close(4007, 'team full');
      const name = cleanName(msg.name) || 'Teammate';
      m = members[id] = { id, name, signPub: state.signPub, boxPub: msg.boxPub, boxSig: msg.boxSig, joinedAt: Date.now() };
      saveMembers();
      console.log('joined:', name);
    } else if (msg.name && cleanName(msg.name) && cleanName(msg.name) !== m.name) {
      m.name = cleanName(msg.name);
      saveMembers();
    }
    state.id = id;
    if (!online.has(id)) online.set(id, new Set());
    online.get(id).add(ws);
    dnd.set(id, !!msg.dnd);
    const queue = loadQueue(id);
    send(ws, {
      t: 'welcome',
      you: id,
      members: Object.values(members).map(publicMember),
      queue,
    });
    presence(id);
  }
}

function handle(ws, state, msg) {
  const me = state.id;
  switch (msg.t) {
    case 'dnd': {
      dnd.set(me, !!msg.on);
      presence(me);
      break;
    }
    case 'rename': {
      const name = cleanName(msg.name);
      if (name && members[me]) {
        members[me].name = name;
        saveMembers();
        presence(me);
        send(ws, { t: 'member', member: publicMember(members[me]) });
      }
      break;
    }
    case 'tx-start': {
      if (!TID.test(msg.tid || '') || txs.has(msg.tid)) return;
      if (!Array.isArray(msg.to) || msg.to.length === 0 || msg.to.length > 50) return;
      if (!msg.keys || typeof msg.keys !== 'object') return;
      const to = new Set();
      for (const rid of msg.to) {
        const k = msg.keys[rid];
        if (rid === me || !members[rid] || !k || !b64(k.n, 64) || !b64(k.c, 128)) continue;
        to.add(rid);
      }
      if (to.size === 0) return;
      const tx = { ws, from: me, to, chunks: [], started: Date.now(), keys: {}, offline: new Set() };
      txs.set(msg.tid, tx);
      const delivered = [];
      for (const rid of to) {
        tx.keys[rid] = { n: msg.keys[rid].n, c: msg.keys[rid].c };
        const start = { t: 'tx-start', tid: msg.tid, from: me, to: [...to], key: tx.keys[rid], at: tx.started };
        if (sendTo(rid, start)) delivered.push(rid);
        else tx.offline.add(rid);
      }
      send(ws, { t: 'tx-ack', tid: msg.tid, live: delivered, offline: [...tx.offline] });
      tx.timer = setTimeout(() => finishTx(msg.tid, { cut: true }), LIMITS.maxTxSeconds * 1000);
      break;
    }
    case 'tx-chunk': {
      const tx = txs.get(msg.tid);
      if (!tx || tx.from !== me) return;
      if (!b64(msg.n, 64) || !b64(msg.c, LIMITS.maxChunkB64) || !Number.isInteger(msg.seq)) return;
      if (tx.chunks.length >= LIMITS.maxTxChunks) return finishTx(msg.tid, { cut: true });
      const chunk = { seq: msg.seq, n: msg.n, c: msg.c };
      tx.chunks.push(chunk);
      for (const rid of tx.to) {
        if (tx.offline.has(rid)) continue;
        if (!sendTo(rid, { t: 'tx-chunk', tid: msg.tid, ...chunk })) tx.offline.add(rid);
      }
      break;
    }
    case 'tx-end': {
      const tx = txs.get(msg.tid);
      if (!tx || tx.from !== me) return;
      finishTx(msg.tid, { dur: Number(msg.dur) || 0 });
      break;
    }
    case 'reply': {
      // small receipts: "heard", "snooze" (with minutes), "later"
      if (!members[msg.to] || !TID.test(msg.tid || '')) return;
      const kind = ['heard', 'snooze', 'later'].includes(msg.kind) ? msg.kind : null;
      if (!kind) return;
      const minutes = Math.max(1, Math.min(120, parseInt(msg.minutes, 10) || 5));
      sendTo(msg.to, { t: 'reply', from: me, tid: msg.tid, kind, minutes });
      break;
    }
    case 'queue-ack': {
      if (!Array.isArray(msg.tids)) return;
      const drop = new Set(msg.tids.filter((t) => typeof t === 'string'));
      saveQueue(
        me,
        loadQueue(me).filter((m) => !drop.has(m.tid)),
      );
      break;
    }
    case 'leave': {
      // a member removing themselves from the team
      delete members[me];
      saveMembers();
      saveQueue(me, []);
      broadcast({ t: 'member-left', id: me });
      ws.close(4100, 'left');
      break;
    }
    default:
      break;
  }
}

function finishTx(tid, { dur = 0, cut = false } = {}) {
  const tx = txs.get(tid);
  if (!tx) return;
  txs.delete(tid);
  clearTimeout(tx.timer);
  const seconds = dur || (Date.now() - tx.started) / 1000;
  for (const rid of tx.to) {
    if (tx.offline.has(rid)) {
      const q = loadQueue(rid);
      q.push({ tid, from: tx.from, to: [...tx.to], key: tx.keys[rid], at: tx.started, dur: seconds, chunks: tx.chunks });
      saveQueue(rid, q);
    } else {
      sendTo(rid, { t: 'tx-end', tid, dur: seconds, cut });
    }
  }
}

// keep connections alive through the tunnel and drop dead ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 25000);

server.listen(PORT, HOST, () => {
  console.log(`Talkie relay listening on ${HOST}:${PORT} (data in ${DATA})`);
});

module.exports = { server, newTeamCode };
