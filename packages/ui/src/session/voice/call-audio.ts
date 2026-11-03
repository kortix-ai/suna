import { DUCK_GAIN } from './voice-call-state';

/**
 * A call's audio, ported from the voice lab's call page. `Mic` cuts the microphone into 20 ms Int16 frames at
 * the context's rate. `Spk` plays the voice's Int16 frames from a queue: `clear` drops it, `pause` holds it, and
 * `resume` goes on from the last pause in the speech (a run of 160 ms below 300), so a held sentence restarts
 * at a word, not mid-word.
 */
const WORKLET = `
  class Mic extends AudioWorkletProcessor {
    // rate: the relay's, when this context runs at the device's own (Firefox); each output sample averages the input
    // samples of its period, a box filter against aliasing. Unset, the context already runs at the relay's rate.
    constructor(o) { super(); this.r = o?.processorOptions?.rate || sampleRate; this.step = sampleRate / this.r; this.t = 0; this.a = 0; this.c = 0
      this.b = new Int16Array(this.r / 50); this.n = 0 }
    put(x) { this.b[this.n++] = Math.max(-1, Math.min(1, x)) * 0x7fff
      if (this.n === this.b.length) { this.port.postMessage(this.b.buffer, [this.b.buffer]); this.b = new Int16Array(this.r / 50); this.n = 0 } }
    process([i]) { const c = i[0]; if (!c) return true
      if (this.step === 1) { for (let k = 0; k < c.length; k++) this.put(c[k]); return true }
      for (let k = 0; k < c.length; k++) { this.a += c[k]; this.c++; if (++this.t >= this.step) { this.t -= this.step; this.put(this.a / this.c); this.a = 0; this.c = 0 } }
      return true }
  }
  class Spk extends AudioWorkletProcessor {
    constructor() { super(); this.q = []; this.o = 0; this.p = false; this.h = new Int16Array(sampleRate * 0.6); this.n = 0
      this.port.onmessage = (e) => e.data === 'clear' ? (this.q = [], this.o = 0, this.p = false, this.n = 0) : e.data === 'pause' ? (this.p = true) : e.data === 'resume' ? (this.rewind(), this.p = false) : this.q.push(new Int16Array(e.data)) }
    rewind() { const H = this.h.length, n = Math.min(this.n, H), at = (k) => this.h[(this.n - k) % H]
      let back = 0; for (let k = 1, quiet = 0; k <= n; k++) { quiet = Math.abs(at(k)) < 300 ? quiet + 1 : 0; if (quiet >= sampleRate * 0.16) { back = k - quiet; break } }
      if (!back) return; const r = new Int16Array(back); for (let k = 0; k < back; k++) r[k] = at(back - k)
      if (this.q[0]) this.q[0] = this.q[0].subarray(this.o); this.o = 0; this.q.unshift(r); this.n -= back }
    process(_, [out]) { const o = out[0]
      for (let k = 0; k < o.length; k++) { const h = !this.p && this.q[0]; if (!h) { o[k] = 0; continue }
        const s = h[this.o++]; o[k] = s / 0x8000; this.h[this.n++ % this.h.length] = s; if (this.o >= h.length) { this.q.shift(); this.o = 0 } }
      return true }
  }
  registerProcessor('mic', Mic); registerProcessor('spk', Spk)`;

let workletUrl: string | undefined;
const workletModule = () => (workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));

// Plain echo cancellation: Chrome's own AEC removes this page's playout from the microphone.
const MICROPHONE: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};
/** Voice frames that arrive before the speaker is set up (the greeting) wait, up to this many. */
const PENDING_MAX = 1500;

export interface CallAudioStart {
  inRate: number;
  outRate: number;
  /** The playback state the speaker starts in (`createPlayback().current()`). */
  held: boolean;
  ducked: boolean;
  muted: () => boolean;
  /** One 20 ms microphone frame, 16-bit mono PCM at `inRate`. */
  onFrame: (pcm: ArrayBuffer) => void;
}

/** One call's speaker and microphone. `stop` releases both, at any point of `start`. */
export class CallAudio {
  private output?: AudioContext;
  private input?: AudioContext;
  private stream?: MediaStream;
  private speaker?: AudioWorkletNode;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private pending: ArrayBuffer[] = [];
  private stopped = false;
  private readonly samples = new Float32Array(512);

  /** The speaker first, then the microphone. Resolves false when there is no microphone to use. */
  async start(opts: CallAudioStart): Promise<boolean> {
    const output = (this.output = new AudioContext({ sampleRate: opts.outRate }));
    await output.audioWorklet.addModule(workletModule());
    if (this.stopped) return false;
    const speaker = new AudioWorkletNode(output, 'spk');
    const gain = output.createGain();
    const analyser = output.createAnalyser();
    analyser.fftSize = 512;
    speaker.connect(gain).connect(output.destination);
    gain.connect(analyser);
    if (opts.held) {
      gain.gain.value = 0;
      speaker.port.postMessage('pause');
    } else if (opts.ducked) gain.gain.value = DUCK_GAIN;
    this.speaker = speaker;
    this.gain = gain;
    this.analyser = analyser;
    for (const pcm of this.pending) speaker.port.postMessage(pcm, [pcm]);
    this.pending = [];
    if (output.state === 'suspended') output.resume().catch(() => {});

    const stream = await navigator.mediaDevices?.getUserMedia(MICROPHONE).catch(() => null);
    if (this.stopped) {
      stream?.getTracks().forEach((track) => track.stop());
      return false;
    }
    if (!stream) return false;
    this.stream = stream;
    let input = (this.input = new AudioContext({ sampleRate: opts.inRate }));
    await input.audioWorklet.addModule(workletModule());
    if (this.stopped) return false;
    let mic = new AudioWorkletNode(input, 'mic', { numberOfOutputs: 0 });
    try {
      input.createMediaStreamSource(stream).connect(mic);
    } catch {
      // Firefox joins a microphone only to a context at the device's rate: there the worklet brings it to inRate.
      void input.close();
      input = this.input = new AudioContext();
      await input.audioWorklet.addModule(workletModule());
      if (this.stopped) return false;
      mic = new AudioWorkletNode(input, 'mic', { numberOfOutputs: 0, processorOptions: { rate: opts.inRate } });
      input.createMediaStreamSource(stream).connect(mic);
    }
    // Muted, the track sends silence: the relay keeps receiving frames.
    mic.port.onmessage = (event: MessageEvent<ArrayBuffer>) => opts.onFrame(event.data);
    this.mute(opts.muted());
    return true;
  }

  /** One frame of the voice, 16-bit mono PCM at `outRate`. */
  play(pcm: ArrayBuffer): void {
    if (this.speaker) this.speaker.port.postMessage(pcm, [pcm]);
    else if (!this.stopped && this.pending.length < PENDING_MAX) this.pending.push(pcm);
  }

  post(message: 'clear' | 'pause' | 'resume'): void {
    this.speaker?.port.postMessage(message);
  }

  level(value: number): void {
    this.gain?.gain.setTargetAtTime(value, this.gain.context.currentTime, 0.03);
  }

  mute(on: boolean): void {
    this.stream?.getAudioTracks().forEach((track) => (track.enabled = !on));
  }

  /** The voice's output level now (RMS of the last 512 samples). */
  voiceLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.sqrt(sum / this.samples.length);
  }

  stop(): void {
    this.stopped = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.input && this.input.state !== 'closed') void this.input.close().catch(() => {});
    if (this.output && this.output.state !== 'closed') void this.output.close().catch(() => {});
    this.speaker = this.gain = this.analyser = undefined;
    this.pending = [];
  }
}
