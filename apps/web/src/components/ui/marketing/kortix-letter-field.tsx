'use client';

import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type GridLayout,
  type Token,
  buildFieldSvg,
  buildTokens,
  computeGrid,
  svgToDataUri,
} from './kortix-letter-field.cells';

export interface KortixLetterFieldProps {
  seed?: number;
  className?: string;
}

export function KortixLetterField({ seed = 3382, className }: KortixLetterFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<GridLayout>(() => computeGrid(1200, 800));
  // Resolved foreground color + dark-mode flag, read live from the container so
  // the SVG (rendered as a background image, which can't use `currentColor`)
  // still tracks `--foreground` and theme toggles.
  const [color, setColor] = useState('rgb(20,20,20)');
  const [isDark, setIsDark] = useState(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const readColor = () => {
      const resolved = window.getComputedStyle(el).color;
      setColor(resolved || 'rgb(20,20,20)');
      // `.dark` is the theme class (see globals.css `@custom-variant dark`).
      setIsDark(
        el.closest('.dark') !== null || document.documentElement.classList.contains('dark'),
      );
    };

    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      setGrid(computeGrid(width, height));
      readColor();
    };

    update();
    readColor();

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(el);
    }

    // Re-read color on theme toggle (the `.dark` class flips `--foreground`).
    const themeObserver =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(readColor) : null;
    if (themeObserver) {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    return () => {
      observer?.disconnect();
      themeObserver?.disconnect();
    };
  }, []);

  const tokens = useMemo<Token[]>(
    () => buildTokens(grid.tokenCount, seed),
    [grid.tokenCount, seed],
  );

  // Render the letter field as a CSS `background-image` SVG. The decorative
  // tokens live ONLY inside the SVG image — they never appear as text in the
  // DOM (not even in `innerText`), so Google's SERP snippet extractor cannot
  // reach them. This fixes the garbled brand-snippet regression where the old
  // `<span>` grid leaked scrambled `t p e x 1 o c i0…` tokens into the page's
  // text content. See `kortix-letter-field.cells.ts` for the pure helpers
  // (and `kortix-letter-field.cells.test.ts` for the coverage).
  const backgroundImage = useMemo(() => {
    const svg = buildFieldSvg(tokens, grid, color, isDark);
    return `url("${svgToDataUri(svg)}")`;
  }, [tokens, grid, color, isDark]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
        ref={containerRef}
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden select-none text-foreground',
          className,
        )}
        aria-hidden
        data-a11y-decorative
        style={{
          backgroundImage,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          backgroundSize: 'cover',
        }}
      />
    </AnimatePresence>
  );
}
