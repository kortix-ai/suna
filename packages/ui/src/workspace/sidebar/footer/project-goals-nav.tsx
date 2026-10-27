'use client';

import { uiRoutes } from '../../../lib/routes';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { CountBadge } from '../../../primitives/count-badge';
import { useTranslations } from '../../../i18n';
import { useFeatureFlag, useProjectGoals } from '@kortix/sdk/react';
import { TargetIcon } from '@phosphor-icons/react';
import { useUiPathname } from '../../../providers/ui-provider';
import { goalNeedsYou } from '../../../internal/goals/goal-meta';

/** The Goals row shows only with the `goals` flag on. */
export function useGoalsRowVisible(projectId: string | undefined): boolean {
  return useFeatureFlag(projectId, 'goals').enabled;
}

/** The Goals row, with the count of goals that wait on a person or need attention. */
export function ProjectGoalsNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const visible = useGoalsRowVisible(projectId);
  const goals = useProjectGoals(visible ? projectId : null);
  const needsYou = (goals.data ?? []).filter(goalNeedsYou).length;

  const href = projectId ? uiRoutes().goals(projectId) : null;
  if (!href || !visible) return null;
  return (
    <ProjectNavRow active={pathname?.startsWith(href) === true} label={t('goals')} href={href} prefetch>
      <span className="shrink-0">
        <TargetIcon />
      </span>
      {t('goals')}
      {needsYou > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CountBadge count={needsYou} tone="waiting" />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
