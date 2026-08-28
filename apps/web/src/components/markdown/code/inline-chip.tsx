/**
 * The inline-code chip, and the one piece of markdown that draws something
 * other than text.
 *
 * NO `'use client'`, deliberately. `inline-code.tsx` is a client module — its
 * file-path and URL chips read stores and fire probes — and everything a
 * client module exports becomes a client REFERENCE. The docs renderer
 * (`docs-mdx-components.tsx`) is a server module, so importing the chip class
 * or the hex predicate from there and calling one crashed the page with
 * "Attempted to call isHexColor() from the server but isHexColor is on the
 * client". A local copy of the class string was the old way around that, and
 * it drifted; this is the same dedupe without the boundary.
 *
 * Nothing here may take a hook or touch a store. What lives here is what both
 * surfaces can render: the class string, the hex test, and a swatch that is
 * pure JSX.
 */

import { cn } from '@/lib/utils';
import type React from 'react';

// ─── Inline code ─────────────────────────────────────────────────────────────
/**
 * The chip sits IN the line, not beside it.
 *
 * No `display` of its own, and no `vertical-align`: an inline box shares the
 * paragraph's baseline for free, and its border box hugs the font's content
 * area, so the chip is the height of the text it interrupts. Both of the
 * obvious-looking alternatives are what knocked it out of line:
 *
 *   - `align-middle` centres the box on the parent's baseline PLUS half the
 *     parent's x-height. The chip is `text-[0.8rem]` inside `text-base` prose,
 *     so its own baseline landed visibly BELOW the surrounding text's — the
 *     chip appeared to sag under the sentence.
 *   - `inline-flex` makes the chip atomic: its height comes from the flex line
 *     box (`code { line-height: 1.2 }` in globals.css) plus padding rather than
 *     from the glyphs, so it towers over the prose, and — being unbreakable —
 *     a long URL can no longer wrap across two lines the way
 *     `[overflow-wrap:anywhere]` promises.
 *
 * `text-center` is gone with them: a chip is one line of text as wide as its
 * content, so there is nothing for it to centre.
 */
// Mirrored, out of necessity, by the search-dialog rule in `app/globals.css`:
// fumadocs builds that chip inside its own package, so there is nowhere to
// hand it this class. Change one, change the other.
export const INLINE_CODE =
  'rounded-[5px] bg-inherit dark:bg-card px-1.5 py-[0.08rem] font-mono text-[0.8rem] text-foreground/95 [overflow-wrap:anywhere] border border-border tracking-tight font-medium';

/**
 * The four CSS hex forms and nothing else: `#RGB`, `#RGBA`, `#RRGGBB`,
 * `#RRGGBBAA`.
 *
 * Anchored at both ends on purpose — a swatch is a claim that the whole token
 * IS a colour, so `#ff0000-ish` and a `#fff` buried in a longer string do not
 * qualify. `#deadbeef` is a legal 8-digit hex and gets a swatch; that is the
 * cost of the format having no other tell, and the value is still printed
 * beside it.
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(text: string): boolean {
  return HEX_COLOR.test(text);
}

/**
 * The checkerboard behind a swatch, so an ALPHA hex reads as translucent
 * instead of as whatever it happens to composite to over the chip.
 *
 * `currentColor` rather than a hardcoded grey: the square sets its own
 * `text-muted-foreground/30`, so the board follows the theme in both
 * appearances without a second colour definition. Two 45° gradients offset by
 * half a tile is the standard construction — one gradient draws the diagonal
 * pair, the offset copy fills the other two quadrants.
 */
const CHECKER =
  'linear-gradient(45deg, currentColor 25%, transparent 25%, transparent 75%, currentColor 75%),' +
  'linear-gradient(45deg, currentColor 25%, transparent 25%, transparent 75%, currentColor 75%)';

/**
 * A hex colour in a message, showing the colour it names.
 *
 * `#0ea5e9` in prose is a value nobody can read: the reader has to paste it
 * somewhere to find out whether the agent picked a blue or a green. The chip
 * keeps the hex — it is what gets copied into a stylesheet, so it must stay
 * literal and selectable — and puts a square of the actual colour in front of
 * it, sized in `em` so it tracks the chip's own text.
 *
 * The square is `aria-hidden`: it adds no information a screen reader can use
 * that the hex itself does not already carry. The ring is what keeps
 * `#ffffff` visible on a light chip and `#000000` visible on a dark one — a
 * swatch with no edge disappears into exactly the background it matches.
 */
export function HexColorCode({ hex, children }: { hex: string; children: React.ReactNode }) {
  return (
    <code title={hex} className={cn(INLINE_CODE, 'space-y-0 py-0')}>
      {/* The square sits ON the baseline, so its bottom edge and the text's
          share one line.

          The anchor is the baseline rather than a centring rule, and Roobert
          Mono's own metrics say why: capHeight is 700/1000 = 0.70em and
          xHeight is 504/1000 = 0.504em (read from the `OS/2` table of
          `public/fonts/roobert/RoobertMonoUprightsVF.woff2`). A hex value is
          digits and capitals, so the text beside the square occupies
          baseline → 0.70em. `align-baseline` puts the square in that same
          band; at `0.8em` it stands a tenth of an em proud of the caps, which
          is a swatch reading slightly bolder than its own text and not a
          misalignment — both boxes still start at the baseline.

          NOT `align-middle`: `vertical-align: middle` centres the box on half
          the parent's X-HEIGHT (0.252em), the middle of LOWERCASE text. On
          digits it put the square's bottom edge 0.148em BELOW the baseline, so
          it read as sunk under its own hex. An inline-block whose `overflow`
          is not `visible` takes its baseline from the bottom margin edge
          (CSS2.1 §10.8.1), which is exactly the anchor wanted here.

          `mr-1` replaces the flex `gap`. */}
      <span
        aria-hidden
        className="text-muted-foreground/30 ring-foreground/15 relative mr-1 inline-block size-[0.8em] overflow-hidden rounded-[3px] align-baseline ring-1 ring-inset"
        style={{
          backgroundImage: CHECKER,
          backgroundSize: '10px 10px',
          backgroundPosition: '0 0, 5px 5px',
        }}
      >
        <span className="absolute inset-0" style={{ backgroundColor: hex }} />
      </span>
      {children}
    </code>
  );
}
