'use client';

import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

const SOURCE = '01kortixcomputer';
const PROPER = SOURCE.split('').join(' ');
const KORTIX = 'kortix'.split('').join(' ');

function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSpaces(chars: string, rng: () => number) {
  const arr = chars.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join(' ');
}

type TokenKind = 'scrambled' | 'proper' | 'kortix';

interface Token {
  text: string;
  kind: TokenKind;
}

function buildTokens(count: number, seed: number): Token[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => {
    const roll = rng();
    if (roll < 0.06) return { text: KORTIX, kind: 'kortix' as const };
    if (roll < 0.14) return { text: PROPER, kind: 'proper' as const };
    return { text: shuffleWithSpaces(SOURCE, rng), kind: 'scrambled' as const };
  });
}

interface GridLayout {
  cols: number;
  rows: number;
  tokenCount: number;
}

function computeGrid(width: number, height: number): GridLayout {
  const cellHeightPx = width < 640 ? 12 : 14;
  const gapX = 4;
  const gapY = 2;
  const padding = width < 640 ? 16 : 24;
  const innerWidth = Math.max(0, width - padding);
  const innerHeight = Math.max(0, height - padding);

  // Wide enough for "k o r t i x" (smallest highlighted token) without clipping.
  const minCellWidthPx = width < 640 ? 76 : width < 1024 ? 84 : 92;

  const cols = Math.max(1, Math.floor((innerWidth + gapX) / (minCellWidthPx + gapX)));
  const rows = Math.max(1, Math.ceil((innerHeight + gapY) / (cellHeightPx + gapY)));

  return { cols, rows, tokenCount: cols * rows };
}

interface KortixLetterFieldProps {
  seed?: number;
  className?: string;
}

export function KortixLetterField({ seed = 3382, className }: KortixLetterFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<GridLayout>(() => computeGrid(1200, 800));

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      setGrid(computeGrid(width, height));
    };

    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tokens = useMemo(() => buildTokens(grid.tokenCount, seed), [grid.tokenCount, seed]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
        ref={containerRef}
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden select-none',
          className,
        )}
        aria-hidden
      >
        <div
          className="box-border grid h-full w-full gap-x-1 gap-y-0.5 p-2 font-mono text-[8px] leading-none tracking-[0.12em] sm:p-3 sm:text-[9px] md:text-[10px]"
          style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}
        >
          {tokens.map((token, i) => (
            <span
              key={i}
              className={cn(
                'block min-w-0 whitespace-nowrap',
                token.kind === 'kortix' &&
                  'text-foreground/90 dark:text-foreground/50 hyper-text font-medium',
                token.kind === 'proper' && 'text-foreground/35 overflow-hidden',
                token.kind === 'scrambled' &&
                  'text-foreground/20 dark:text-foreground/14 overflow-hidden',
              )}
            >
              {token.text}
            </span>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
