'use client';

import { uiRoutes } from '../../../lib/routes';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { useTranslations } from '../../../i18n';
import { useFeatureFlag } from '@kortix/sdk/react';
import { CardsThreeIcon } from '@phosphor-icons/react';
import { useUiPathname } from '../../../providers/ui-provider';

/** The Artifacts row shows only with the `artifacts` flag on. */
export function useArtifactsRowVisible(projectId: string | undefined): boolean {
  return useFeatureFlag(projectId, 'artifacts').enabled;
}

/** The Artifacts row: docs, slides, boards and dashboards published in the project. */
export function ProjectArtifactsNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const visible = useArtifactsRowVisible(projectId);
  const href = projectId ? uiRoutes().artifacts(projectId) : null;
  if (!href || !visible) return null;
  return (
    <ProjectNavRow active={pathname?.startsWith(href) === true} label={t('artifacts')} href={href} prefetch>
      <span className="shrink-0">
        <CardsThreeIcon />
      </span>
      {t('artifacts')}
    </ProjectNavRow>
  );
}
