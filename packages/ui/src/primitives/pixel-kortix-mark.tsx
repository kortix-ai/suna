'use client';

import { PIXEL_KORTIX_ROWS } from '@kortix/shared/pixel-mark';
import { useId, type ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/utils';

/**
 * The Kortix symbol on a 12 × 10 grid: `#` a full cell, `+` a curve cell drawn
 * as a checker. The rows live in `@kortix/shared/pixel-mark` so the TUI splash
 * draws the same symbol; this module re-exports them under the same name.
 */
export { PIXEL_KORTIX_ROWS };

/** Cell size and the gap after it, in viewBox units. At the default size one
 *  unit is one CSS pixel, so cells and the 1px checker land on whole pixels. */
const CELL = 5;
const GAP = 1;
const PITCH = CELL + GAP;
const WIDTH = PIXEL_KORTIX_ROWS[0].length * PITCH - GAP;
const HEIGHT = PIXEL_KORTIX_ROWS.length * PITCH - GAP;

const CELLS = PIXEL_KORTIX_ROWS.flatMap((row, y) =>
  [...row].flatMap((cell, x) =>
    cell === ' ' ? [] : [{ key: `${x}-${y}`, x: x * PITCH, y: y * PITCH, dithered: cell === '+' }],
  ),
);

/**
 * Decorative pixel art of the Kortix symbol, for empty states. It paints in
 * `currentColor`, so the caller sets the tone. It is always `aria-hidden`: the
 * text next to it carries the meaning.
 */
export function PixelKortixMark({ className, ...props }: ComponentPropsWithoutRef<'svg'>) {
  // One pattern per instance: a `url(#id)` that points into another copy of
  // this SVG stops painting when that copy is hidden with `display: none`.
  const ditherId = `pixel-kortix-dither-${useId().replace(/[^\w-]/g, '')}`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
      className={cn('shrink-0', className)}
      {...props}
    >
      <defs>
        {/* `userSpaceOnUse`, so every dithered cell samples one shared checker
            and neighbouring cells line up instead of each restarting it. */}
        <pattern id={ditherId} width="2" height="2" patternUnits="userSpaceOnUse">
          <rect width="1" height="1" />
          <rect x="1" y="1" width="1" height="1" />
        </pattern>
      </defs>
      {CELLS.map((cell) => (
        <rect
          key={cell.key}
          x={cell.x}
          y={cell.y}
          width={CELL}
          height={CELL}
          fill={cell.dithered ? `url(#${ditherId})` : undefined}
        />
      ))}
    </svg>
  );
}
