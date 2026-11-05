'use client';

import { CaretRightIcon, DotsThreeIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { selectExpandedIds, useSessionExpandedStore } from '../../internal/stores/session-expanded-store';
import { cn } from '../../lib/utils';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../../primitives/sidebar';
import { ProjectNavItems } from './project-nav-items';
import { ProjectSessionList } from './project-session-list';

/** Open state lives in the persisted expanded store (closed by default), beside Sessions. */
const MORE_SECTION_ID = 'section:sidebar-more';

/**
 * Spaces on (`chat`): one group pinned at the bottom of the sidebar that
 * holds everything that is not a space: Customize, Drive, Apps, Artifacts
 * the session list (with its own "+", New session as before), and the
 * connect and upgrade rows (`footer`). Closed by
 * default; the choice persists per project. The header is a real button
 * (`aria-expanded`), so the keyboard opens it.
 */
export function SidebarMoreGroup({ projectId, footer }: { projectId: string; /** Connect rows and the upgrade row, at the end of the group. */ footer?: ReactNode }) {
  const t = useTranslations('sidebar.spaces');
  const expanded = useSessionExpandedStore(selectExpandedIds(projectId));
  const toggleExpanded = useSessionExpandedStore((state) => state.toggleExpanded);
  const open = expanded.includes(MORE_SECTION_ID);
  return (
    <Disclosure
      open={open}
      onOpenChange={() => toggleExpanded(projectId, MORE_SECTION_ID)}
      className={cn('group/more flex min-h-0 flex-col', open ? 'max-h-1/2' : 'shrink-0')}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <SidebarMenu>
        <SidebarMenuItem>
          <DisclosureTrigger>
            <SidebarMenuButton className="text-muted-foreground hover:text-sidebar-foreground">
              <DotsThreeIcon weight="bold" />
              <span className="min-w-0 flex-1 truncate">{t('more')}</span>
              <CaretRightIcon
                aria-hidden
                className={cn('size-3! shrink-0 transition-transform duration-(--duration-fast) ease-out motion-reduce:transition-none', open && 'rotate-90')}
              />
            </SidebarMenuButton>
          </DisclosureTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <DisclosureContent className="flex min-h-0 flex-1 flex-col" contentClassName="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pt-1">
        <SidebarMenu>
          <ProjectNavItems projectId={projectId} />
        </SidebarMenu>
        <ProjectSessionList projectId={projectId} secondary />
        {footer}
      </DisclosureContent>
    </Disclosure>
  );
}
