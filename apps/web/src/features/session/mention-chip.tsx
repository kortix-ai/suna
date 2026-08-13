'use client';

/**
 * The one mention/command chip — shared so the composer's draft and the sent
 * message can never drift apart.
 *
 * Same reasoning as `attachment-tile.tsx`, and the same failure it was
 * extracted to end: `composer/editor/mention-node.ts` drew `@README.md` as a
 * bordered chip while `turn/user-message.tsx` and `optimistic-turn.tsx` each
 * drew the identical mention as underlined text, and a `/command` chip in the
 * composer became a bordered card with a terminal icon the moment it was sent.
 * Typing a message and sending it visibly changed what the message WAS.
 *
 * Consumed by `composer/editor/mention-node.ts` (the TipTap atom's `toDOM`,
 * which needs the raw class + text strings, not the component),
 * `turn/user-message.tsx` and `optimistic-turn.tsx` (the sent + optimistic
 * bubbles, which use the component).
 */

import { cn } from '@/lib/utils';

/** `/` for a slash command, `@` for every reference kind. */
export function chipPrefix(kind: string): string {
  return kind === 'command' ? '/' : '@';
}

/** The one place a chip's visible text is built. */
export function chipText(kind: string, label: string): string {
  return `${chipPrefix(kind)}${label}`;
}

/** The one place a chip's accessible name is built. */
export function chipAriaLabel(kind: string, label: string): string {
  return kind === 'command' ? `command: /${label}` : `${kind} mention: ${label}`;
}

/**
 * Two visual registers, one node. A mention is a REFERENCE — neutral, it sits
 * in the sentence. A command is an INSTRUCTION — it takes the primary tint so
 * `/deep-research` reads as a thing being invoked rather than a thing being
 * pointed at. Both keep `align-baseline` so they ride the surrounding line
 * instead of stretching it.
 *
 * `text-[0.95em]`, not `text-base sm:text-sm`. The size has to be relative
 * because this chip now sits in two type contexts: the composer's editor
 * (`text-base sm:text-[15px]`) and the message bubble's `text-[0.9rem]`. A
 * fixed `text-base` is very slightly smaller than the composer's own body on
 * desktop, which is what the chip already looked like — but dropped into the
 * 14.4px bubble it would render LARGER than the sentence around it. An `em`
 * keeps the chip a fixed fraction of whatever line it lands on, so "the chip
 * looks the same in both places" holds by construction rather than by two
 * files agreeing on a pixel value.
 *
 * `cn`, not a template literal, and the difference is not cosmetic. The
 * variant adds `bg-primary/[0.08]` while the base carries `bg-muted`, so both
 * classes would otherwise reach the element — and class order in the
 * `class` ATTRIBUTE decides nothing. CSS resolves the tie by which rule
 * Tailwind emitted later in the stylesheet, which is not something this file
 * can see or control. `cn`'s twMerge pass deletes the losing class outright,
 * which is the only way "the variant wins" is actually true.
 *
 * `dark:bg-primary/[0.08]` is there for the same reason: `dark:bg-card` sits
 * in a different variant group, so twMerge does NOT treat it as conflicting
 * with the unprefixed `bg-primary/[0.08]`. Without an explicit dark override
 * the command chip would take the primary tint in light mode and the plain
 * card surface in dark — the two themes disagreeing about whether a command
 * looks different to a mention at all.
 */
export function chipClass(kind: string): string {
  const base =
    'rounded-sm border border-[0.5px] bg-muted px-1.5 py-[0.08rem] text-foreground/95 [overflow-wrap:anywhere] dark:bg-card font-medium whitespace-nowrap align-baseline text-[0.95em]';
  return kind === 'command'
    ? cn(base, 'bg-primary/[0.08] text-foreground dark:bg-primary/[0.08]')
    : cn(base, 'bg-primary/[0.08] text-foreground dark:bg-primary/[0.08]');
}

/**
 * The press/hover feel a NAVIGABLE chip adds on top of the shared surface —
 * a file chip that opens the file, a session chip that opens the session.
 *
 * Only in the sent message: inside the composer a chip is document content,
 * not a control, so it must not invite a click it cannot answer. `scale(0.97)`
 * on press is the same feedback `TILE_INTERACTIVE` gives an attachment tile,
 * for the same reason — a chip that opens something has to feel like it heard
 * the click.
 */
const CHIP_INTERACTIVE = cn(
  'cursor-pointer transition-colors duration-150',
  'hover:bg-foreground/10 dark:hover:bg-foreground/10',
  'active:scale-[0.97] active:transition-transform',
  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
);

export interface MentionChipProps {
  /** `file` | `agent` | `session` | `command`. */
  kind: string;
  /** The chip's text WITHOUT its prefix — `chipText` adds `@` or `/`. */
  label: string;
  /**
   * Makes the chip a button. Omitted — an agent or command chip, or a file
   * chip in a session with no runtime yet — renders a static `span` instead of
   * a dead control.
   */
  onClick?: () => void;
  className?: string;
}

/**
 * A mention or command, drawn exactly as the composer draws it.
 *
 * `stopPropagation` is not optional here: the user bubble is itself a click
 * target (it expands a clamped message), so a chip that let its click bubble
 * would open a file AND toggle the bubble in one press.
 */
export function MentionChip({ kind, label, onClick, className }: MentionChipProps) {
  const text = chipText(kind, label);
  const ariaLabel = chipAriaLabel(kind, label);

  if (!onClick) {
    return (
      <span aria-label={ariaLabel} className={cn(chipClass(kind), className)}>
        {text}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(chipClass(kind), CHIP_INTERACTIVE, className)}
    >
      {text}
    </button>
  );
}
