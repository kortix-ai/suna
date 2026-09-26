/**
 * Offline renderer for the Kortix sound palette. Pure TS, no dependencies,
 * deterministic: the same recipe always renders the same samples.
 *
 * Mirrors the Web Audio graph of cuelume's engine by Daniel Belyi (MIT),
 * https://github.com/danielwh2/cuelume — `src/audio/engine.ts`: oscillators
 * and filtered noise through exponential envelopes, a master gain, and a
 * feedback-delay shimmer. The live limiter/output gain is replaced by peak
 * normalization to TARGET_PEAK.
 */
import type { FilterType, NoiseLayer, Shimmer, SoundRecipe, ToneLayer } from './recipes';

export const SAMPLE_RATE = 44100;
/** −3 dBFS. */
export const TARGET_PEAK = 0.708;
/** Silence before the first layer; the last EDGE_SECONDS also stay below 1e-3. */
export const EDGE_SECONDS = 0.005;
/**
 * Linear fade-out on the tail. 20 ms, not 5: a recipe without shimmer (send)
 * ends on its envelope floor, ~2.6e-3 after normalization, and a 5 ms fade
 * leaves ~1.5e-3 in the last 5 ms.
 */
export const FADE_OUT_SECONDS = 0.02;
/** Trailing samples below this are trimmed. */
export const TRIM_FLOOR = 1e-4;

/** Web Audio exponential ramps cannot reach 0; cuelume ramps from/to this. */
const ENVELOPE_FLOOR = 0.0001;
const SOURCE_STOP_PADDING = 0.05;
const INAUDIBLE_GAIN = 0.001;
/** Butterworth Q for the shimmer feedback lowpass: no resonant peak in the loop. */
const SHIMMER_Q = Math.SQRT1_2;

export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** RBJ Audio EQ Cookbook coefficients, normalized by a0. Bandpass is the 0 dB peak-gain form. */
export function biquadCoefficients(type: FilterType, frequency: number, q: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** Returns a stateful per-sample filter (direct form I). */
export function createBiquad(c: Biquad): (x: number) => number {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** mulberry32 PRNG: uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Envelope gain at `t` seconds after the layer start: exponential up, exponential down, then 0. */
function envelope(t: number, attack: number, decay: number, peak: number): number {
  if (t < 0) return 0;
  if (t < attack) return ENVELOPE_FLOOR * Math.pow(peak / ENVELOPE_FLOOR, t / attack);
  if (t < attack + decay) return peak * Math.pow(ENVELOPE_FLOOR / peak, (t - attack) / decay);
  return 0;
}

function oscillator(waveform: ToneLayer['waveform'], phase: number): number {
  if (waveform === 'sine') return Math.sin(2 * Math.PI * phase);
  // Triangle: 0 → 1 → −1 → 0 over one cycle.
  if (phase < 0.25) return 4 * phase;
  if (phase < 0.75) return 2 - 4 * phase;
  return 4 * phase - 4;
}

function renderTone(out: Float64Array, layer: ToneLayer, start: number, sampleRate: number): void {
  const duration = layer.attack + layer.decay;
  const detune = Math.pow(2, (layer.detune ?? 0) / 1200);
  const glideTime = layer.glideTime ?? duration;
  const count = Math.ceil(duration * sampleRate);
  let phase = 0;
  for (let i = 0; i < count && start + i < out.length; i++) {
    const t = i / sampleRate;
    out[start + i] += oscillator(layer.waveform, phase) * envelope(t, layer.attack, layer.decay, layer.peak);
    let frequency = layer.frequency;
    if (layer.glideTo !== undefined) {
      frequency = t < glideTime ? layer.frequency * Math.pow(layer.glideTo / layer.frequency, t / glideTime) : layer.glideTo;
    }
    phase += (frequency * detune) / sampleRate;
    phase -= Math.floor(phase);
  }
}

function renderNoise(out: Float64Array, layer: NoiseLayer, index: number, start: number, sampleRate: number): void {
  const random = mulberry32(0x6b6f7274 + index * 0x9e3779b9);
  const filter = createBiquad(biquadCoefficients(layer.filterType, layer.filterFrequency, layer.filterQ ?? 1, sampleRate));
  const count = Math.ceil((layer.attack + layer.decay) * sampleRate);
  for (let i = 0; i < count && start + i < out.length; i++) {
    const noise = filter(2 * random() - 1);
    out[start + i] += noise * envelope(i / sampleRate, layer.attack, layer.decay, layer.peak);
  }
}

/** input → delay → lowpass → ×feedback back into the delay; lowpass × wet joins the dry signal. */
function applyShimmer(dry: Float64Array, shimmer: Shimmer, sampleRate: number): Float64Array {
  const delay = Math.max(1, Math.round(shimmer.delay * sampleRate));
  const lowpass = createBiquad(biquadCoefficients('lowpass', shimmer.lowpass, SHIMMER_Q, sampleRate));
  const line = new Float64Array(dry.length);
  const out = new Float64Array(dry.length);
  for (let n = 0; n < dry.length; n++) {
    const echo = lowpass(n >= delay ? line[n - delay] : 0);
    line[n] = dry[n] + shimmer.feedback * echo;
    out[n] = dry[n] + shimmer.wet * echo;
  }
  return out;
}

function sourceEnd(recipe: SoundRecipe): number {
  return Math.max(...recipe.layers.map((layer) => (layer.offset ?? 0) + layer.attack + layer.decay + SOURCE_STOP_PADDING));
}

/** cuelume's `shimmerTail`: echoes until the feedback falls below INAUDIBLE_GAIN. */
function shimmerTail(shimmer?: Shimmer): number {
  if (!shimmer || shimmer.feedback <= 0) return 0;
  if (shimmer.feedback >= 1) return shimmer.delay;
  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)));
}

