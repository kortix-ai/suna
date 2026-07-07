'use client';

import { useEffect, useRef } from 'react';

import { KORTIX_SYMBOL_PATH, SYMBOL_HEIGHT, SYMBOL_WIDTH } from './mark-math';

export type Pointer = { x: number; y: number; active: boolean };

export type SceneFrame = (args: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  now: number;
  pointer: Pointer;
}) => void;

/**
 * Boilerplate for a DPR-crisp, auto-resizing 2D canvas that fills its container
 * and runs an rAF loop, with pointer tracking in local coordinates. The latest
 * `onFrame` is always used (kept in a ref) so callers don't need stable
 * identities. Returns refs to spread onto a container + canvas.
 */
export function useCanvasScene(onFrame: SceneFrame) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let disposed = false;
    const pointer: Pointer = { x: 0, y: 0, active: false };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.active = true;
    };
    const onLeave = () => {
      pointer.active = false;
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointercancel', onLeave);

    const loop = (now: number) => {
      if (disposed) return;
      frameRef.current({ ctx, width, height, now, pointer });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointercancel', onLeave);
    };
  }, []);

  return { containerRef, canvasRef };
}

export function createSymbolPath(): Path2D {
  return new Path2D(KORTIX_SYMBOL_PATH);
}

/**
 * Draw the Kortix symbol centred at (cx, cy) sized to `size` px tall, optionally
 * rotated. `mode` fills (solid) or strokes (outline echo).
 */
export function drawSymbol(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  cx: number,
  cy: number,
  size: number,
  options: { rotate?: number; mode?: 'fill' | 'stroke'; lineWidth?: number } = {},
): void {
  const { rotate = 0, mode = 'fill', lineWidth = 1 } = options;
  const scale = size / SYMBOL_HEIGHT;
  ctx.save();
  ctx.translate(cx, cy);
  if (rotate) ctx.rotate(rotate);
  ctx.scale(scale, scale);
  ctx.translate(-SYMBOL_WIDTH / 2, -SYMBOL_HEIGHT / 2);
  if (mode === 'stroke') {
    ctx.lineWidth = lineWidth / scale;
    ctx.stroke(path);
  } else {
    ctx.fill(path);
  }
  ctx.restore();
}

export type MarkPalette = { fg: string; orange: string; muted: string };

/**
 * Resolve the live theme colours from CSS variables (accurate to the current
 * light/dark theme). Call inside an effect keyed on the theme so it re-reads on
 * toggle. Falls back to sensible neutrals if a variable is unset.
 */
export function readMarkPalette(): MarkPalette {
  if (typeof document === 'undefined') {
    return { fg: '#141414', orange: '#e08a33', muted: 'rgba(20,20,20,0.16)' };
  }
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(probe);
  const read = (variable: string, fallback: string) => {
    probe.style.color = `var(${variable})`;
    return getComputedStyle(probe).color || fallback;
  };
  const palette: MarkPalette = {
    fg: read('--foreground', '#141414'),
    orange: read('--kortix-orange', '#e08a33'),
    muted: read('--muted-foreground', '#8a8a8a'),
  };
  probe.remove();
  return palette;
}
