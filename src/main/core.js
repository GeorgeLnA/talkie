'use strict';
/*
 * Talkie client core: keys, encryption and the relay protocol.
 * Runs in Electron's main process (and in plain Node for tests).
 *
 * Crypto (TweetNaCl, audited):
 *  - identity: Ed25519 signing key pair; the member id is a hash of its public key
 *  - encryption: X25519 key pair, its public key signed by the identity key
 *  - each transmission gets a fresh random 32-byte key; voice packets are sealed
 *    with XSalsa20-Poly1305 (secretbox) under that key, and the key is sealed to
 *    each recipient with nacl.box (X25519 + XSalsa20-Poly1305), which also proves
 *    who sent it.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const WebSocket = require('ws');

const PROTOCOL = 1;
const enc = (u8) => Buffer.from(u8).toString('base64');
const dec = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const utf8 = (s) => new TextEncoder().encode(s);

function createIdentity() {
  const sign = nacl.sign.keyPair();
  const box = nacl.box.keyPair();
  return {
    signPub: enc(sign.publicKey),
    signSec: enc(sign.secretKey),
    boxPub: enc(box.publicKey),
    boxSec: enc(box.secretKey),
    boxSig: enc(nacl.sign.detached(utf8('talkie-box-v1:' + enc(box.publicKey)), sign.secretKey)),
  };
}

function idFor(signPub) {
  return crypto.createHash('sha256').update(dec(signPub)).digest('hex').slice(0, 20);
}

// A short code both people can compare in person to be sure no one is in the middle.
function safetyCode(signPub, boxPub) {
  const h = crypto.createHash('sha256').update(dec(signPub)).update(dec(boxPub)).digest();
  const groups = [];
  for (let i = 0; i < 6; i++) groups.push(String(h.readUInt32BE(i * 4) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

function verifyMember(m) {
  try {
    if (idFor(m.signPub) !== m.id) return false;
    return nacl.sign.detached.verify(utf8('talkie-box-v1:' + m.boxPub), dec(m.boxSig), dec(m.signPub));
  } catch {
    return false;
  }
}

function sealKey(key, recipientBoxPub, myBoxSec) {
  const n = nacl.randomBytes(nacl.box.nonceLength);
  return { n: enc(n), c: enc(nacl.box(key, n, dec(recipientBoxPub), dec(myBoxSec))) };
}
function openKey(k, senderBoxPub, myBoxSec) {
  const key = nacl.box.open(dec(k.c), dec(k.n), dec(senderBoxPub), dec(myBoxSec));
  return key && key.length === 32 ? key : null;
}
function sealChunk(bytes, key) {
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { n: enc(n), c: enc(nacl.secretbox(bytes, n, key)) };
}
function openChunk(ch, key) {
  return nacl.secretbox.open(dec(ch.c), dec(ch.n), key);
}
function newTid() {
  return crypto.randomBytes(12).toString('base64url');
}

/*
 * Relay client. Events:
 *  status(state, detail)   'connecting' | 'online' | 'offline' | 'error'
 *  welcome(members)
 *  member(member)          presence or name changed
 *  member-left(id)
 *  tx-start({tid, from, to, at, key, keyRaw})
 *  tx-chunk({tid, seq, n, c, bytes})
 *  tx-end({tid, dur, cut})
 *  queued([envelope])      messages that arrived while this device was offline
 *  reply({from, tid, kind, minutes})
 *  tx-ack({tid, live, offline})
 *  key-changed(member)
 */
class RelayClient extends EventEmitter {
  constructor({ identity, name, code, pinned = {}, onPinned = () => {} }) {
    super();
    this.identity = identity;
    this.id = idFor(identity.signPub);
    this.name = name;
    this.code = code;
    this.pinned = pinned; // id -> boxPub seen first (trust on first use)
    this.onPinned = onPinned;
    this.members = new Map();
    this.txKeys = new Map(); // tid -> key (incoming and outgoing)
    this.dnd = false;
    this.ws = null;
    this.url = null;
    this.closed = false;
    this.retry = 0;
    this.authed = false;
  }

  connect(url) {
    this.url = url;
    this.closed = false;
    this._open();
  }

  close() {
    this.closed = true;
    clearTimeout(this._retryTimer);
    if (this.ws) this.ws.close();
  }

