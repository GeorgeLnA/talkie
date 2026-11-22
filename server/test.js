'use strict';
// End-to-end protocol test: real relay, real encryption, three members.
// Run from the repo root after `npm install`: node server/test.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkie-test-'));
process.env.TALKIE_DATA = dataDir;
process.env.TALKIE_PORT = '0';
process.env.TALKIE_TEAM_CODE = 'TK-TEST-CODE-1234';

const { server } = require('./index.js');
const core = require('../src/main/core.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function once(em, ev, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), timeout);
    em.once(ev, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const url = 'ws://127.0.0.1:' + server.address().port;
  const mk = (name, code = 'tk-test-code-1234') =>
    new core.RelayClient({ identity: core.createIdentity(), name, code });

  // wrong code is refused
  const intruder = mk('Intruder', 'TK-WRONG-CODE-0000');
  const errP = once(intruder, 'server-error');
  intruder.connect(url);
  assert.strictEqual((await errP).code, 'bad_code');
  intruder.close();
  console.log('ok  wrong team code refused');

  const a = mk('George');
  const b = mk('Jana');
  const c = mk('Fabio');
  for (const x of [a, b, c]) {
    const p = once(x, 'welcome');
    x.connect(url);
    await p;
  }
  await wait(100);
  assert.strictEqual(a.members.size, 3);
  console.log('ok  three members joined, keys verified');

  // C goes offline; A talks to B and C
  c.close();
  await wait(200);

  const packets = Array.from({ length: 12 }, () => crypto.randomBytes(200 + Math.floor(Math.random() * 300)));
  const got = [];
  b.on('tx-chunk', (ch) => got.push(Buffer.from(ch.bytes)));
  const startP = once(b, 'tx-start');
  const ackP = once(a, 'tx-ack');
  const tx = a.startTx([b.id, c.id]);
  const ack = await ackP;
  assert.deepStrictEqual(ack.live, [b.id]);
  assert.deepStrictEqual(ack.offline, [c.id]);
  await startP;
  for (const p of packets) a.sendPacket(tx.tid, p);
  const endP = once(b, 'tx-end');
  a.endTx(tx.tid, 1.2);
  await endP;
  assert.strictEqual(got.length, packets.length);
  packets.forEach((p, i) => assert.ok(p.equals(got[i])));
  console.log('ok  live voice delivered and decrypted (' + packets.length + ' packets)');

  // the relay's stored copy is unreadable without C's key
  const qfile = path.join(dataDir, 'queue', c.id + '.json');
  const stored = fs.readFileSync(qfile, 'utf8');
  assert.ok(!stored.includes(packets[0].toString('base64').slice(0, 40)));
  console.log('ok  stored copy on the relay is encrypted');

  // C comes back and receives the message
  const c2 = new core.RelayClient({ identity: c.identity, name: 'Fabio' });
  const qP = once(c2, 'queued');
  c2.connect(url);
  const queue = await qP;
  assert.strictEqual(queue.length, 1);
  const opened = c2.openEnvelope(queue[0]);
  assert.strictEqual(opened.length, packets.length);
  packets.forEach((p, i) => assert.ok(p.equals(Buffer.from(opened[i]))));
  c2.ackQueue([queue[0].tid]);
  await wait(150);
  assert.ok(!fs.existsSync(qfile));
  console.log('ok  offline member got the saved message, then it was deleted from the relay');

  // B cannot open a key sealed for C
  assert.strictEqual(core.openKey(queue[0].key, a.identity.boxPub, b.identity.boxSec), null);
  console.log('ok  one member cannot open a key sealed for another');

  // replies and DND presence
  const repP = once(a, 'reply');
  b.reply(a.id, tx.tid, 'snooze', 5);
  const rep = await repP;
  assert.strictEqual(rep.kind, 'snooze');
  assert.strictEqual(rep.minutes, 5);
  const memP = once(a, 'member');
  b.setDnd(true);
  const m = await memP;
  assert.strictEqual(m.dnd, true);
  console.log('ok  "wait 5 min" reply and do-not-disturb status reach the sender');

  // a forged member record (swapped encryption key) is rejected by clients
  const forged = { ...[...a.members.values()].find((x) => x.id === b.id), boxPub: c.identity.boxPub };
  assert.strictEqual(core.verifyMember(forged), false);
  console.log('ok  a swapped encryption key is detected');

  assert.match(core.safetyCode(a.identity.signPub, a.identity.boxPub), /^\d{5}( \d{5}){5}$/);
  console.log('ok  safety code format');

  for (const x of [a, b, c2]) x.close();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\nAll relay tests passed.');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
