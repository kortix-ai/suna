'use client';

/**
 * `PanelCard` — the reusable Easy-mode card shell (Progress / Outputs /
 * Context all sit on this, directly or in spirit).
 *
 * Collapsed and empty, a card is a *promise*: a title, soft placeholder art,
 * and one plain sentence saying what will show up here. Nothing technical is
 * visible until the user asks for it.
 *
 * The chevron rotates down and the header toggles an in-place body. All three
 * cards work this way: expanding one never hides the others, so the panel is
 * always the same three rows and never navigates away from itself.
 */

import { Badge } from '@/components/ui/badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { CaretRightIcon as ChevronRight } from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';

export interface PanelCardProps {
  title: string;
  count?: number;
  /** Second line under the title — Progress uses it for its live step label. */
  subtitle?: ReactNode;
  children?: ReactNode;
  /** Soft placeholder art shown above `emptyText` — the "promise" state. */
  emptyArt?: ReactNode;
  emptyText?: string;
  /** Extra content under `emptyText` — the empty Context card's "Add
   *  context" / "Connect apps" row (Task 5). Full-width, not the `Empty`
   *  primitive's own `max-w-sm` prose cap, since a connector strip needs the
   *  card's whole width to lay out its rows. */
  emptyActions?: ReactNode;
  isEmpty: boolean;
  defaultExpanded?: boolean;
  /** Override the body padding — a full-bleed list (Progress) wants none. */
  contentClassName?: string;
  /** A control beside the chevron (Outputs' "download all") — click-isolated
   * from the header's own expand/collapse toggle. */
  headerAction?: ReactNode;
  /**
   * This card absorbs the column's leftover height instead of pushing its
   * siblings off the bottom.
   *
   * Exactly ONE card in the column may set it. The card still sizes to its
   * content — it never stretches to fill space it does not need — but it is the
   * only one the flex algorithm is allowed to shrink, and when it shrinks its
   * BODY scrolls while its header stays put. Everything else in the column
   * keeps `shrink-0` and stays wholly visible.
   *
   * That asymmetry is the whole design. A column where every card can shrink
   * has no anchor and clips all three; a column where none can shrink pushes
   * the lower cards out of sight the moment one list gets long. One flexible
   * card, the rest fixed, is what keeps Context and Preview on screen while
   * Outputs holds two hundred files.
   *
   * One call-site consequence: the header divider moves to the scroll
   * container, so a `fill` card's `contentClassName` carries padding only —
   * pass no `border-t` or the card draws two.
   */
  fill?: boolean;
}

/** Full-width row trigger, clipped by the parent's `overflow-hidden` so its square corners never peek past the card's rounded-md border. */
const HEADER_CLASS = cn(
  'flex min-h-11 w-full items-center justify-between gap-2 rounded-none px-3.5 py-2 text-left',
  'transition-[background-color,transform] active:scale-[0.998]',
  'hover:bg-muted-foreground/[0.04]',
);

function CardTitleRow({
  title,
  count,
  subtitle,
  chevron,
}: {
  title: string;
  count?: number;
  subtitle?: ReactNode;
  chevron: ReactNode;
}) {
  return (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-foreground truncate text-sm font-semibold">{title}</span>
          {typeof count === 'number' && count > 0 && (
            <Badge variant="secondary" size="tabular" className="tabular-nums">
              {count}
            </Badge>
          )}
        </span>
        {subtitle}
      </span>
      {chevron}
    </>
  );
}

export function PanelCard({
  title,
  count,
  subtitle,
  children,
  emptyArt,
  emptyText,
  emptyActions,
  isEmpty,
  defaultExpanded = false,
  contentClassName = 'border-border border-t p-4',
  headerAction,
  fill = false,
}: PanelCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' as const };

  // `defaultExpanded` can flip true after mount (e.g. "auto-open Outputs the
  // moment a run finishes with something to show"). One-way sync: force open
  // when that happens, but never fight a user's manual collapse afterwards.
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);

  return (
    <Disclosure
      open={expanded}
      onOpenChange={setExpanded}
      variant="outline"
      className={cn(
        'bg-pane text-popover-foreground border-border overflow-hidden rounded-[calc(var(--radius)-3px)] border ease-out',
        fill ? 'flex min-h-0 flex-col' : 'shrink-0',
      )}
      transition={transition}
    >
      <DisclosureTrigger variant="outline">
        {/* `div`, not `button`: `DisclosureTrigger` already clones its role
            ("button"), tabIndex, and Enter/Space handling onto whatever child
            it's given, so a real `<button>` here bought nothing but blocked
            `headerAction` from ever being a real `<button>` too (nesting one
            inside another is invalid HTML). Restructuring the trigger this
            way — rather than faking the action as a styled `span[role=button]`
            — keeps both controls semantically real. */}
        <div className={cn(HEADER_CLASS, 'cursor-pointer')}>
          <CardTitleRow
            title={title}
            count={count}
            subtitle={subtitle}
            chevron={
              <span className="flex shrink-0 items-center gap-0.5">
                {headerAction && (
                  // Isolated from the toggle on both input paths: `stopPropagation`
                  // on click covers the mouse/tap case, and on keydown stops the
                  // Enter/Space that activates the nested button from *also*
                  // bubbling up into the trigger's own Enter/Space handler.
                  <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {headerAction}
                  </span>
                )}
                <m.span
                  animate={{ rotate: expanded ? 90 : 0 }}
                  transition={transition}
                  className="text-muted-foreground shrink-0"
                >
                  <ChevronRight className="size-4" />
                </m.span>
              </span>
            }
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent
        variant="outline"
        className={cn(
          fill && 'flex min-h-0 flex-col',
          fill && expanded && 'border-border border-t',
        )}
        contentClassName={contentClassName}
      >
        {isEmpty ? (
          <Empty className="flex-none gap-3 rounded-none border-none p-0 text-center">
            {emptyArt && <EmptyMedia className="mb-0">{emptyArt}</EmptyMedia>}
            {emptyText && <EmptyDescription className="text-pretty">{emptyText}</EmptyDescription>}
            {emptyActions && <EmptyContent className="w-full max-w-none">{emptyActions}</EmptyContent>}
          </Empty>
        ) : (
          children
        )}
      </DisclosureContent>
    </Disclosure>
  );
}
