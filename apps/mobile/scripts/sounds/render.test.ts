import { describe, expect, test } from 'bun:test';

import { RECIPES, type KortixSoundName, type SoundRecipe } from './recipes';
import {
  EDGE_SECONDS,
  SAMPLE_RATE,
  TARGET_PEAK,
  biquadCoefficients,
  createBiquad,
  encodeWav,
  renderRecipe,
} from './render';

const DURATION_BOUNDS: Record<KortixSoundName, [number, number]> = {
  complete: [0.6, 1.4],
  attention: [0.8, 1.6],
  error: [0.4, 1.2],
  send: [0.1, 0.5],
};

const NAMES = Object.keys(RECIPES) as KortixSoundName[];

function peakOf(samples: Float32Array, from = 0, to = samples.length): number {
  let peak = 0;
  for (let n = from; n < to; n++) peak = Math.max(peak, Math.abs(samples[n]));
  return peak;
}

describe('renderRecipe', () => {
  test('is deterministic: two renders encode to identical bytes', () => {
    for (const name of NAMES) {
      const a = encodeWav(renderRecipe(RECIPES[name]));
      const b = encodeWav(renderRecipe(RECIPES[name]));
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });

  for (const name of NAMES) {
    test(`${name}: peak is −3 dBFS, no clipping, quiet edges, duration in bounds`, () => {
      const samples = renderRecipe(RECIPES[name]);
      const peak = peakOf(samples);
      expect(Math.abs(peak - TARGET_PEAK)).toBeLessThanOrEqual(0.005);
      expect(peak).toBeLessThanOrEqual(1);

      const edge = Math.round(EDGE_SECONDS * SAMPLE_RATE);
      expect(peakOf(samples, 0, edge)).toBeLessThan(1e-3);
      expect(peakOf(samples, samples.length - edge)).toBeLessThan(1e-3);

      const seconds = samples.length / SAMPLE_RATE;
      const [min, max] = DURATION_BOUNDS[name];
      expect(seconds).toBeGreaterThanOrEqual(min);
      expect(seconds).toBeLessThanOrEqual(max);
      expect(seconds).toBeLessThan(30);
    });
  }

  test('a 1 kHz sine tone crosses zero 2000 times per second (±1%)', () => {
    const recipe: SoundRecipe = {
      masterGain: 1,
      layers: [{ kind: 'tone', waveform: 'sine', frequency: 1000, attack: 0.01, decay: 1, peak: 0.5 }],
    };
    const samples = renderRecipe(recipe);
    const from = Math.round(0.1 * SAMPLE_RATE);
    const to = Math.round(0.9 * SAMPLE_RATE);
    let crossings = 0;
    for (let n = from + 1; n < to; n++) {
      if (samples[n - 1] < 0 !== samples[n] < 0) crossings++;
    }
    const rate = crossings / ((to - from) / SAMPLE_RATE);
    expect(Math.abs(rate - 2000) / 2000).toBeLessThan(0.01);
  });
});

describe('biquad', () => {
  test('RBJ lowpass at 1 kHz attenuates a 10 kHz sine by more than 20 dB', () => {
    const filter = createBiquad(biquadCoefficients('lowpass', 1000, 1, SAMPLE_RATE));
    let inEnergy = 0;
    let outEnergy = 0;
    for (let n = 0; n < SAMPLE_RATE; n++) {
      const x = Math.sin((2 * Math.PI * 10000 * n) / SAMPLE_RATE);
      const y = filter(x);
      // Skip the first 0.1 s of filter settling.
      if (n >= SAMPLE_RATE / 10) {
        inEnergy += x * x;
        outEnergy += y * y;
      }
    }
    const attenuationDb = 10 * Math.log10(inEnergy / outEnergy);
    expect(attenuationDb).toBeGreaterThan(20);
  });
});

describe('encodeWav', () => {
  test('writes a RIFF PCM 16-bit mono 44.1 kHz header', () => {
    const samples = renderRecipe(RECIPES.send);
    const bytes = encodeWav(samples);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(ascii(8)).toBe('WAVE');
    expect(ascii(12)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(88200);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(2 * samples.length);
    expect(bytes.length).toBe(44 + 2 * samples.length);
  });
});
