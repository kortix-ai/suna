'use client';

import { useRef } from 'react';

import { flowAngle } from './mark-math';
import { MARK_CANVAS_CLASS, MarkStage } from './mark-stage';
import { createSymbolPath, useCanvasScene } from './use-canvas';

// Ambient currents flow across the whole frame (dim). The Kortix mark is NEVER
// drawn — no outline, no stroke, no fill. It only appears where the currents
// touch its edge, glowing softly in Kortix orange, so the logo forms from the
// glow alone and fades where the flow has moved on.
const FADE = 'rgba(10,10,10,0.06)';
const AMBIENT = 'rgba(220,220,220,0.12)';
const AMBIENT_ORANGE = 'rgba(224,138,51,0.2)';

const COUNT = 2400;
const EDGE_RATIO = 0.42;
const SPEED = 1.0;
const EDGE_BAND = 6;
const AMBIENT_ORANGE_RATIO = 0.08;
const GLOW_ORANGE_RATIO = 0.78;
const GLOW_SIZE = 6;
const GLOW_ALPHA = 0.3;
const REVEAL_MS = 1800;
const SYMBOL_ASPECT = 30 / 25;

type Particle = { x: number; y: number; life: number; tint: number; edge: boolean };

type Fitted = {
  key: string;
  x0: number;
  y0: number;
  w: number;
  h: number;
  edge: Uint8ClampedArray;
  mw: number;
  mh: number;
  edgePoints: Float32Array;
};

function makeGlow(inner: string): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = 32;
  sprite.height = 32;
  const g = sprite.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return sprite;
}

export type KortixCurrentsProps = { className?: string };

/**
 * Kortix Currents — a full-frame flow field with the Kortix mark hidden in the
 * centre (never stroked or filled). Wherever the currents touch the mark's edge
 * they glow softly in Kortix orange, so the logo forms out of the glow and
 * fades as the flow moves on. Eases in over the first ~1.8s.
 */
