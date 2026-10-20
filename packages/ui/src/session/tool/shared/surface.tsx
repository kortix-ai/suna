'use client';

import { createContext, useContext } from 'react';

/**
 * Which surface a tool view is being rendered on.
 *
 * Lives in its own module rather than in `infrastructure.tsx` to keep the
 * import graph acyclic. The shared cards need to know the surface (an inline
 * row indents to its label column; a panel row supplies its own padding), and
 * `infrastructure.tsx` in turn renders those cards — so if the context stayed
 * there, card → infrastructure → card would be a cycle. It survives today only
 * because every use sits inside a component body and therefore runs after all
 * modules have initialized, which is a property no one should have to know.
 */
export type ToolSurface = 'inline' | 'panel';

export const ToolSurfaceContext = createContext<ToolSurface>('inline');

/**
 * The left offset a card under a tool row needs to line up with the row's TEXT,
 * not its icon.
 *
 * {@link ToolHeaderRow} renders a `size-4` icon and `TOOL_ROW_CLASS` sets
 * `gap-1.5`, so the text column starts 22px in. (`bash` used to hardcode `ml-7`
 * against a `gap-3` that this row class does not have, which put its block 6px
 * past the text above it.)
 *
 * 22px is the DEFAULT, not the law, because the gap it derives from can be
 * overridden by the surface. A tool row inside a chain of thought is forced to
 * `gap-3` so its label lines up with the thought and file rows above it
 * (`turn/activity-step.tsx`), which moves the text column to 28px and left the
 * card 6px short — the same 6px error the note above records, mirrored. A
 * hardcoded value cannot follow a gap it cannot see, so the surface sets
 * `--tool-indent` alongside the gap it overrides and the two can no longer
 * drift apart. Every other surface leaves the variable unset and gets 22px.
 *
 * It lives beside the surface context, not in `infrastructure.tsx`, for exactly
 * the reason written above the context: `result-card.tsx` needs the indent and
 * `infrastructure.tsx` renders `result-card.tsx`, so importing it from there
 * would close the cycle this module exists to avoid.
 */
export const TOOL_INDENT = 'ml-[var(--tool-indent,1.375rem)]';

/**
 * The indent, or nothing, depending on which surface the tool is drawn on.
 *
 * An inline row leads with a `size-4` icon and a `gap-1.5`, so its text column
 * starts 22px in and a card below it has to match. A panel row's body has no
 * icon gutter and supplies its own `px-3 py-3`, so the same indent only pushes
 * the card 22px off the trigger it sits under.
 *
 * Every bordered card reads the indent from HERE. Two of them used to hardcode
 * `ml-7` (28px) against this 22px, so the same expanded row could show a card
 * at two different left edges depending on which branch drew it.
 */
export function useToolIndent(): string {
  return useContext(ToolSurfaceContext) === 'inline' ? TOOL_INDENT : '';
}

/** The hairline card every payload draws around itself on the INLINE surface.
 *  Module-private: {@link useToolCardFrame} is the only sanctioned reader, so a
 *  card cannot take the frame without also taking the surface gate. */
const TOOL_CARD_FRAME = 'border-border bg-popover rounded-md border';

/** The inset a payload card puts between its frame and its content.
 *  Module-private for the same reason as {@link TOOL_CARD_FRAME} — read it
 *  through {@link useToolCardPad}. */
const TOOL_CARD_PAD = 'p-3';

/**
 * The frame a payload card draws — or nothing, on the panel, where the row
 * card IS the frame.
 *
 * An opened panel row used to draw three frames around one payload: the row
 * card's `bg-popover rounded-md border`, the disclosure body's `border-t px-3
 * py-3`, and then the payload's own `bg-popover rounded-md border`. Three
 * edges and two insets to say one thing. Inline the payload needs its own
 * frame — it hangs under a trigger row on the page background with nothing
 * else to bound it — but on the panel it is the only thing inside a card that
 * already bounds it, so the frame is redundant and the second inset is the
 * "inset twice for no added meaning" the gate filed.
 *
 * A tint is NOT a frame: {@link ToolResultCard} keeps its destructive border
 * and wash on both surfaces, because that edge carries the failure and the row
 * card cannot.
 */
export function useToolCardFrame(): string {
  return useContext(ToolSurfaceContext) === 'inline' ? TOOL_CARD_FRAME : '';
}

/**
 * The card's own content inset — or nothing, on the panel.
 *
 * The other half of {@link useToolCardFrame}: dropping the frame alone would
 * leave the payload inset twice (the body's `px-3 py-3` plus the card's own
 * `p-3`, 24px of gutter around a 420px pane). The row body's inset is the one
 * that survives, so the panel reads as one frame with one 12px gutter.
 *
 * Callers keep their `pr-11` copy-button reserve AFTER this class so the
 * right-hand reserve survives the merge on both surfaces.
 */
export function useToolCardPad(): string {
  return useContext(ToolSurfaceContext) === 'inline' ? TOOL_CARD_PAD : '';
}
