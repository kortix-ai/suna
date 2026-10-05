/**
 * The timeline track, as pure functions: run folding, layout, colors, icon
 * placement, run jumps, the idle-gap hint, the audio line, inertia and the
 * opening zoom. Ported from the Kortix Capture engine's local timeline window
 * (kortix-ai/capture `apps/recorder/ui/memory/app.js`), so the web timeline
 * scrubs, folds and jumps the way the desktop one does. No DOM here.
 *
 * Times are epoch ms. `spp` is milliseconds per track pixel.
 */

/** One run of the track: consecutive frames of one app (and window). */
export interface TrackRun {
  s: number;
  e: number;
  /** What makes two runs "the same": the app. Null when the app is unknown. */
  k: string | null;
  app: string | null;
  title: string | null;
  url: string | null;
  /** Raw runs folded into this one (rendering only). */
  n?: number;
}

export interface LaidRun {
  s: TrackRun;
  x: number;
  w: number;
}

export type Rgb = [number, number, number];

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Zoom limits: 0.25 s to 90 s per pixel. */
export const SPP_MIN = 250;
export const SPP_MAX = 90_000;

/** Whether the cached range still covers the view with a quarter-span margin on each side. */
export function segCovers(range: readonly [number, number], a: number, b: number) {
  const span = b - a;
  return a >= range[0] + span * 0.25 && b <= range[1] - span * 0.25;
}

// ── Colors ───────────────────────────────────────────────────────────────────
// Vivid pastel hues (degrees), one per run key, stable. The device stores no app colors.
const VIVID_HUES = [172, 228, 6, 46, 276, 140, 330, 24, 200, 100];
const VIVID_S: [number, number] = [0.45, 0.7];
const VIVID_L: [number, number] = [0.55, 0.68];

export function hashKey(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rgbToHsl([r0, g0, b0]: Rgb): [number, number, number] {
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h0: number, s: number, l: number): Rgb {
  const h = ((h0 % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255)) as Rgb;
}

/** A run's color: a stable hue from its key, in the vivid pastel band; a little deeper on a light dock. */
export function runColor(run: Pick<TrackRun, 'k' | 'app'>, dark: boolean): Rgb {
  const h = VIVID_HUES[hashKey(String(run.k ?? run.app ?? '?')) % VIVID_HUES.length]!;
  const s = clamp(0.6, VIVID_S[0], VIVID_S[1]);
  let l = clamp(0.62, VIVID_L[0], VIVID_L[1]);
  if (!dark) l = clamp(l - 0.1, 0.42, 0.6);
  return hslToRgb(h, s, l);
}

/** Colors for laid-out runs: neighbours with different keys never share a hue (they turn 35° until 22° apart). */
export function runColors(
  runs: readonly { s: Pick<TrackRun, 'k' | 'app'> }[],
  dark: boolean,
): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < runs.length; i++) {
    let col = runColor(runs[i]!.s, dark);
    const prev = out[i - 1];
    if (prev && runs[i]!.s.k !== runs[i - 1]!.s.k) {
      const [h0, s, l] = rgbToHsl(col);
      let h = h0;
      const ph = rgbToHsl(prev)[0];
      for (let n = 0; n < 9 && Math.min(Math.abs(h - ph), 360 - Math.abs(h - ph)) < 22; n++)
        h += 35;
      col = hslToRgb(h, s, l);
    }
    out.push(col);
  }
  return out;
}

/** The same color, brighter: the run under the playhead. */
export function brighter(rgb: Rgb, by = 0.1): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb(h, s, Math.min(0.85, l + by));
}

// ── Folding and layout ───────────────────────────────────────────────────────
const FOLD_MS = 20_000;
const FOLD_PX = 4;
const JOIN_GAP_MS = 60_000;

/**
 * Fold short runs for rendering only:
 * 1. a run shorter than max(20 s, 4 px) between two runs with the same key joins them;
 * 2. a run shorter than 4 px next to another run joins the longer neighbour,
 *    so the bar does not turn to static at far zoom.
 * Returns new objects; the input is untouched.
 */