  _open() {
    if (this.closed || !this.url) return;
    this.emit('status', 'connecting');
    const ws = new WebSocket(this.url, { handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 });
    this.ws = ws;
    this.authed = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', signPub: this.identity.signPub, protocol: PROTOCOL }));
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      this._handle(msg);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.authed = false;
      this.emit('status', 'offline', { code, reason: String(reason || '') });
      // these mean "stop and ask the person", not "retry"
      if ([4003, 4006, 4100].includes(code)) return;
      this._scheduleRetry();
    });
    ws.on('error', (err) => {
      this.emit('status', 'error', { message: err.message });
    });
  }

  _scheduleRetry() {
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.retry++)) + Math.random() * 500;
    this.emit('retrying', { attempt: this.retry, delay });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._open(), delay);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  _acceptMember(m) {
    if (!verifyMember(m)) return null;
    const pin = this.pinned[m.id];
    if (!pin) {
      this.pinned[m.id] = m.boxPub;
      this.onPinned(this.pinned);
      m.keyChanged = false;
    } else {
      m.keyChanged = pin !== m.boxPub;
      if (m.keyChanged) this.emit('key-changed', m);
    }
    this.members.set(m.id, m);
    return m;
  }

  trustNewKey(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.pinned[id] = m.boxPub;
    m.keyChanged = false;
    this.onPinned(this.pinned);
    this.emit('member', m);
  }

  _handle(msg) {
    switch (msg.t) {
      case 'challenge': {
        const sig = nacl.sign.detached(utf8('talkie-auth-v1:' + msg.nonce), dec(this.identity.signSec));
        this._send({
          t: 'auth',
          sig: enc(sig),
          name: this.name,
          boxPub: this.identity.boxPub,
          boxSig: this.identity.boxSig,
          code: msg.known ? undefined : this.code,
          dnd: this.dnd,
        });
        break;
      }
      case 'welcome': {
        this.authed = true;
        this.retry = 0;
        this.members.clear();
        for (const m of msg.members || []) this._acceptMember(m);
        this.emit('status', 'online');
        this.emit('welcome', [...this.members.values()]);
        if (Array.isArray(msg.queue) && msg.queue.length) {
          this.emit('queued', msg.queue);
        }
        break;
      }
      case 'member': {
        const m = this._acceptMember(msg.member);
        if (m) this.emit('member', m);
        break;
      }
      case 'member-left': {
        this.members.delete(msg.id);
        this.emit('member-left', msg.id);
        break;
      }
      case 'tx-start': {
        const sender = this.members.get(msg.from);
        if (!sender || sender.keyChanged) return;
        const key = openKey(msg.key, sender.boxPub, this.identity.boxSec);
        if (!key) return;
        this.txKeys.set(msg.tid, key);
        this.emit('tx-start', { tid: msg.tid, from: msg.from, to: msg.to, at: msg.at, key: msg.key });
        break;
      }
      case 'tx-chunk': {
        const key = this.txKeys.get(msg.tid);
        if (!key) return;
        const bytes = openChunk(msg, key);
        if (!bytes) return;
        this.emit('tx-chunk', { tid: msg.tid, seq: msg.seq, n: msg.n, c: msg.c, bytes });
        break;
      }
      case 'tx-end': {
        this.txKeys.delete(msg.tid);
        this.emit('tx-end', { tid: msg.tid, dur: msg.dur, cut: !!msg.cut });
        break;
      }
      case 'tx-ack':
        this.emit('tx-ack', msg);
        break;
      case 'reply':
        this.emit('reply', msg);
        break;
      case 'error':
        this.emit('server-error', msg);
        break;
      default:
        break;
    }
  }

  // Decrypt a stored envelope (queued or saved live) into raw audio packets.
  openEnvelope(env) {
    const sender = this.members.get(env.from);
    if (!sender) return null;
    const key = openKey(env.key, sender.boxPub, this.identity.boxSec);
    if (!key) return null;
    const packets = [];
    for (const ch of [...env.chunks].sort((a, b) => a.seq - b.seq)) {
      const b = openChunk(ch, key);
      if (b) packets.push(b);
    }
    return packets;
  }

  setDnd(on) {
    this.dnd = !!on;
    this._send({ t: 'dnd', on: this.dnd });
  }
  rename(name) {
    this.name = name;
    this._send({ t: 'rename', name });
  }
  startTx(toIds) {
    const key = nacl.randomBytes(32);
    const tid = newTid();
    const keys = {};
    const to = [];
    for (const id of toIds) {
      const m = this.members.get(id);
      if (!m || m.keyChanged || id === this.id) continue;
      keys[id] = sealKey(key, m.boxPub, this.identity.boxSec);
      to.push(id);
    }
    if (!to.length) return null;
    this.txKeys.set(tid, key);
    this._outSeq = 0;
    this._send({ t: 'tx-start', tid, to, keys });
    return { tid, to };
  }
  sendPacket(tid, bytes) {
    const key = this.txKeys.get(tid);
    if (!key) return false;
    const ch = sealChunk(bytes, key);
    return this._send({ t: 'tx-chunk', tid, seq: this._outSeq++, n: ch.n, c: ch.c });
  }
  endTx(tid, dur) {
    this.txKeys.delete(tid);
    this._send({ t: 'tx-end', tid, dur });
  }
  reply(to, tid, kind, minutes) {
    this._send({ t: 'reply', to, tid, kind, minutes });
  }
  ackQueue(tids) {
    this._send({ t: 'queue-ack', tids });
  }
  leave() {
    this._send({ t: 'leave' });
  }
}

module.exports = {
  PROTOCOL,
  createIdentity,
  idFor,
  safetyCode,
  verifyMember,
  sealKey,
  openKey,
  sealChunk,
  openChunk,
  RelayClient,
  enc,
  dec,
};
