'use client';

import { KORTIX_BULLET_GRADIENT } from '@/components/ui/kortix-asterisk';
import type { CSSProperties } from 'react';

/* ───────────────────────────────────────────────────────────────────────────
 * Terminal rendering primitives — the styled-span model from cli-demo.tsx,
 * extracted so the CLI director and the floating terminal share one renderer.
 * A `Line` is an array of colored `Span`s; the director streams lines into a
 * scrollback buffer and `LineView` paints them in the real kortix CLI palette.
 * ─────────────────────────────────────────────────────────────────────────── */

export type Color = 'cyan' | 'green' | 'amber' | 'red' | 'fg' | 'dim' | 'faded';

export type Span = { t: string; c?: Color | 'kortix' | 'cursor' };
export type Line = Span[];

const COLOR: Record<Color, string> = {
  cyan: 'text-cyan-500 dark:text-cyan-400',
  green: 'text-emerald-500',
  amber: 'text-amber-500',
  red: 'text-red-500',
  fg: 'text-foreground',
  dim: 'text-muted-foreground',
  faded: 'text-muted-foreground/45',
};

/** Flowing kortix-green gradient used for `kortix …` command text + selections. */
export const KORTIX_CMD_CLASS =
  'animate-kortix-bullet-flow inline-block bg-size-[100%_300%] bg-clip-text text-transparent';

export const KORTIX_CMD_STYLE: CSSProperties = {
  backgroundImage: KORTIX_BULLET_GRADIENT,
  backgroundSize: '100% 300%',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: 'transparent',
};

/** Span constructor. `t('Shipped', 'fg')`. */
export const t = (text: string, c?: Color | 'kortix' | 'cursor'): Span => ({ t: text, c });

/** A green `✓` status line, e.g. `ok(t('kortix.toml verified'))`. */
export const ok = (...spans: Span[]): Line => [t('  '), t('✓', 'green'), t('  '), ...spans];

/** A two-column meta row: `  repo  git.kortix.com/…`. */
export const meta = (label: string, value: string, c: Color = 'faded'): Line => [
  t(`  ${label.padEnd(8)}`, 'dim'),
  t(value, c),
];

export const CURSOR: Span = { t: '', c: 'cursor' };

/** Wrap plain `Line[]` into the prompt's `$ ` command form (or a `#` note). */
export const cmdLine = (input: string, note = false): Line =>
  note ? [t(input, 'faded')] : [t('$ ', 'faded'), t(input, 'kortix')];

export function LineView({ line }: { line: Line }) {
  return (
    <div className="break-words whitespace-pre-wrap">
      {line.length === 0
        ? ' '
        : line.map((s, i) =>
            s.c === 'kortix' ? (
              <span key={i} className={KORTIX_CMD_CLASS} style={KORTIX_CMD_STYLE}>
                {s.t}
              </span>
            ) : s.c === 'cursor' ? (
              <span
                key={i}
                aria-hidden
                className="bg-foreground/70 ml-px inline-block h-[1.05em] w-[0.5em] translate-y-[0.12em] animate-pulse"
              />
            ) : (
              <span key={i} className={s.c ? COLOR[s.c] : undefined}>
                {s.t}
              </span>
            ),
          )}
    </div>
  );
}