export function foldRuns(runs: readonly TrackRun[], spp: number, pad: number): TrackRun[] {
  const dur = (r: TrackRun) => r.e + pad - r.s;
  const shortMs = Math.max(FOLD_MS, FOLD_PX * spp);
  const tinyMs = FOLD_PX * spp;
  const out: TrackRun[] = [];
  for (const raw of runs) {
    const r: TrackRun = { ...raw, n: 1 };
    const prev = out[out.length - 1];
    const before = out[out.length - 2];
    if (
      prev &&
      before &&
      dur(prev) < shortMs &&
      before.k != null &&
      before.k === r.k &&
      prev.s - before.e <= JOIN_GAP_MS &&
      r.s - prev.e <= JOIN_GAP_MS
    ) {
      before.e = r.e;
      before.n = (before.n ?? 1) + (prev.n ?? 1) + 1;
      out.pop();
      continue;
    }
    if (prev && prev.k != null && prev.k === r.k && r.s - prev.e <= JOIN_GAP_MS) {
      prev.e = r.e;
      prev.n = (prev.n ?? 1) + 1;
      continue;
    }
    out.push(r);
  }
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!;
    if (dur(r) >= tinyMs) continue;
    const p = out[i - 1];
    const n = out[i + 1];
    const near = (x: TrackRun | undefined, y: TrackRun | undefined) =>
      !!x && !!y && Math.abs(y.s - x.e) <= Math.max(JOIN_GAP_MS, tinyMs);
    const pOk = near(p, r);
    const nOk = near(r, n);
    if (!pOk && !nOk) continue;
    const t = pOk && (!nOk || dur(p!) >= dur(n!)) ? p! : n!;
    t.s = Math.min(t.s, r.s);
    t.e = Math.max(t.e, r.e);
    t.n = (t.n ?? 1) + (r.n ?? 1);
    out.splice(i, 1);
    i = Math.max(-1, i - 2);
  }
  return out;
}

/** Pixel rectangles for runs in [0, W]: each at least `minW` wide, never overlapping, flush neighbours keep a `gap` px seam. */
export function layoutRuns(
  runs: readonly TrackRun[],
  xOf: (t: number) => number,
  W: number,
  pad: number,
  minW = 3,
  gap = 3,
): LaidRun[] {
  const out: LaidRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const s = runs[i]!;
    const x0 = xOf(s.s);
    let x1 = Math.max(xOf(s.e + pad), x0 + minW);
    const next = runs[i + 1];
    if (next) x1 = Math.min(x1, Math.max(xOf(next.s), x0 + minW));
    if (x1 < 0 || x0 > W) continue;
    out.push({ s, x: x0, w: x1 - x0 });
  }
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1]!;
    const r = out[i]!;
    const space = r.x - (p.x + p.w);
    if (space < gap) {
      const cut = Math.min(gap - space, p.w / 2, r.w / 2);
      p.w -= cut / 2;
      r.x += cut / 2;
      r.w -= cut / 2;
    }
  }
  return out;
}

export const ICON_SIZE = 22;

/**
 * Icon centers for laid-out runs: at the start of the run, sticky to the left
 * edge while the run is partly scrolled off, skipped when closer than `space`
 * px to the previous icon or when the run is under `minRun` px.
 */
export function placeIcons(
  runs: readonly LaidRun[],
  W: number,
  size = ICON_SIZE,
  space = 8,
  minRun = 18,
) {
  const out: { run: LaidRun; cx: number }[] = [];
  let lastX = -Infinity;
  for (const r of runs) {
    if (r.w < minRun || !r.s.app) continue;
    const half = size / 2;
    const cx = Math.max(r.x + half + 1, half + 2);
    if (cx + half > r.x + r.w || cx + half > W) continue;
    if (cx - lastX < size + space) continue;
    out.push({ run: r, cx });
    lastX = cx;
  }
  return out;
}

// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * Target time for Cmd/Ctrl+Left (dir -1) or Right (dir +1) over folded runs.
 * Inside a run, Left goes to its start first, then to the previous run's
 * start; in an idle gap, Left goes to the start of the run before it. Right
 * goes to the next run's start. Null when there is nowhere to go.
 */
