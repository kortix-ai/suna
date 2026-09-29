'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { menuRow } from '@/components/ui/menu-recipe';
import { shortRelative } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectRuntimeSession } from '@kortix/sdk';
import { formatDistanceToNowStrict } from 'date-fns';
import { useState, type ReactElement } from 'react';

/** A subsession's own title, without OpenCode's "(@general subagent)" suffix. */
export function subagentTitle(title: string): string {
  return title.replace(/\s*\(@[^)]*subagent\)$/, '');
}

/**
 * The parent session's title, on hover: the subagent sessions it spawned.
 *
 * Rows wear `menuRow` so they line up with every other floating list; the
 * header is `px-3.5` because the list is `p-1` and its rows are `px-2.5`, so
 * the label and the row titles share one left edge (same arithmetic as
 * `session-brief-hover-card.tsx`).
 *
 * `animated={false}`: the card opens downward, into the path the pointer is
 * already travelling, so an enter animation only moves the rows away from it.
 * Radix strips tab stops inside a hover card; the keyboard route to the same
 * sessions is the sidebar, which lists them under this session.
 */
export function SubagentHoverCard({
  projectId,
  projectSessionId,
  subsessions,
  children,
}: {
  projectId: string;
  projectSessionId: string;
  subsessions: readonly ProjectRuntimeSession[];
  children: ReactElement;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const href = `/projects/${projectId}/sessions/${projectSessionId}`;

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        animated={false}
        className="w-72 overflow-hidden p-0"
        onEscapeKeyDown={() => setOpen(false)}
      >
        <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
          <span>{tHardcodedUi.raw('i18nComplete.text88296ab3d666')}</span>
          <span className="tabular-nums">{subsessions.length}</span>
        </div>
        {/* Capped at `max-h-64` (~8 rows); a long list scrolls inside the card.
            The fades mark the clipped edges: the top one appears once the list
            scrolls under the header, the bottom one while rows remain below. */}
        <FadedScrollArea
          fadeColor="from-popover"
          fadeSize="6"
          className="max-h-64 overscroll-contain"
        >
          <ul className="p-1 pt-0">
            {subsessions.map((child) => (
              <li key={child.id}>
                <HoverPrefetchLink
                  href={`${href}?oc=${encodeURIComponent(child.id)}`}
                  onClick={() => setOpen(false)}
                  className={menuRow('sm', 'default', 'cursor-pointer')}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {subagentTitle(child.title || 'Sub-session')}
                  </span>
                  {child.updated_at ? (
                    <time
                      dateTime={new Date(child.updated_at).toISOString()}
                      className="text-muted-foreground shrink-0 text-xs tabular-nums"
                      suppressHydrationWarning
                    >
                      {shortRelative(
                        formatDistanceToNowStrict(new Date(child.updated_at), { addSuffix: false }),
                      )}
                    </time>
                  ) : null}
                </HoverPrefetchLink>
              </li>
            ))}
          </ul>
        </FadedScrollArea>
      </HoverCardContent>
    </HoverCard>
  );
}
