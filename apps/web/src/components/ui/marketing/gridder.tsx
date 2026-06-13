'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { HyperText } from '../hyper-text';

interface GridCell {
  id: string;
  word: string | null;
}

interface KortixGridProps {
  count?: number;
  cols?: number;
  rows?: number;
  words?: string[];
  seed?: number;
  gradient?: string;
  speed?: number;
}

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

export default function KortixGrid({
  count,
  cols = 9,
  rows = 12,
  words = ['kortix'],
  seed = 1,
  gradient = 'linear-gradient(to top left, var(--kortix-green), var(--kortix-purple), var(--kortix-green))',
  speed = 15,
}: KortixGridProps) {
  const gridItems = useMemo(() => {
    const totalCells = cols * rows;
    const cells: GridCell[] = new Array(totalCells).fill(null).map((_, i) => ({
      id: `cell-${i}`,
      word: null,
    }));

    const cellsToFill = Math.min(Math.max(0, count ?? Math.floor(totalCells * 0.6)), totalCells);
    const rng = createRng(seed);
    const usedIndices = new Set<number>();

    for (let i = 0; i < cellsToFill; i++) {
      let index = Math.floor(rng() * totalCells);

      while (usedIndices.has(index)) {
        index = Math.floor(rng() * totalCells);
      }

      cells[index].word = words[Math.floor(rng() * words.length)];
      usedIndices.add(index);
    }

    return cells;
  }, [count, cols, rows, words, seed]);

  const containerRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const tileRef = useRef(0);

  const reflowGradient = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.offsetWidth;
    const height = container.offsetHeight;
    const sizeValue = `${width}px ${height}px`;
    tileRef.current = width;

    const offsets: Array<{ el: HTMLSpanElement; left: number; top: number }> = [];
    for (const el of wordRefs.current) {
      if (!el) continue;
      offsets.push({ el, left: el.offsetLeft, top: el.offsetTop });
    }

    for (const { el, left, top } of offsets) {
      el.style.backgroundSize = sizeValue;
      el.style.backgroundPosition = `calc(${-left}px - var(--grid-flow, 0px)) ${-top}px`;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      container.style.setProperty('--grid-flow', '0px');
      return;
    }

    let raf = 0;
    let start: number | null = null;
    const periodMs = Math.max(speed, 0.1) * 1000;

    const tick = (now: number) => {
      if (start === null) start = now;
      const phase = ((now - start) % periodMs) / periodMs;
      container.style.setProperty('--grid-flow', `${phase * tileRef.current}px`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed]);

  useLayoutEffect(() => {
    reflowGradient();

    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => reflowGradient());
    observer.observe(container);
    return () => observer.disconnect();
  }, [reflowGradient, gridItems]);

  return (
    <div className="flex w-full items-center justify-center overflow-hidden p-4">
      <div
        ref={containerRef}
        className="relative grid h-full w-full gap-4"
        style={
          {
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            '--grid-gradient': gradient,
          } as React.CSSProperties
        }
      >
        {gridItems.map((cell, i) => (
          <div key={cell.id} className="flex min-w-0 items-center justify-center overflow-hidden">
            {cell.word && (
              <span
                ref={(el) => {
                  wordRefs.current[i] = el;
                }}
                className="bg-clip-text font-mono text-xs font-medium tracking-wider whitespace-nowrap text-transparent sm:text-sm"
                style={{
                  backgroundImage: 'var(--grid-gradient)',
                  backgroundRepeat: 'repeat-x',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                <HyperText variant="lowercase">{cell.word}</HyperText>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
