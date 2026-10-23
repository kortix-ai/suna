'use client';

import type { CSSProperties } from 'react';

import { cn } from '../lib/utils';
import { PIXEL_MARK_SIZE, pixelMark } from '../lib/pixel-mark';

/** Mark size → tile size. The mark is a multiple of 7, so each pixel lands on
 *  whole device pixels; any other size blurs the edges. Literal px because
 *  this repo's spacing scale is 0.23rem (`size-14` is 51.5px, not 56px). */
const TILE = { 14: 20, 21: 28, 28: 40, 42: 56, 56: 80 } as const;
export type AgentMarkSize = keyof typeof TILE;

/**
 * The tile colours as CSS variables. `light-dark()` follows the
 * `color-scheme` each theme sets in tokens.css, so one pair covers both themes.
 * Set on the element that paints the tile; `AgentMarkGlyph` reads `--mark-ink`.
 */
export function agentMarkVars(slug: string): CSSProperties {
  const { tone } = pixelMark(slug);
  return {
    '--mark-tile': `light-dark(${tone.tile}, ${tone.tileDark})`,
    '--mark-ink': `light-dark(${tone.ink}, ${tone.inkDark})`,
  } as CSSProperties;
}

/** The bare pixel figure, painted with `--mark-ink` from an ancestor. */
export function AgentMarkGlyph({ slug, size }: { slug: string; size: AgentMarkSize }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${PIXEL_MARK_SIZE} ${PIXEL_MARK_SIZE}`}
      shapeRendering="crispEdges"
      className="shrink-0"
    >
      <path d={pixelMark(slug).path} className="fill-(--mark-ink)" />
    </svg>
  );
}

/**
 * An agent's pixel mark on its tile — the agent's face wherever it appears:
 * pickers, rows, chips. Same slug, same mark (see `pixel-mark.ts`).
 */
export function AgentMark({
  slug,
  size = 14,
  tile = TILE[size],
  className,
}: {
  slug: string;
  size?: AgentMarkSize;
  /** Tile edge in px, when the tile must match a neighbour's height. */
  tile?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ ...agentMarkVars(slug), width: tile, height: tile }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-(--mark-tile)',
        size >= 28 ? 'rounded-md' : 'rounded-sm',
        className,
      )}
    >
      <AgentMarkGlyph slug={slug} size={size} />
    </span>
  );
}