export function runJumpTarget(
  runs: readonly TrackRun[],
  T: number,
  dir: -1 | 1,
  pad: number,
  eps = 1000,
): number | null {
  let cur = -1;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i]!.s <= T) cur = i;
    else break;
  }
  if (dir > 0) return cur + 1 < runs.length ? runs[cur + 1]!.s : null;
  if (cur < 0) return null;
  const inside = T <= runs[cur]!.e + pad;
  if (!inside || T > runs[cur]!.s + eps) return runs[cur]!.s;
  return cur > 0 ? runs[cur - 1]!.s : null;
}

/** The idle gap the playhead sits in, when it is at least `minGapMs` long and between two runs. */
export function gapAt(runs: readonly TrackRun[], T: number, pad: number, minGapMs = 5 * 60_000) {
  let before: TrackRun | null = null;
  let after: TrackRun | null = null;
  for (const r of runs) {
    if (r.s <= T) before = r;
    else {
      after = r;
      break;
    }
  }
  if (before && T <= before.e + pad) return null;
  const start = before ? before.e + pad : null;
  const end = after ? after.s : null;
  if (start == null || end == null || end - start < minGapMs) return null;
  return { start, end };
}

/** Audio bars in [0, W]: one per stretch of sound; segments closer than `join` px merge. */
export function audioBars(
  segs: readonly { s: number; e: number }[],
  xOf: (t: number) => number,
  W: number,
  join = 2,
) {
  const out: { x: number; w: number }[] = [];
  for (const a of segs) {
    const x0 = xOf(a.s);
    const x1 = xOf(a.e);
    if (x1 < 0 || x0 > W) continue;
    const last = out[out.length - 1];
    if (last && x0 - (last.x + last.w) <= join) last.w = Math.max(last.w, x1 - last.x);
    else out.push({ x: x0, w: Math.max(1, x1 - x0) });
  }
  return out;
}

// ── Inertia ──────────────────────────────────────────────────────────────────
export const MOMENTUM_TAU = 325;
export const MOMENTUM_STOP = 0.02;

/** Release velocity (px/ms) from pointer samples, over the last `win` ms only. */
export function velocityFromSamples(samples: readonly { t: number; x: number }[], win = 100) {
  if (samples.length < 2) return 0;
  const end = samples[samples.length - 1]!;
  let i = samples.length - 1;
  while (i > 0 && end.t - samples[i - 1]!.t <= win) i--;
  const a = samples[i]!;
  const dt = end.t - a.t;
  return dt > 0 ? (end.x - a.x) / dt : 0;
}

/** Advance a decaying velocity by dt ms: the exact distance moved and the new velocity. */
export function momentumStep(v: number, dt: number, tau = MOMENTUM_TAU) {
  const k = Math.exp(-dt / tau);
  return { dx: v * tau * (1 - k), v: v * k };
}

// ── Opening zoom ─────────────────────────────────────────────────────────────

/**
 * The opening scale: 12 minutes across, widened when the newest recording is
 * short and an earlier one ended long before it, so the view shows where
 * recording resumed. Capped at 6 hours across.
 */
export function openingSpp(
  lastMs: number | null,
  runs: readonly TrackRun[],
  trackW: number,
  pad: number,
) {
  const defaultMs = 12 * 60_000;
  const minFrac = 0.15;
  const capMs = 6 * 3_600_000;
  const margin = 1.1;
  const W = Math.max(400, trackW || 0);
  const lim = (v: number) => Math.min(SPP_MAX, Math.max(SPP_MIN, v));
  const spp0 = lim(defaultMs / W);
  if (lastMs == null || !runs.length) return { spp: spp0, widened: false };
  const half = (spp0 * W) / 2;
  const left = lastMs - half;
  let recorded = 0;
  let prev: TrackRun | null = null;
  for (const r of runs) {
    const a = Math.max(r.s, left);
    const b = Math.min(r.e + pad, lastMs);
    if (b > a) recorded += b - a;
    if (r.e + pad <= left) prev = r;
  }
  if (recorded / half >= minFrac || !prev) return { spp: spp0, widened: false };
  const need = ((lastMs - prev.e) * margin) / (W / 2);
  const spp = lim(Math.min(Math.max(spp0, need), capMs / W));
  return { spp, widened: spp > spp0 };
}
