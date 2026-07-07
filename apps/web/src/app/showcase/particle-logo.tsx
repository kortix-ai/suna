'use client';

import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';

import {
  breathePulse,
  clamp01,
  easeInOutCubic,
  mulberry32,
  samplePixelHomes,
} from './particle-logo-math';

/**
 * Particle Assembly — a Rauch-style hard-pixel rendering of the Kortix symbol.
 * Pixels materialize by easing inward from an expanded state, then the whole
 * mark *breathes* (a radial wave eases it open and closed forever), and the
 * cursor shoves nearby pixels away — they spring back home. Honours
 * prefers-reduced-motion with a static mark.
 */

const BRANDMARK_SRC = '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg';
const ORANGE_RATIO = 0.12;
const INTRO_MS = 1000;

type Pixel = {
  hx: number;
  hy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  orange: boolean;
};

function resolveColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(probe);
  probe.style.color = `var(${varName})`;
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || fallback;
}

export function ParticleLogo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: 0, y: 0, vx: 0, vy: 0, active: false });
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rng = mulberry32(0x50f7);
    const fg = resolveColor('--foreground', isDark ? '#fafafa' : '#0a0a0a');
    const orange = resolveColor('--kortix-orange', '#e08a33');

    let dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    let pixels: Pixel[] = [];
    let cx = 0;
    let cy = 0;
    let stride = 3;
    let pixelSize = 2;
    let raf = 0;
    let start = 0;
    let disposed = false;

    const img = new Image();
    img.decoding = 'async';
    let imageReady = false;

    const build = () => {
      if (!imageReady) return;
      dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      stride = 3 * dpr;
      pixelSize = 2 * dpr;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.imageSmoothingEnabled = false;
      cx = canvas.width / 2;
      cy = canvas.height / 2;

      const aspect = img.naturalWidth / img.naturalHeight || 1;
      const short = Math.min(canvas.width, canvas.height);
      let targetH = short * 0.56;
      let targetW = targetH * aspect;
      if (targetW > canvas.width * 0.7) {
        targetW = canvas.width * 0.7;
        targetH = targetW / aspect;
      }
      targetW = Math.round(targetW);
      targetH = Math.round(targetH);

      const off = document.createElement('canvas');
      off.width = targetW;
      off.height = targetH;
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.drawImage(img, 0, 0, targetW, targetH);
      const data = octx.getImageData(0, 0, targetW, targetH).data;

      const offsetX = (canvas.width - targetW) / 2;
      const offsetY = (canvas.height - targetH) / 2;
      const homes = samplePixelHomes(
        targetW,
        targetH,
        stride,
        (x, y) => data[(y * targetW + x) * 4 + 3],
      );

      pixels = homes.map((home) => {
        const hx = Math.round((offsetX + home.x) / dpr) * dpr;
        const hy = Math.round((offsetY + home.y) / dpr) * dpr;
        // Start expanded (scaled out from centre) so the mark eases inward.
        return {
          hx,
          hy,
          x: cx + (hx - cx) * 1.55,
          y: cy + (hy - cy) * 1.55,
          vx: 0,
          vy: 0,
          orange: rng() < ORANGE_RATIO,
        };
      });
      start = 0;
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass === 1 ? orange : fg;
        for (const p of pixels) {
          if (p.orange !== (pass === 1)) continue;
          ctx.fillRect(p.hx, p.hy, pixelSize, pixelSize);
        }
      }
    };

    const frame = (now: number) => {
      if (disposed) return;
      if (!start) start = now;
      const elapsed = now - start;
      const intro = easeInOutCubic(clamp01(elapsed / INTRO_MS));

      const period = 1600;
      const breatheAmp = 0.09;
      const stiff = 0.09;
      const damp = 0.82;
      const radius = 95 * dpr;
      const radius2 = radius * radius;
      const force = 3.2 * dpr;
      const maxVel = 34 * dpr;
      const ptr = pointer.current;
      // One uniform scale for the whole mark: intro contracts 1.55 → 1, then a
      // gentle breathe pulses around 1. Scaling around the centre keeps shape.
      const scale = 1 + (1 - intro) * 0.55 + intro * breatheAmp * breathePulse(now, period);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = intro;

      for (let pass = 0; pass < 2; pass++) {
        const drawingOrange = pass === 1;
        ctx.fillStyle = drawingOrange ? orange : fg;
        for (const p of pixels) {
          if (p.orange !== drawingOrange) continue;

          const tx = cx + (p.hx - cx) * scale;
          const ty = cy + (p.hy - cy) * scale;

          if (ptr.active) {
            const dx = p.x - ptr.x;
            const dy = p.y - ptr.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < radius2) {
              const d = Math.sqrt(d2) || 1;
              const falloff = 1 - d / radius;
              const f = falloff * falloff;
              p.vx += (dx / d) * f * force + ptr.vx * f * 0.9;
              p.vy += (dy / d) * f * force + ptr.vy * f * 0.9;
            }
          }

          p.vx += (tx - p.x) * stiff;
          p.vy += (ty - p.y) * stiff;
          p.vx *= damp;
          p.vy *= damp;

          const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
          if (v > maxVel) {
            p.vx = (p.vx / v) * maxVel;
            p.vy = (p.vy / v) * maxVel;
          }

          p.x += p.vx;
          p.y += p.vy;

          const sx = Math.round(p.x / dpr) * dpr;
          const sy = Math.round(p.y / dpr) * dpr;
          ctx.fillRect(sx, sy, pixelSize, pixelSize);
        }
      }

      ctx.globalAlpha = 1;
      ptr.vx *= 0.6;
      ptr.vy *= 0.6;
      raf = requestAnimationFrame(frame);
    };

    const onResize = () => {
      build();
      if (reduceMotion) drawStatic();
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      pointer.current.vx += x - pointer.current.x;
      pointer.current.vy += y - pointer.current.y;
      pointer.current.x = x;
      pointer.current.y = y;
      pointer.current.active = true;
    };
    const onPointerLeave = () => {
      pointer.current.active = false;
      pointer.current.vx = 0;
      pointer.current.vy = 0;
    };

    img.onload = () => {
      imageReady = true;
      build();
      if (reduceMotion) drawStatic();
      else raf = requestAnimationFrame(frame);
    };
    img.src = BRANDMARK_SRC;

    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointercancel', onPointerLeave);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointercancel', onPointerLeave);
    };
  }, [isDark]);

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full touch-none [image-rendering:pixelated]"
      role="img"
      aria-label="Kortix"
    />
  );
}
