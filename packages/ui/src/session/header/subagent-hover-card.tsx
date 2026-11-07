'use client';

import type { ProjectRuntimeSession, ProjectSession } from '@kortix/sdk';
import { formatDistanceToNowStrict } from 'date-fns';
import { Slot } from 'radix-ui';
import { useRef, useState, type ReactElement } from 'react';
import { useTranslations } from '../../i18n';
import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { uiRoutes } from '../../lib/routes';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { menuRow } from '../../primitives/menu-recipe';
import { Popover, PopoverAnchor, PopoverContent } from '../../primitives/popover';
import { ShowMoreButton } from '../list/session-list-chrome';
import { getSessionDisplayTitle, shortRelative } from '../actions/project-session-list-helpers';
import { subagentTitle } from '../agents/agent-model';
import { childSessionHref } from '../tool/tools/session-spawn-urls';

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
 * ArrowDown opens the same list in a focusable popover. Clicking the title
 * keeps the existing rename action.
 */
export function SubagentHoverCard({
  projectId,
  projectSessionId,
  subsessions,
  spawnedSessions = [],
  onLoadMore,
  loadingMore,
  children,
}: {
  projectId: string;
  projectSessionId: string;
  subsessions: readonly ProjectRuntimeSession[];
  spawnedSessions?: readonly ProjectSession[];
  onLoadMore?: () => void;
  loadingMore?: boolean;
  children: ReactElement;
}) {
  const suppressFocusOpen = useRef(false);
  const interactedOutside = useRef(false);
  const titleRef = useRef<HTMLElement>(null);
  const t = useTranslations('sidebar.sessionList');
  const tContext = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const close = () => {
    setOpen(false);
    setKeyboard(false);
  };
  const href = uiRoutes().session(projectId, projectSessionId);

  const content = (
    <>
      <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
        <span>
          {[
            subsessions.length > 0 && tContext('subAgentsLabel'),
            spawnedSessions.length > 0 && tContext('spawnedLabel'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="tabular-nums">
          {subsessions.length + spawnedSessions.length}
          {onLoadMore ? '+' : ''}
        </span>
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
                href={childSessionHref(href, child.id)}
                onClick={close}
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
                      formatDistanceToNowStrict(new Date(child.updated_at), {
                        addSuffix: false,
                      }),
                    )}
                  </time>
                ) : null}
              </HoverPrefetchLink>
            </li>
          ))}
          {spawnedSessions.map((child) => (
            <li key={child.session_id}>
              <HoverPrefetchLink
                href={uiRoutes().session(projectId, child.session_id)}
                onClick={close}
                className={menuRow('sm', 'default', 'cursor-pointer')}
              >
                <span className="min-w-0 flex-1 truncate">{getSessionDisplayTitle(child)}</span>
              </HoverPrefetchLink>
            </li>
          ))}
          {onLoadMore && (
            <li>
              <ShowMoreButton
                loading={!!loadingMore}
                failed={false}
                label={t('showMore')}
                onClick={onLoadMore}
              />
            </li>
          )}
        </ul>
      </FadedScrollArea>
    </>
  );
  return (
    <Popover
      open={keyboard && open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <HoverCard
        open={!keyboard && open}
        onOpenChange={(value) => {
          if (!keyboard && (!value || !suppressFocusOpen.current)) setOpen(value);
        }}
        openDelay={300}
        closeDelay={100}
      >
        <PopoverAnchor asChild>
          <HoverCardTrigger asChild>
            <Slot.Root
              ref={titleRef}
              aria-keyshortcuts="ArrowDown"
              onPointerEnter={() => {
                suppressFocusOpen.current = false;
              }}
              onBlur={() => {
                suppressFocusOpen.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  interactedOutside.current = false;
                  setKeyboard(true);
                  setOpen(true);
                }
              }}
            >
              {children}
            </Slot.Root>
          </HoverCardTrigger>
        </PopoverAnchor>
        {keyboard ? (
          <PopoverContent
            onInteractOutside={() => {
              interactedOutside.current = true;
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement)
                .querySelector<HTMLAnchorElement>('a[href]')
                ?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!interactedOutside.current) {
                // Restoring focus must not schedule another hover card.
                suppressFocusOpen.current = true;
                titleRef.current?.focus();
              }
            }}
            side="bottom"
            align="start"
            sideOffset={6}
            className="w-72 overflow-hidden p-0"
          >
            {content}
          </PopoverContent>
        ) : (
          <HoverCardContent
            side="bottom"
            align="start"
            sideOffset={6}
            animated={false}
            className="w-72 overflow-hidden p-0"
            onEscapeKeyDown={close}
          >
            {content}
          </HoverCardContent>
        )}
      </HoverCard>
    </Popover>
  );
}
