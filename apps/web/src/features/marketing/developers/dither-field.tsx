'use client';

import { ShaderSafe } from '@/components/ui/shader-safe';
import { cn } from '@/lib/utils';
import { useInView, useReducedMotion } from 'motion/react';
import { useTheme } from 'next-themes';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

const Dithering = dynamic(() => import('@paper-design/shaders-react').then((m) => m.Dithering), {
  ssr: false,
});

const FILL = { position: 'absolute', inset: 0, width: '100%', height: '100%' } as const;

/** Resolves a CSS color (any syntax the browser parses) to `[r, g, b]` through a 1px canvas. */
function resolveRgb(color: string): [number, number, number] | null {
  if (!color) return null; // an unset token would paint black ink
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/**
 * Live dither field in the theme's `--foreground` ink on a transparent ground.
 * Fills its positioned parent; the caller sets the fade mask and opacity via
 * `className`. Static (speed 0) under `prefers-reduced-motion` and while offscreen.
 */
export function DitherField({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [ink, setInk] = useState<[number, number, number] | null>(null);

  // Wait one frame so next-themes has already flipped the `dark` class.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--foreground');
      setInk(resolveRgb(fg.trim()));
    });
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  return (
    <div ref={ref} aria-hidden className={cn('pointer-events-none absolute inset-0', className)}>
      {ink && (
        <ShaderSafe>
          <Dithering
            colorBack={`rgba(${ink.join(',')},0)`}
            colorFront={`rgb(${ink.join(',')})`}
            shape="warp"
            type="4x4"
            size={2}
            speed={reduceMotion || !inView ? 0 : 0.4}
            maxPixelCount={1280 * 720}
            style={FILL}
          />
        </ShaderSafe>
      )}
    </div>
  );
}
