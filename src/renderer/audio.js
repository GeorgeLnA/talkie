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
  function tone(c, freq, start, dur, vol, type = 'square') {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.005);
    g.gain.setValueAtTime(vol, start + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + dur + 0.02);
  }
  function squelch(c, start, dur, vol) {
    const len = Math.floor(c.sampleRate * dur);
    const b = c.createBuffer(1, len, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource();
    s.buffer = b;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.value = vol;
    s.connect(f).connect(g).connect(c.destination);
    s.start(start);
  }
  function sound(kind) {
    const c = getCtx();
    const t = c.currentTime + 0.02;
    if (kind === 'start') {
      // the classic "key up" chirp
      squelch(c, t, 0.07, 0.25);
      tone(c, 1250, t + 0.06, 0.05, 0.08);
      tone(c, 1650, t + 0.11, 0.06, 0.08);
    } else if (kind === 'end') {
      // roger beep and a short burst of static
      tone(c, 1650, t, 0.05, 0.07);
      tone(c, 1100, t + 0.05, 0.08, 0.07);
      squelch(c, t + 0.13, 0.12, 0.22);
    } else if (kind === 'notify') {
      squelch(c, t, 0.05, 0.18);
      tone(c, 1400, t + 0.05, 0.05, 0.07);
      tone(c, 1400, t + 0.15, 0.05, 0.07);
    } else if (kind === 'notify-soft') {
      tone(c, 1500, t, 0.04, 0.04, 'sine');
      tone(c, 2000, t + 0.06, 0.05, 0.04, 'sine');
    }
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

  async function startCapture(tid, onPacket, onError) {
    stopCaptureNow();
    const me = { tid, stopped: false, frames: [], ts: 0, started: performance.now() };
    cap = me;
    try {
      const c = getCtx();
      sound('start');
      await ensureWorklet(c);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
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

  return { sound, startCapture, stopCapture, liveStart, livePacket, liveEnd, play, stopAll, stats, getCtx };
})();
