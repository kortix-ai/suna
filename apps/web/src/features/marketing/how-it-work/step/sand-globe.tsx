'use client';

import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';

/**
 * Sand on a vibrating sphere (port of `gen/globe.js` from
 * github.com/sutharjay1/fourier-series). Chladni patterns on a sphere are
 * spherical harmonics, f(θ, φ) = Pₗᵐ(cos θ) · cos(mφ): grains bounce where the
 * surface moves and rest on its nodal lines. Changing `mode` swaps the
 * harmonic, and the grains flow from the old pattern into the new one.
 *
 * One canvas, one rAF loop that only runs while the globe is on screen.
 * Reduced motion settles each pattern at once and draws it still: no spin, no
 * flow.
 */

/** (l, m) pairs, in the order `mode` walks them. */
const MODES: [number, number][] = [
  [6, 3],
  [5, 5],
  [8, 4],
  [7, 2],
  [9, 6],
  [6, 6],
  [10, 5],
  [8, 1],
];

/** Board values from the studio's globe preset. */
const DEFAULT_RADIUS = 0.44; // of the shorter side
const TILT = (24 * Math.PI) / 180;
const BACK_ALPHA = 0.18;
const GRAIN = 1.5; // px, square
const VIBRATION = 14; // px
const LOOSE = 2.4; // px
const TURN_SECONDS = 12;
const TONES = [1, 0.62, 0.34];

// Associated Legendre polynomial Pₗᵐ(x) by the standard recurrence.
function plm(l: number, m: number, x: number): number {
  let pmm = 1;
  if (m > 0) {
    const s = Math.sqrt(Math.max(0, (1 - x) * (1 + x)));
    let fact = 1;
    for (let i = 1; i <= m; i++) {
      pmm *= -fact * s;
      fact += 2;
    }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = (x * (2 * ll - 1) * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}

const norms = new Map<string, number>();
function normFor(l: number, m: number): number {
  const key = `${l},${m}`;
  let n = norms.get(key);
  if (n === undefined) {
    n = 1e-9;
    for (let i = 0; i <= 400; i++) n = Math.max(n, Math.abs(plm(l, m, -1 + i / 200)));
    norms.set(key, n);
  }
  return n;
}

/** Seeded so the first frame is the same on every visit. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sand = { th: Float32Array; ph: Float32Array; rand: () => number };

function spawn(count: number): Sand {
  const rand = mulberry32(7);
  const th = new Float32Array(count);
  const ph = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    th[i] = Math.acos(2 * rand() - 1);
    ph[i] = rand() * 2 * Math.PI;
  }
  return { th, ph, rand };
}

/** Moves every grain `steps` times toward the nodal lines of mode (l, m). */
function settle(sand: Sand, l: number, m: number, R: number, steps: number) {
  const norm = normFor(l, m);
  const f = (a: number, c: number) => (plm(l, m, Math.cos(a)) / norm) * Math.cos(m * c);
  const { th, ph, rand } = sand;
  const h = 0.004;
  const vib = VIBRATION / R;
  const loose = LOOSE / R;
  const TAU = 2 * Math.PI;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < th.length; i++) {
      const a = th[i];
      const c = ph[i];
      const sn = Math.max(0.05, Math.sin(a));
      const v = f(a, c);
      const ga = (f(a + h, c) - v) / h;
      const gc = (f(a, c + h) - v) / h / sn;
      const g2 = ga * ga + gc * gc + 1e-9;
      const kick = vib * Math.abs(v) + loose;
      let na = a - (0.5 * v * ga) / g2 + kick * (rand() - 0.5);
      const nc = c - (0.5 * v * gc) / g2 / sn + (kick * (rand() - 0.5)) / sn;
      if (na < 0) na = -na;
      if (na > Math.PI) na = TAU - na;
      th[i] = na;
      ph[i] = ((nc % TAU) + TAU) % TAU;
    }
  }
}

/** Orthographic draw: far side first and faint, near side on top in three tones. */
function draw(
  g: CanvasRenderingContext2D,
  sand: Sand,
  W: number,
  H: number,
  R: number,
  spin: number,
  ink: string,
) {
  const cx = W / 2;
  const cy = H / 2;
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);
  g.clearRect(0, 0, W, H);
  g.fillStyle = ink;
  for (const front of [false, true]) {
    for (let tone = 0; tone < TONES.length; tone++) {
      g.globalAlpha = TONES[tone] * (front ? 1 : BACK_ALPHA);
      for (let i = tone; i < sand.th.length; i += TONES.length) {
        const sa = Math.sin(sand.th[i]);
        const x = sa * Math.cos(sand.ph[i] + spin);
        const y = sa * Math.sin(sand.ph[i] + spin);
        const z = Math.cos(sand.th[i]);
        const depth = z * st + y * ct;
        if (depth <= 0 !== front) continue;
        const Y = z * ct - y * st;
        g.fillRect(cx + x * R - GRAIN / 2, cy - Y * R - GRAIN / 2, GRAIN, GRAIN);
      }
    }
  }
  g.globalAlpha = 1;
}

export function SandGlobe({
  mode,
  reduced,
  radius = DEFAULT_RADIUS,
  className,
}: {
  mode: number;
  reduced: boolean;
  /** Globe radius as a fraction of the canvas's shorter side. */
  radius?: number;
  className?: string;
}) {
  const radiusRef = useRef(radius);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;

    let W = 0;
    let H = 0;
    let sand: Sand | null = null;
    let settledMode = -1;
    let raf = 0;
    let last = 0;
    let time = 0;
    let onScreen = false;

    const ink = () => getComputedStyle(canvas).color;
    const current = () => MODES[((modeRef.current % MODES.length) + MODES.length) % MODES.length];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // About one grain per 6px² of globe disc, capped for low-end machines.
      const R = Math.min(W, H) * radiusRef.current;
      const count = Math.max(6000, Math.min(16000, Math.round((Math.PI * R * R) / 6)));
      if (!sand || sand.th.length !== count) {
        sand = spawn(count);
        settledMode = -1;
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!sand || W === 0) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const [l, m] = current();
      const R = Math.min(W, H) * radiusRef.current;
      const key = MODES.indexOf(current());
      if (settledMode === -1) {
        settle(sand, l, m, R, 90); // a fresh pile settles before its first paint
        settledMode = key;
      } else if (reduced && settledMode !== key) {
        settle(sand, l, m, R, 90);
        settledMode = key;
      } else if (!reduced) {
        settle(sand, l, m, R, Math.max(1, Math.round(dt * 60)));
        settledMode = key;
      }
      if (!reduced) time += dt;
      draw(g, sand, W, H, R, (2 * Math.PI * time) / TURN_SECONDS, ink());
      if (onScreen && !reduced) raf = requestAnimationFrame(frame);
    };

    const kick = () => {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };

    const ro = new ResizeObserver(() => {
      resize();
      kick();
    });
    ro.observe(canvas);
    canvas.addEventListener('sandglobe:mode', kick);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) kick();
    });
    io.observe(canvas);

    return () => {
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('sandglobe:mode', kick);
      cancelAnimationFrame(raf);
    };
  }, [reduced]);

  // The loop reads the mode from a ref so a mode change never rebuilds the
  // sand. Reduced motion draws once per mode, so it also asks for a frame.
  useEffect(() => {
    modeRef.current = mode;
    if (reduced) canvasRef.current?.dispatchEvent(new Event('sandglobe:mode'));
  }, [mode, reduced]);

  return <canvas ref={canvasRef} aria-hidden className={cn('text-foreground block h-full w-full', className)} />;
}
