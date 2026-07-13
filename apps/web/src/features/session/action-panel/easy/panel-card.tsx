'use client';

/**
 * `PanelCard` — the reusable Easy-mode card shell (Progress / Outputs /
 * Context all sit on this, directly or in spirit).
 *
 * Collapsed and empty, a card is a *promise*: a title, soft placeholder art,
 * and one plain sentence saying what will show up here. Nothing technical is
 * visible until the user asks for it.
 *
 * Two shapes:
 * - `drillIn` — chevron points right, the header navigates away (Progress
 *   opens the step list). There is no in-place body.
 * - default — chevron rotates down, the header toggles an in-place body
 *   (Outputs / Context).
 */

import { Badge } from '@/components/ui/badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Empty, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';

export interface PanelCardProps {
  title: string;
  count?: number;
  /** Chevron points right and the header is a plain navigation button (Progress). No in-place body. */
  drillIn?: boolean;
  onOpen?: () => void;
  children?: ReactNode;
  /** Soft placeholder art shown above `emptyText` — the "promise" state. */
  emptyArt?: ReactNode;
  emptyText?: string;
  isEmpty: boolean;
  defaultExpanded?: boolean;
}

/** Full-width row trigger, clipped by the parent's `overflow-hidden` so its square corners never peek past the card's rounded-md border. */
const HEADER_CLASS = cn(
  'flex min-h-11 w-full items-center justify-between gap-2 rounded-none px-4 py-3 text-left',
  'transition-[background-color,transform] active:scale-[0.998]',
  'hover:bg-muted-foreground/[0.04]',
);

function CardTitleRow({
  title,
  count,
  chevron,
}: {
  title: string;
  count?: number;
  chevron: ReactNode;
}) {
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-foreground truncate text-sm font-semibold">{title}</span>
        {typeof count === 'number' && count > 0 && (
          <Badge variant="secondary" size="sm" className="tabular-nums">
            {count}
          </Badge>
        )}
      </span>
      {chevron}
    </>
  );
}

export function PanelCard({
  title,
  count,
  drillIn = false,
  onOpen,
  children,
  emptyArt,
  emptyText,
  isEmpty,
  defaultExpanded = false,
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

  if (drillIn) {
    return (
      <div className="border-border bg-popover overflow-hidden rounded-md border">
        <button type="button" onClick={onOpen} className={cn(HEADER_CLASS, 'cursor-pointer')}>
          <CardTitleRow
            title={title}
            count={count}
            chevron={<ChevronRight className="text-muted-foreground size-4 shrink-0" />}
          />
        </button>
      </div>
    );
  }

  return (
    <Disclosure
      open={expanded}
      onOpenChange={setExpanded}
      variant="outline"
      className="bg-popover overflow-hidden"
      transition={transition}
    >
      <DisclosureTrigger variant="outline">
        <button type="button" className={cn(HEADER_CLASS, 'cursor-pointer')}>
          <CardTitleRow
            title={title}
            count={count}
            chevron={
              <motion.span
                animate={{ rotate: expanded ? 180 : 0 }}
                transition={transition}
                className="text-muted-foreground shrink-0"
              >
                <ChevronDown className="size-4" />
              </motion.span>
            }
          />
        </button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t px-4 py-5">
        {isEmpty ? (
          <Empty className="flex-none gap-3 rounded-none border-none p-0 text-center">
            {emptyArt && <EmptyMedia className="mb-0">{emptyArt}</EmptyMedia>}
            {emptyText && <EmptyDescription className="text-pretty">{emptyText}</EmptyDescription>}
          </Empty>
        ) : (
          children
        )}
      </DisclosureContent>
    </Disclosure>
  );
}
