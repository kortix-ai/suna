'use client';

import { ProjectNavRow } from '@/features/workspace/project-sidebar/project-nav-row';

import { CountBadge } from '@/components/ui/count-badge';
import { useTranslations } from '@/i18n/use-translations';
import type { SidebarNavVisibility } from '@/stores/sidebar-nav-store';
import { useFeatureFlag, useProjectReminders } from '@kortix/sdk/react';
import { AlarmIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';

/**
 * The Reminders entry. Present only while the `reminders` feature flag is on.
 * With the default `visibility="active"` it also needs a reminder that can
 * still fire (active or paused): a project that never uses reminders gets no
 * dead row. `always` lists it whenever the flag is on. The badge counts active reminders — each one is a future model
 * turn, which is the thing worth seeing at a glance. The count is the same
 * tinted tabular `Badge` as the Review row, in purple: "scheduled", not the
 * Review row's amber "waiting on you". Same `HoverPrefetchLink` contract as
 * the Files row.
 */
export function ProjectRemindersNavItem({
  visibility = 'active',
}: {
  visibility?: SidebarNavVisibility;
}) {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const projectId = useParams<{ id: string }>()?.id;
  const gate = useFeatureFlag(projectId, 'reminders');
  const reminders = useProjectReminders(gate.enabled ? projectId : null);
  const isActive = !!pathname && /^\/projects\/[^/]+\/reminders(\/|$)/.test(pathname);

  const list = reminders.data?.reminders ?? [];
  const activeCount = list.filter((reminder) => reminder.state === 'active').length;
  const live = list.some((reminder) => reminder.state !== 'done');
  if (!projectId || !gate.enabled || visibility === 'never') return null;
  if (visibility === 'active' && !live && !isActive) return null;

  return (
    <ProjectNavRow
      active={isActive}
      label={t('reminders')}
      href={`/projects/${projectId}/reminders`}
      prefetch
    >
      <span className="shrink-0">
        <AlarmIcon />
      </span>
      <span className="truncate">{t('reminders')}</span>
      {activeCount > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CountBadge count={activeCount} tone="reminder" />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
