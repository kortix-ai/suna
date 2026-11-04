import type { Icon } from '@phosphor-icons/react';

/**
 * The artwork above an `EmptyState`: two cards fanned behind a front card.
 * Without `icon` the front card is a document (an empty folder); with one,
 * the icon sits on a plain front card (a channel's empty Memory, Links,
 * Triggers, Apps and Threads), so every empty tab draws one picture.
 * `glyphClassName` tints the icon (a channel's setup cards).
 */
export function EmptyArt({ icon: Glyph, glyphClassName = 'text-muted-foreground' }: { icon?: Icon; glyphClassName?: string }) {
  return (
    <svg width="72" height="60" viewBox="0 0 72 60" fill="none" aria-hidden="true">
      {/* The back cards mirror each other around the front card's centre line (x 36): same box, ±7 px, ±8° about the bottom centre. */}
      {[-1, 1].map((side) => (
        <rect
          key={side}
          x="21"
          y="10"
          width="30"
          height="43"
          rx="4"
          transform={`translate(${side * 7} 0) rotate(${side * 8} 36 53)`}
          className="fill-card stroke-foreground/10"
        />
      ))}
      {Glyph ? (
        <>
          <rect x="21" y="12" width="30" height="43" rx="4" className="fill-muted stroke-foreground/20" />
          <Glyph x={27} y={24.5} size={18} className={glyphClassName} />
        </>
      ) : (
        <g transform="translate(3 0)">
          <path
            d="M22 12h17l9 9v30a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z"
            className="fill-muted stroke-foreground/20"
          />
          <path d="M39 12v6a3 3 0 0 0 3 3h6" className="stroke-foreground/20" />
          <path
            d="M25 30h16M25 36h16M25 42h10"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="stroke-foreground/15"
          />
        </g>
      )}
    </svg>
  );
}
