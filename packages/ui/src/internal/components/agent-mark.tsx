'use client';

import type { CSSProperties } from 'react';

import { cn } from '../lib/utils';
import { Hint } from '../../primitives/hint';
import { isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';
import { pixelMark } from '../lib/pixel-mark';

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
  // The Kortix tile (My Kortix, the starter `kortix` agent) follows the Kortix
  // tile rule: the page surface with a hairline, never an inverted black tile
  // (decisions.md #8421). `agentMarkTileClass` adds the hairline.
  if (tone.name === 'brand') {
    return { '--mark-tile': 'var(--background)', '--mark-ink': 'var(--foreground)' } as CSSProperties;
  }
  return {
    '--mark-tile': `light-dark(${tone.tile}, ${tone.tileDark})`,
    '--mark-ink': `light-dark(${tone.ink}, ${tone.inkDark})`,
  } as CSSProperties;
}

/** The tile's boundary: a hairline on the Kortix tile, none on a tinted one. */
export function agentMarkTileClass(slug: string): string | undefined {
  return pixelMark(slug).tone.name === 'brand' ? 'ring-1 ring-inset ring-border' : undefined;
}

/** The bare pixel figure, painted with `--mark-ink` from an ancestor. A 7 × 7
 *  mark fills `size`; a wider reserved grid (My Kortix's 12 × 10 symbol) keeps
 *  whole-pixel cells, `floor(size / 12)` px each. */
export function AgentMarkGlyph({ slug, size }: { slug: string; size: AgentMarkSize }) {
  const mark = pixelMark(slug);
  const cell = mark.width === 7 ? size / 7 : Math.max(1, Math.floor(size / 12));
  return (
    <svg
      aria-hidden
      width={mark.width * cell}
      height={mark.height * cell}
      viewBox={`0 0 ${mark.width} ${mark.height}`}
      // Inline, so a host's `[&_svg]:size-4` default (menu rows) cannot rescale
      // the pixel grid off whole device pixels.
      style={{ width: mark.width * cell, height: mark.height * cell }}
      shapeRendering="crispEdges"
      className="shrink-0"
    >
      <path d={mark.path} className="fill-(--mark-ink)" />
      {mark.ditherPath ? (
        <path d={mark.ditherPath} className="fill-(--mark-ink)" opacity={0.5} />
      ) : null}
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
  label,
  className,
}: {
  slug: string;
  size?: AgentMarkSize;
  /** Tile edge in px, when the tile must match a neighbour's height. */
  tile?: number;
  /** The hover hint. Defaults to the agent's display name. */
  label?: string;
  className?: string;
}) {
  // A mark is a face, not a name: the hover hint says whose face it is.
  const mark = (
    <span
      aria-hidden
      data-slot="agent-mark"
      style={{ ...agentMarkVars(slug), width: tile, height: tile }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-(--mark-tile)',
        size >= 28 ? 'rounded-md' : 'rounded-sm',
        agentMarkTileClass(slug),
        className,
      )}
    >
      <AgentMarkGlyph slug={slug} size={size} />
    </span>
  );
  return (
    <Hint side="top" sideOffset={6} alignOffset={0} label={label ?? agentDisplayName(slug)}>
      {mark}
    </Hint>
  );
}

/**
 * An agent's name as a person reads it: My Kortix for the built-in agent,
 * otherwise the manifest key in sentence case with its separators as spaces
 * (`session-reviewer` → "Session reviewer"). One helper, so the sidebar, the
 * agent page, the index and the hover hint name an agent the same way.
 */
export function agentDisplayName(slug: string): string {
  if (isMetaAgentName(slug)) return META_AGENT_DISPLAY_NAME;
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