export function KortixCurrents({ className }: KortixCurrentsProps) {
  const symbol = useRef<Path2D | null>(null);
  const fitted = useRef<Fitted | null>(null);
  const particles = useRef<Particle[] | null>(null);
  const glowWhite = useRef<HTMLCanvasElement | null>(null);
  const glowOrange = useRef<HTMLCanvasElement | null>(null);
  const startAt = useRef<number | null>(null);
  const reduce = useRef<boolean | null>(null);
  const painted = useRef(false);

  const { containerRef, canvasRef } = useCanvasScene(({ ctx, width, height, now }) => {
    if (reduce.current === null) {
      reduce.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    if (!symbol.current) symbol.current = createSymbolPath();
    if (!glowWhite.current) glowWhite.current = makeGlow('rgba(255,255,255,0.85)');
    if (!glowOrange.current) glowOrange.current = makeGlow('rgba(240,150,62,0.95)');
    const gw = glowWhite.current;
    const go = glowOrange.current;

    const size = Math.min(height * 0.64, (width * 0.64) / SYMBOL_ASPECT);
    const w = size * SYMBOL_ASPECT;
    const h = size;
    const x0 = (width - w) / 2;
    const y0 = (height - h) / 2;
    const key = `${Math.round(width)}x${Math.round(height)}`;

    if (!fitted.current || fitted.current.key !== key) {
      const scale = size / 25;
      const mw = Math.max(1, Math.ceil(w));
      const mh = Math.max(1, Math.ceil(h));
      const off = document.createElement('canvas');
      off.width = mw;
      off.height = mh;
      const octx = off.getContext('2d');
      const alpha = new Uint8ClampedArray(mw * mh);
      if (octx) {
        octx.scale(scale, scale);
        octx.fill(symbol.current);
        const data = octx.getImageData(0, 0, mw, mh).data;
        for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
      }
      const isIn = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < mw && y < mh && alpha[y * mw + x] > 40;
      const edge = new Uint8ClampedArray(mw * mh);
      const pts: number[] = [];
      const d = EDGE_BAND;
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          if (alpha[y * mw + x] <= 40) continue;
          if (!isIn(x + d, y) || !isIn(x - d, y) || !isIn(x, y + d) || !isIn(x, y - d)) {
            edge[y * mw + x] = 1;
            pts.push(x0 + x, y0 + y);
          }
        }
      }
      fitted.current = { key, x0, y0, w, h, edge, mw, mh, edgePoints: new Float32Array(pts) };
      particles.current = null;
      painted.current = false;
    }

    const fit = fitted.current;
    const inEdge = (x: number, y: number) => {
      const lx = Math.floor(x - fit.x0);
      const ly = Math.floor(y - fit.y0);
      if (lx < 0 || ly < 0 || lx >= fit.mw || ly >= fit.mh) return false;
      return fit.edge[ly * fit.mw + lx] === 1;
    };

    if (reduce.current) {
      if (painted.current) return;
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = GLOW_ALPHA;
      const ep = fit.edgePoints;
      for (let i = 0; i < ep.length; i += 2) {
        const sprite = (i / 2) % 5 < 4 ? go : gw;
        ctx.drawImage(
          sprite,
          ep[i] - GLOW_SIZE / 2,
          ep[i + 1] - GLOW_SIZE / 2,
          GLOW_SIZE,
          GLOW_SIZE,
        );
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      painted.current = true;
      return;
    }

    const spawnAmbient = (): Particle => ({
      x: Math.random() * width,
      y: Math.random() * height,
      life: 100 + Math.random() * 260,
      tint: Math.random(),
      edge: false,
    });
    const spawnEdge = (): Particle => {
      const ep = fit.edgePoints;
      if (ep.length === 0) return spawnAmbient();
      const i = Math.floor(Math.random() * (ep.length / 2)) * 2;
      return {
        x: ep[i] + (Math.random() - 0.5) * 3,
        y: ep[i + 1] + (Math.random() - 0.5) * 3,
        life: 60 + Math.random() * 160,
        tint: Math.random(),
        edge: true,
      };
    };

    if (!particles.current) {
      const edgeCount = Math.round(COUNT * EDGE_RATIO);
      particles.current = Array.from({ length: COUNT }, (_, i) =>
        i < edgeCount ? spawnEdge() : spawnAmbient(),
      );
    }
    const points = particles.current;
    if (startAt.current === null) startAt.current = now;
    const revealRaw = Math.min(1, (now - startAt.current) / REVEAL_MS);
    const reveal = 1 - Math.pow(1 - revealRaw, 3);
    const t = now / 4200;

    ctx.fillStyle = FADE;
    ctx.fillRect(0, 0, width, height);

    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    for (const p of points) {
      const angle = flowAngle(p.x, p.y, t);
      const nx = p.x + Math.cos(angle) * SPEED;
      const ny = p.y + Math.sin(angle) * SPEED;
      ctx.strokeStyle = p.tint < AMBIENT_ORANGE_RATIO ? AMBIENT_ORANGE : AMBIENT;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      p.x = nx;
      p.y = ny;
      p.life -= 1;
      if (p.life <= 0 || nx < -10 || nx > width + 10 || ny < -10 || ny > height + 10) {
        Object.assign(p, p.edge ? spawnEdge() : spawnAmbient());
      }
    }

    // The mark is only the glow where currents touch its edge — no stroke.
    ctx.globalCompositeOperation = 'lighter';
    for (const p of points) {
      if (!inEdge(p.x, p.y)) continue;
      ctx.globalAlpha = reveal * GLOW_ALPHA;
      const sprite = p.tint < GLOW_ORANGE_RATIO ? go : gw;
      ctx.drawImage(sprite, p.x - GLOW_SIZE / 2, p.y - GLOW_SIZE / 2, GLOW_SIZE, GLOW_SIZE);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  });

  return (
    <MarkStage containerRef={containerRef} tone="ink" className={className}>
      <canvas ref={canvasRef} className={MARK_CANVAS_CLASS} />
    </MarkStage>
  );
}
