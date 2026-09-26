/**
 * The Kortix sound palette — layer/recipe types plus the four recipes that
 * `build-sounds.ts` renders to WAV (mobile) and MP3 (web).
 *
 * Recipe format and types ported from cuelume by Daniel Belyi (MIT),
 * https://github.com/danielwh2/cuelume — `src/sounds/recipes.ts`.
 */

type BaseLayer = {
  /** Seconds after the trigger that this layer starts. */
  offset?: number;
  /** Fade-in time, in seconds. */
  attack: number;
  /** Fade-out time, in seconds, starting right after the attack. */
  decay: number;
  /** Peak volume reached at the end of the attack. */
  peak: number;
};

export type Waveform = 'sine' | 'triangle';
export type FilterType = 'lowpass' | 'bandpass' | 'highpass';

/** A single note. */
export type ToneLayer = BaseLayer & {
  kind: 'tone';
  waveform: Waveform;
  frequency: number;
  /** Detune in cents. */
  detune?: number;
  /** If set, the pitch glides exponentially from `frequency` to this value. */
  glideTo?: number;
  /** Glide length in seconds. Defaults to attack + decay. */
  glideTime?: number;
};

/** A filtered noise burst. */
export type NoiseLayer = BaseLayer & {
  kind: 'noise';
  filterType: FilterType;
  filterFrequency: number;
  /** Biquad Q. Defaults to 1. */
  filterQ?: number;
};

export type SoundLayer = ToneLayer | NoiseLayer;

/** A feedback echo tail applied to the whole sound. */
export type Shimmer = {
  delay: number;
  feedback: number;
  wet: number;
  lowpass: number;
};

export type SoundRecipe = {
  masterGain: number;
  layers: SoundLayer[];
  shimmer?: Shimmer;
};

export type KortixSoundName = 'complete' | 'attention' | 'error' | 'send';

export const RECIPES: Record<KortixSoundName, SoundRecipe> = {
  /** Rising A-major arpeggio (A5, C#6, E6) with an octave sparkle on the last note. */
  complete: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 880, attack: 0.004, decay: 0.12, peak: 0.06 },
      { kind: 'tone', waveform: 'sine', frequency: 1108.73, offset: 0.07, attack: 0.004, decay: 0.14, peak: 0.06 },
      { kind: 'tone', waveform: 'sine', frequency: 1318.51, offset: 0.14, attack: 0.004, decay: 0.5, peak: 0.075 },
      { kind: 'tone', waveform: 'sine', frequency: 2637.02, offset: 0.14, attack: 0.004, decay: 0.3, peak: 0.012 },
    ],
    shimmer: { delay: 0.1, feedback: 0.25, wet: 0.18, lowpass: 4500 },
  },
  /** Two-note chime (C6, G6), played twice. */
  attention: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
      { kind: 'tone', waveform: 'sine', frequency: 1568, offset: 0.09, attack: 0.006, decay: 0.28, peak: 0.08 },
      { kind: 'tone', waveform: 'sine', frequency: 1046.5, offset: 0.42, attack: 0.006, decay: 0.22, peak: 0.07 },
      { kind: 'tone', waveform: 'sine', frequency: 1568, offset: 0.51, attack: 0.006, decay: 0.4, peak: 0.065 },
    ],
    shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
  },
  /** Soft noise tap, then a falling A4 → F4 pair. */
  error: {
    masterGain: 0.42,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 850, filterQ: 1.1, attack: 0.001, decay: 0.035, peak: 0.1 },
      { kind: 'tone', waveform: 'triangle', frequency: 440, offset: 0.025, attack: 0.004, decay: 0.12, peak: 0.045 },
      { kind: 'tone', waveform: 'sine', frequency: 880, offset: 0.025, attack: 0.004, decay: 0.1, peak: 0.012 },
      { kind: 'tone', waveform: 'triangle', frequency: 349.23, offset: 0.12, attack: 0.004, decay: 0.28, peak: 0.04 },
      { kind: 'tone', waveform: 'sine', frequency: 698.46, offset: 0.12, attack: 0.004, decay: 0.22, peak: 0.012 },
    ],
    shimmer: { delay: 0.12, feedback: 0.15, wet: 0.1, lowpass: 2500 },
  },
  /** Short upward octave glide over a breath of noise. */
  send: {
    masterGain: 0.45,
    layers: [
      { kind: 'noise', filterType: 'lowpass', filterFrequency: 2400, filterQ: 0.7, attack: 0.01, decay: 0.08, peak: 0.02 },
      { kind: 'tone', waveform: 'sine', frequency: 700, glideTo: 1400, glideTime: 0.08, attack: 0.003, decay: 0.12, peak: 0.06 },
    ],
  },
};
