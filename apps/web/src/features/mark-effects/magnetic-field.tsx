'use client';

import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';

import { proximityFalloff } from './mark-math';
import { MARK_CANVAS_CLASS, MarkStage } from './mark-stage';
import {
  createSymbolPath,
  drawSymbol,
  readMarkPalette,
  useCanvasScene,
  type MarkPalette,
} from './use-canvas';

const CELL = 54;

export type MagneticFieldProps = { className?: string };

/**
 * A grid of Kortix marks that lean into your cursor — they grow, tilt, and warm
 * to Kortix orange within a falloff radius, and breathe gently when idle.
 */
export function MagneticField({ className }: MagneticFieldProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const palette = useRef<MarkPalette>({
    fg: '#141414',
    orange: '#e08a33',
    muted: 'rgba(20,20,20,0.16)',
  });
  const pathRef = useRef<Path2D | null>(null);

  useEffect(() => {
    palette.current = readMarkPalette();
  }, [isDark]);

  const { containerRef, canvasRef } = useCanvasScene(({ ctx, width, height, now, pointer }) => {
    if (!pathRef.current) pathRef.current = createSymbolPath();
    const path = pathRef.current;
    const { fg, orange } = palette.current;

    ctx.clearRect(0, 0, width, height);

    const cols = Math.max(3, Math.round(width / CELL));
    const rows = Math.max(2, Math.round(height / CELL));
    const cw = width / cols;
    const ch = height / rows;
    const base = Math.min(cw, ch) * 0.42;
    const radius = Math.min(width, height) * 0.42;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = cw * (col + 0.5);
        const y = ch * (row + 0.5);
        const f = pointer.active
          ? proximityFalloff(Math.hypot(x - pointer.x, y - pointer.y), radius)
          : 0;
        const idle = pointer.active
          ? 0
          : (0.5 + 0.5 * Math.sin(now / 900 + (col + row) * 0.55)) * 0.12;
        const size = base * (0.68 + f * 1.3 + idle);
        const rotate = f * 0.9;

        ctx.fillStyle = fg;
        ctx.globalAlpha = 0.2 + f * 0.5 + idle;
        drawSymbol(ctx, path, x, y, size, { rotate });

        if (f > 0.02) {
          ctx.fillStyle = orange;
          ctx.globalAlpha = f;
          drawSymbol(ctx, path, x, y, size, { rotate });
        }
      }
    }

    ctx.globalAlpha = 1;
  });

  return (
    <MarkStage containerRef={containerRef} className={className}>
      <canvas ref={canvasRef} className={MARK_CANVAS_CLASS} />
    </MarkStage>
  );
}
