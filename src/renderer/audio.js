'use strict';
/*
 * Audio engine: microphone -> Opus (WebCodecs) -> packets for the main process,
 * and packets -> Opus decoder -> speakers. Plus the walkie-talkie sounds.
 * Encryption happens in the main process; nothing here touches the network.
 */
const TalkieAudio = (() => {
  const RATE = 48000;
  const FRAME_US = 20000;
  const FRAMES_PER_PACKET = 5; // 100 ms per network packet
  let ctx = null;
  let workletReady = null;
  const stats = { captured: 0, sent: 0, decoded: 0, peak: 0, plays: 0 };

  function getCtx() {
    if (!ctx) ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ---------- sounds (synthesised, no files) ----------
  // Small, soft, low sounds: gentle sine "blips", no static, quiet even at full volume.
  let muted = false;
  function blip(c, freq, start, dur, vol) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + dur + 0.02);
  }
  function sound(kind) {
    if (muted) return;
    const c = getCtx();
    const t = c.currentTime + 0.02;
    if (kind === 'start') {
      // two soft notes going up: "you're on"
      blip(c, 523, t, 0.09, 0.05);
      blip(c, 659, t + 0.07, 0.11, 0.05);
    } else if (kind === 'end') {
      // the same two notes going down: "sent"
      blip(c, 659, t, 0.09, 0.045);
      blip(c, 523, t + 0.07, 0.13, 0.045);
    } else if (kind === 'notify') {
      // someone wants you: two gentle taps
      blip(c, 587, t, 0.12, 0.05);
      blip(c, 587, t + 0.16, 0.12, 0.05);
    } else if (kind === 'notify-soft') {
      blip(c, 659, t, 0.1, 0.03);
    }
  }
  function setMuted(v) {
    muted = !!v;
  }

  // ---------- packet format: [count][len hi][len lo]...[frames...] ----------
  function pack(frames) {
    let total = 1 + frames.length * 2;
    for (const f of frames) total += f.length;
    const out = new Uint8Array(total);
    out[0] = frames.length;
    let o = 1 + frames.length * 2;
    frames.forEach((f, i) => {
      out[1 + i * 2] = f.length >> 8;
      out[2 + i * 2] = f.length & 255;
      out.set(f, o);
      o += f.length;
    });
    return out;
  }
  function unpack(p) {
    const n = p[0];
    const frames = [];
    let o = 1 + n * 2;
    for (let i = 0; i < n; i++) {
      const len = (p[1 + i * 2] << 8) | p[2 + i * 2];
      frames.push(p.subarray(o, o + len));
      o += len;
    }
    return frames;
  }

  // ---------- capture ----------
  let cap = null;
  async function ensureWorklet(c) {
    if (!workletReady) workletReady = c.audioWorklet.addModule('capture-worklet.js');
    return workletReady;
  }
  async function encoderConfig() {
    const rich = {
      codec: 'opus',
      sampleRate: RATE,
      numberOfChannels: 1,
      bitrate: 24000,
      opus: { frameDuration: FRAME_US, application: 'voip', signal: 'voice', complexity: 9, useinbandfec: true },
    };
    try {
      if ((await AudioEncoder.isConfigSupported(rich)).supported) return rich;
    } catch {}
    return { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 24000 };
  }

  // Open the microphone a moment early (when the keys go down), so the first word is not cut off.
  // If nobody talks within a few seconds it is closed again.
  const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  let warmStream = null;
  let warmTimer = null;
  async function warm() {
    try {
      ensureWorklet(getCtx());
      if (!warmStream) warmStream = navigator.mediaDevices.getUserMedia({ audio: MIC });
      clearTimeout(warmTimer);
      warmTimer = setTimeout(async () => {
        const s = warmStream;
        warmStream = null;
        if (s) (await s.catch(() => null))?.getTracks().forEach((t) => t.stop());
      }, 6000);
    } catch {}
  }
  function takeStream() {
    if (warmStream) {
      const s = warmStream;
      warmStream = null;
      clearTimeout(warmTimer);
      return s;
    }
    return navigator.mediaDevices.getUserMedia({ audio: MIC });
  }

  async function startCapture(tid, onPacket, onError) {
    stopCaptureNow();
    const me = { tid, stopped: false, frames: [], ts: 0, started: performance.now() };
    cap = me;
    try {
      const c = getCtx();
      sound('start');
      await ensureWorklet(c);
      const stream = await takeStream();
      if (me.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      me.stream = stream;
      me.encoder = new AudioEncoder({
        output: (chunk) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          me.frames.push(b);
          if (me.frames.length >= FRAMES_PER_PACKET) flush(me, onPacket);
        },
        error: (e) => onError(e.message || String(e)),
      });
      me.encoder.configure(await encoderConfig());
      me.src = c.createMediaStreamSource(stream);
      me.node = new AudioWorkletNode(c, 'talkie-capture');
      me.mute = c.createGain();
      me.mute.gain.value = 0;
      me.node.port.onmessage = (e) => {
        if (me.stopped || me.encoder.state !== 'configured') return;
        const data = e.data;
        const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp: me.ts, data });
        me.ts += FRAME_US;
        stats.captured++;
        me.encoder.encode(ad);
        ad.close();
      };
      me.src.connect(me.node).connect(me.mute).connect(c.destination);
    } catch (e) {
      me.stopped = true;
      onError(e && e.name === 'NotAllowedError' ? 'Talkie is not allowed to use the microphone.' : (e.message || String(e)));
    }
  }
  function flush(me, onPacket) {
    if (!me.frames.length) return;
    const p = pack(me.frames);
    me.frames = [];
    stats.sent++;
    onPacket(p);
  }
  async function stopCapture(onPacket) {
    const me = cap;
    if (!me) return 0;
    me.stopped = true;
    cap = null;
    const dur = (performance.now() - me.started) / 1000;
    try {
      if (me.src) me.src.disconnect();
      if (me.node) me.node.disconnect();
      if (me.encoder && me.encoder.state === 'configured') {
        await me.encoder.flush();
        flush(me, onPacket);
        me.encoder.close();
      }
    } catch {}
    if (me.stream) me.stream.getTracks().forEach((t) => t.stop());
    sound('end');
    return dur;
  }
  function stopCaptureNow() {
    if (!cap) return;
    cap.stopped = true;
    if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop());
    cap = null;
  }

  // ---------- playback ----------
  const players = new Map();
  class Player {
    constructor(tid, onDone) {
      this.tid = tid;
      this.onDone = onDone;
      this.c = getCtx();
      this.next = 0;
      this.ts = 0;
      this.sources = new Set();
      this.ended = false;
      this.gain = this.c.createGain();
      this.gain.gain.value = muted ? 0 : 1;
      this.gain.connect(this.c.destination);
      this.dec = new AudioDecoder({ output: (ad) => this.out(ad), error: (e) => console.error('decode', e) });
      this.dec.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
    }
    feed(packet) {
      if (this.dec.state !== 'configured') return;
      for (const f of unpack(packet)) {
        this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, duration: FRAME_US, data: f }));
        this.ts += FRAME_US;
      }
    }
    out(ad) {
      const n = ad.numberOfFrames;
      const f = new Float32Array(n);
      try {
        if (ad.format === 'f32' || ad.format === 'f32-planar') ad.copyTo(f, { planeIndex: 0 });
        else ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
      } catch (e) {
        ad.close();
        return;
      }
      const rate = ad.sampleRate;
      ad.close();
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(f[i]));
      stats.peak = Math.max(stats.peak, peak);
      stats.decoded++;
      const buf = this.c.createBuffer(1, n, rate);
      buf.copyToChannel(f, 0);
      const s = this.c.createBufferSource();
      s.buffer = buf;
      s.connect(this.gain);
      const now = this.c.currentTime;
      if (this.next < now + 0.03) this.next = now + 0.15; // small buffer against network jitter
      s.start(this.next);
      this.next += buf.duration;
      this.sources.add(s);
      s.onended = () => {
        this.sources.delete(s);
        this.check();
      };
    }
    async end() {
      try {
        if (this.dec.state === 'configured') await this.dec.flush();
      } catch {}
      this.ended = true;
      this.check();
    }
    stop() {
      for (const s of this.sources) try { s.stop(); } catch {}
      this.sources.clear();
      this.ended = true;
      this.check();
    }
    check() {
      if (this.ended && this.sources.size === 0 && !this.done) {
        this.done = true;
        try { this.dec.close(); } catch {}
        players.delete(this.tid);
        this.onDone(this.tid);
      }
    }
  }

  function liveStart(tid, onDone) {
    sound('start');
    // let the chirp finish before the voice
    const p = new Player(tid, (t) => {
      sound('end');
      onDone(t);
    });
    p.next = p.c.currentTime + 0.3;
    players.set(tid, p);
  }
  function livePacket(tid, bytes) {
    const p = players.get(tid);
    if (p) p.feed(new Uint8Array(bytes));
  }
  function liveEnd(tid) {
    const p = players.get(tid);
    if (p) p.end();
  }
  function play(tid, packets, onDone) {
    for (const p of players.values()) if (p.replay) p.stop();
    stats.plays++;
    sound('start');
    const p = new Player(tid, (t) => {
      sound('end');
      onDone(t);
    });
    p.replay = true;
    p.next = p.c.currentTime + 0.3;
    players.set(tid, p);
    for (const pk of packets) p.feed(new Uint8Array(pk));
    p.end();
  }
  function stopAll() {
    for (const p of [...players.values()]) p.stop();
  }

  // ---------- for speech to text: packets -> 16 kHz mono WAV (stays on this computer) ----------
  async function decodeToWav(packets) {
    const parts = [];
    let total = 0;
    const dec = new AudioDecoder({
      output: (ad) => {
        const f = new Float32Array(ad.numberOfFrames);
        try {
          ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
          parts.push(f);
          total += f.length;
        } catch {}
        ad.close();
      },
      error: () => {},
    });
    dec.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
    let ts = 0;
    for (const pk of packets) {
      for (const fr of unpack(new Uint8Array(pk))) {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, duration: FRAME_US, data: fr }));
        ts += FRAME_US;
      }
    }
    await dec.flush();
    dec.close();
    const n = Math.floor(total / 3);
    const out = new Uint8Array(44 + n * 2);
    const v = new DataView(out.buffer);
    const w = (o, str) => [...str].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, n * 2, true);
    // average every 3 samples: 48 kHz -> 16 kHz
    let o = 44;
    let acc = 0;
    let k = 0;
    for (const f of parts) {
      for (let i = 0; i < f.length; i++) {
        acc += f[i];
        if (++k === 3) {
          const s = Math.max(-1, Math.min(1, acc / 3));
          if (o < out.length) v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          o += 2;
          acc = 0;
          k = 0;
        }
      }
    }
    return out;
  }

  return { sound, setMuted, warm, startCapture, stopCapture, liveStart, livePacket, liveEnd, play, stopAll, decodeToWav, stats, getCtx };
})();
