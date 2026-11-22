// Collects microphone audio into 20 ms frames (960 samples at 48 kHz).
class TalkieCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(960);
    this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let k = 0; k < ch.length; k++) {
        this.buf[this.i++] = ch[k];
        if (this.i === 960) {
          this.port.postMessage(this.buf.slice(0));
          this.i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('talkie-capture', TalkieCapture);
