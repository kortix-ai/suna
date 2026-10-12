'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Badge } from '@/components/ui/badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag, useProjectReminders } from '@kortix/sdk/react';
import { AlarmIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The Reminders entry. Present only while the `reminders` feature flag is on
 * and the project has a reminder that can
 * still fire (active or paused): a project that never uses reminders gets no
 * dead row. The badge counts active reminders — each one is a future model
 * turn, which is the thing worth seeing at a glance. The count is the same
 * tinted tabular `Badge` as the Review row, in purple: "scheduled", not the
 * Review row's amber "waiting on you". Same `HoverPrefetchLink` contract as
 * the Files row.
 */
export function ProjectRemindersNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const projectId = useParams<{ id: string }>()?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const gate = useFeatureFlag(projectId, 'reminders');
  const reminders = useProjectReminders(gate.enabled ? projectId : null);
  const isActive = !!pathname && /^\/projects\/[^/]+\/reminders(\/|$)/.test(pathname);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const list = reminders.data?.reminders ?? [];
  const activeCount = list.filter((reminder) => reminder.state === 'active').length;
  const live = list.some((reminder) => reminder.state !== 'done');
  if (!projectId || !gate.enabled || (!live && !isActive)) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={t('reminders')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink href={`/projects/${projectId}/reminders`} prefetch onClick={handleClick}>
          <span className="shrink-0">
            <AlarmIcon />
          </span>
          <span className="truncate">{t('reminders')}</span>
          {activeCount > 0 ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Badge
                variant="transparent"
                size="tabular"
                className="bg-kortix-purple/15 text-current"
              >
                {activeCount > 99 ? '99+' : activeCount}
              </Badge>
            </span>
          ) : null}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