/**
 * Renders a recipe to mono samples peak-normalized to TARGET_PEAK. The first
 * EDGE_SECONDS are silent (every layer starts after them), trailing samples
 * below TRIM_FLOOR are trimmed, and the last FADE_OUT_SECONDS fade linearly to 0.
 */
export function renderRecipe(recipe: SoundRecipe, sampleRate = SAMPLE_RATE): Float32Array {
  const edge = Math.round(EDGE_SECONDS * sampleRate);
  const length = edge + Math.ceil((sourceEnd(recipe) + shimmerTail(recipe.shimmer)) * sampleRate);
  let mix: Float64Array = new Float64Array(length);

  recipe.layers.forEach((layer, index) => {
    const start = edge + Math.round((layer.offset ?? 0) * sampleRate);
    if (layer.kind === 'tone') renderTone(mix, layer, start, sampleRate);
    else renderNoise(mix, layer, index, start, sampleRate);
  });

  for (let n = 0; n < length; n++) mix[n] *= recipe.masterGain;
  if (recipe.shimmer) mix = applyShimmer(mix, recipe.shimmer, sampleRate);

  let peak = 0;
  for (let n = 0; n < length; n++) peak = Math.max(peak, Math.abs(mix[n]));
  const scale = peak > 0 ? TARGET_PEAK / peak : 0;

  let end = length;
  while (end > edge && Math.abs(mix[end - 1] * scale) < TRIM_FLOOR) end--;

  const out = new Float32Array(end);
  for (let n = 0; n < end; n++) out[n] = mix[n] * scale;
  const fade = Math.min(Math.round(FADE_OUT_SECONDS * sampleRate), end);
  for (let i = 0; i < fade; i++) out[end - 1 - i] *= i / fade;
  return out;
}

/** RIFF/WAVE, PCM 16-bit, mono. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let n = 0; n < samples.length; n++) {
    const x = Math.max(-1, Math.min(1, samples[n]));
    view.setInt16(44 + n * 2, Math.round(x * 32767), true);
  }
  return bytes;
}
