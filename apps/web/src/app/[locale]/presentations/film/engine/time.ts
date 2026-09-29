/**
 * The film clock. Every value on screen is a pure function of the frame
 * number, so a frame renders identically live, in a scrub, and in the MP4.
 *
 * Grid: 60 fps, 120 BPM, 4/4 — one beat is 30 frames, one bar is 120 frames
 * (2 s). Scenes start and end on bar lines so cuts land on the music.
 */

export const FPS = 60;
export const BPM = 120;
export const BEAT = (FPS * 60) / BPM;
export const BAR = BEAT * 4;
export const bars = (n: number) => Math.round(n * BAR);
export const beats = (n: number) => Math.round(n * BEAT);

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** No `in` curve on purpose: `ease-in` reads as slow (kortix-brand-guidelines). */
export const ease = {
  linear: (t: number) => t,
  outQuad: (t: number) => 1 - (1 - t) ** 2,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
};

type Ease = (t: number) => number;

/** Map frame `f` from [a, b] onto [from, to], clamped, through `curve`. */
export function interp(f: number, a: number, b: number, from = 0, to = 1, curve: Ease = ease.outExpo) {
  return from + (to - from) * curve(clamp01((f - a) / (b - a)));
}

/**
 * The house enter: opacity over a short `outQuad` ramp, transform over three
 * times that on `outExpo` — two properties never share a curve. A small blur
 * bridges the swap. Scale floor 0.92, never 0.
 */
export function rise(f: number, at: number, { dist = 18, dur = 14, scale = 1, blur = 0 } = {}) {
  const o = interp(f, at, at + dur, 0, 1, ease.outQuad);
  const t = interp(f, at, at + dur * 3, 1, 0, ease.outExpo);
  return {
    opacity: o,
    transform: `translate3d(0, ${dist * t}px, 0) scale(${1 - (1 - scale) * t})`,
    filter: blur ? `blur(${blur * t}px)` : undefined,
  };
}

/** The inverse, for leaving: fade and drift up, never `ease-in`. */
export function fall(f: number, at: number, { dist = -12, dur = 12, blur = 0 } = {}) {
  const t = interp(f, at, at + dur, 0, 1, ease.outQuad);
  return {
    opacity: 1 - t,
    transform: `translate3d(0, ${dist * t}px, 0)`,
    filter: blur ? `blur(${blur * t}px)` : undefined,
  };
}

/** Both at once: in at `a`, out at `b`. */
export function span(f: number, a: number, b: number, opts?: Parameters<typeof rise>[2]) {
  const r = rise(f, a, opts);
  if (f < b) return r;
  const x = fall(f, b, { blur: opts?.blur });
  return { ...x, opacity: x.opacity * r.opacity };
}

/** Deterministic 0–2 frame jitter so a stagger reads as hand-timed. */
const JITTER = [0, 1, 0, 2, 1, 0, 1, 2, 0, 1];

/** Compressing stagger: each next item arrives a little sooner. */
export const stagger = (i: number, base: number) =>
  Math.round(i ** 0.8 * base) + JITTER[i % JITTER.length];

/** Typewriter: how many of `text`'s characters are visible at frame `f`. */
export const typed = (text: string, f: number, at: number, perFrame = 1) =>
  text.slice(0, Math.max(0, Math.floor((f - at) * perFrame)));
