/**
 * Every user-visible word and number an outcome renders.
 *
 * One module for the same reason `changes/change-vocabulary.ts` exists: three
 * surfaces used to each hand-roll their wording and drifted, and each leaked a
 * different amount of jargon. One vocabulary, no jargon that reaches a screen.
 */

import type { OutcomeTone } from './outcome-types';

/**
 * The tinted tile's classes per tone.
 *
 * ## Why every value carries an alpha
 *
 * The `kortix-*` tokens are single `oklch()` values with no lighter variants —
 * and they are IDENTICAL in light and dark (`globals.css:758` and `:839`). So
 * the only lever for "softer" is alpha, and each of the three plays a different
 * role:
 *
 * - `bg` at **15%** — a wash the glyph sits on, never a fill.
 * - `ring` at **40%** — the tile needs a defined edge, not a coloured outline.
 *   At full strength a 1px ring is the highest-contrast element in the row and
 *   pulls the eye before the title does.
 * - `fg` at **85%** — the glyph is DECORATION, not information. The status is
 *   written in words on the second line, so the icon reinforces a fact the
 *   reader already has. Softened, not faded: an earlier pass ran these at 70/30
 *   and Jay read the result as washed out, so this is the smallest reduction
 *   that still stops the tile shouting.
 *
 * `kortix-green` is the darkest token of the four (`L 0.581` against orange's
 * `0.691`), which is why a green tile read heaviest before this.
 *
 * One caveat worth knowing: alpha blends toward whatever is BEHIND the tile, so
 * this reads as literally lighter in light mode and as dimmer in dark mode. Both
 * are "quieter", which is the intent. Genuinely lighter in both themes would
 * need theme-aware tokens in `globals.css` — a shared surface, and a bigger
 * change than this row justifies.
 *
 * Colour lives HERE and nowhere else on the card — the status chip stays a
 * neutral `Badge variant="kortix"`. That split is the reference row's
 * (`changes-view.tsx`), and it is why the card needs no raw palette class:
 * `Badge`'s own `success`/`warning` variants bake `emerald-*`/`amber-*`, which
 * the design system bans in feature code.
 */
export const OUTCOME_TINT: Record<OutcomeTone, { bg: string; fg: string; ring: string }> = {
  success: { bg: 'bg-kortix-green/15', fg: 'text-kortix-green/85', ring: 'ring-kortix-green/40' },
  warning: {
    bg: 'bg-kortix-orange/15',
    fg: 'text-kortix-orange/85',
    ring: 'ring-kortix-orange/40',
  },
  destructive: { bg: 'bg-kortix-red/15', fg: 'text-kortix-red/85', ring: 'ring-kortix-red/40' },
  info: { bg: 'bg-kortix-blue/15', fg: 'text-kortix-blue/85', ring: 'ring-kortix-blue/40' },
  neutral: { bg: 'bg-muted', fg: 'text-muted-foreground/85', ring: 'ring-border/70' },
};

export function outcomeTint(tone: OutcomeTone): { bg: string; fg: string; ring: string } {
  return OUTCOME_TINT[tone] ?? OUTCOME_TINT.neutral;
}

/**
 * The quiet second line: reference facts, then state, joined by a middot.
 *
 * This replaced a loud `Badge` and a separate description line. The old row
 * said one idea five ways — an icon meaning "change request", a title reading
 * "Change request #8 · add jay.md", a shouting `WAITING FOR YOU` chip, and a
 * description "Create jay.md notes file. · into main" that restated the title
 * and then leaked a branch name.
 *
 * Now the title carries the agent's own words and nothing else, and everything
 * else lands here in one muted line. Status is TEXT, not a chip: the tinted
 * ring on the tile already encodes urgency by colour, so a second, louder
 * signal for the same fact was pure noise. Sentence case for the same reason —
 * `WAITING FOR YOU` in uppercase mono reads as an alarm.
 */
export function outcomeMetaLine(outcome: { meta: string[]; status: { label: string } }): string {
  return [...outcome.meta, outcome.status.label].filter((part) => part.trim()).join(' · ');
}

/** A row title is one line, not a sentence. */
export const OUTCOME_TITLE_MAX = 64;

/**
 * One line, hard-capped by character count.
 *
 * Whitespace collapses first: a title arrives as free text and may carry a
 * newline, and a one-line row has to render it on one line either way.
 *
 * The cut is by CHARACTER COUNT, not by word — the same rule `bashRowTitle`
 * uses at `tool/tools/bash-tool.tsx:72`. `trimEnd()` before the ellipsis is the
 * whole subtlety: a bare `slice` strands a space in front of it whenever the
 * cut lands just after a word.
 *
 * Not word-boundary, deliberately. This is a cap on pathological input — an
 * agent writing a 2,000-character title — not the visible truncation. The row
 * renders inside a CSS `truncate` span, which cuts at the actual available
 * width, so a word-boundary search here would be invisible work that also
 * diverges from its sibling for no reader benefit.
 */
export function truncateOutcomeTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= OUTCOME_TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, OUTCOME_TITLE_MAX).trimEnd()}…`;
}
