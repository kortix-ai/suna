'use client';

import type { ProjectSpace } from '@kortix/sdk';
import { useProjectSessions, useProjectSpaces, useSessionAsks } from '@kortix/sdk/react';
import { useReviewSessionSummary } from '../../internal/hooks/use-review-session-summary';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { CheckIcon, LockSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { type KeyboardEvent, useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { useIsMobile } from '../../internal/hooks';
import { reviewHref } from '../../internal/lib/capability-tab-routes';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { useUiPathname } from '../../providers/ui-provider';
import { CreateChannelDialog } from '../spaces/create-channel-dialog';
import { PrivateChannelsNotInRow } from '../spaces/private-channels-not-in';
import {
  isPersonalSpace,
  isPrivateSpace,
  orderSpaces,
  spaceDisplayName,
  spacePreview,
} from '../spaces/space-identity';
import { SpaceAvatar } from '../spaces/space-avatar';
import { usePersonalSpaceName } from '../spaces/use-personal-space-name';
import { useMentionNames, useOtherPerson } from '../spaces/space-people';

/** ↑/↓ move between the rows (Review, the spaces, New space), as in a list. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]'));
  const index = rows.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

/** `href`, or a page under it. */
function isAt(pathname: string | null, href: string): boolean {
  return !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
}

/**
 * What waits on the person across the project, the Customize nav's number:
 * the review summary's "needs you", plus the agents' questions and permission
 * asks (`useSessionAsks`). Connector approvals are already in the summary.
 */
function useReviewBadgeCount(projectId: string): number {
  const reviewNeedsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const asks = useSessionAsks(projectId).data?.asks;
  return reviewNeedsYou + (asks?.filter((ask) => ask.kind !== 'approval').length ?? 0);
}

/**
 * The sidebar under the `chat` flag: Spaces only. Review first, then the
 * person's own space (their chat with My Kortix, at `/chat`), then every
 * other space they see, each as a tile, its name and its newest message.
 * There is no Direct messages section: a DM with another agent is one more
 * private space in the list. The rows render once the list arrives (no
 * skeleton for navigation); the personal row renders at once, since `/chat`
 * creates that space on first open.
 */
export function ProjectSpacesNav({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const spaces = useProjectSpaces(projectId);
  const personalName = usePersonalSpaceName();
  // Mentions in previews read as names.
  const names = useMentionNames(projectId);
  const [createOpen, setCreateOpen] = useState(false);
  const { personal, others } = useMemo(() => orderSpaces(spaces.data ?? []), [spaces.data]);
  const chatHref = `${uiRoutes().project(projectId)}/chat`;
  // The Review page on its own route (`reviewHref`), beside this sidebar.
  const review = reviewHref(projectId);
  const openAsks = useReviewBadgeCount(projectId);

  const hrefOf = (space: ProjectSpace) =>
    space.kind === 'dm' ? uiRoutes().dm(projectId, space.dm_agent_name ?? '') : uiRoutes().channel(projectId, space.slug ?? '');

  return (
    <FadedScrollArea fadeColor="from-background" className="h-full min-h-0">
      <SidebarMenu className="gap-px" onKeyDown={moveFocus}>
        {review ? (
          // Spacing, not a rule, sets Review apart from the spaces.
          <SidebarMenuItem className="mb-2">
            <SidebarMenuButton asChild isActive={isAt(pathname, review)} className="text-sidebar-foreground">
              <HoverPrefetchLink href={review}>
                <CheckIcon />
                <span className="min-w-0 flex-1 truncate">{t('spaces.review')}</span>
                {openAsks > 0 ? <CountBadge count={openAsks} tone="waiting" /> : null}
              </HoverPrefetchLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        <SpaceRow
          projectId={projectId}
          space={personal}
          href={chatHref}
          active={isAt(pathname, chatHref) || isAt(pathname, uiRoutes().dm(projectId, MY_KORTIX_AGENT_NAME))}
          name={personalName}
          personal
          isPrivate
          names={names}
        />
        {spaces.isError && !spaces.data ? (
          <li className="space-y-1.5 px-2 py-2">
            <p className="text-destructive/80 text-xs">{t('spaces.loadError')}</p>
            <Button variant="outline" size="xs" onClick={() => spaces.refetch()}>
              {t('retry')}
            </Button>
          </li>
        ) : null}
        {others.map((space) => {
          const href = hrefOf(space);
          return (
            <SpaceRow
              key={space.space_id}
              projectId={projectId}
              space={space}
              href={href}
              active={isAt(pathname, href)}
              name={spaceDisplayName(space, personalName)}
              personal={isPersonalSpace(space)}
              isPrivate={isPrivateSpace(space)}
              names={names}
            />
          );
        })}
        {spaces.data ? (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setCreateOpen(true)} className="text-muted-foreground hover:text-sidebar-foreground">
              <PlusIcon />
              <span>{t('spaces.addChannel')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        <PrivateChannelsNotInRow projectId={projectId} />
      </SidebarMenu>
      <CreateChannelDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
    </FadedScrollArea>
  );
}

/**
 * One space: its tile (initials; the personal space's tile is filled), its
 * name with a lock when private, and its newest message on the line under it.
 * The selected row is the sidebar's active surface.
 */
function SpaceRow({
  projectId,
  space,
  href,
  active,
  name,
  personal,
  isPrivate,
  names,
}: {
  names: (text: string) => string;
  projectId: string;
  /** Null: the personal space before its first open. */
  space: ProjectSpace | null;
  href: string;
  active: boolean;
  name: string;
  personal: boolean;
  isPrivate: boolean;
}) {
  const t = useTranslations('sidebar.spaces');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // The same list the space's Chat tab reads (one cache entry); this row adds no poll of its own.
  const threads = useProjectSessions(projectId, { spaceId: space?.space_id, parent: 'root', enabled: !!space });
  const preview = useMemo(() => spacePreview(threads.sessions, names), [threads.sessions, names]);
  // A two-person private space reads as the other person.
  const other = useOtherPerson(projectId, space);
  const shown = other?.name ?? name;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        size="lg"
        isActive={active}
        tooltip={shown}
        // The row's svgs are forced to size-4: the lock beside the name stays at 12px.
        className="text-sidebar-foreground gap-2.5 px-2 [&_[data-slot=space-lock]]:size-3! [&_[data-slot=agent-mark]>svg]:size-auto!"
      >
        <HoverPrefetchLink
          href={href}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <SpaceAvatar space={space} personal={personal} label={shown} projectId={projectId} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{shown}</span>
              {isPrivate ? (
                <LockSimpleIcon data-slot="space-lock" role="img" aria-label={t('private')} className="text-muted-foreground" />
              ) : null}
            </span>
            <span className="text-muted-foreground truncate text-xs font-normal">{preview ?? t('noMessages')}</span>
          </span>
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
