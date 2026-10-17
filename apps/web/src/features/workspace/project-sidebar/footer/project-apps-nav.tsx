'use client';

import { ProjectNavRow } from '@/features/workspace/project-sidebar/project-nav-row';

import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useProjectApps } from '@kortix/sdk/react';
import { AppWindowIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';

/**
 * The Apps row shows to a caller who can deploy an App, or while the project
 * has an App they can open. A member who can do neither got an empty page
 * that told them to "ask an agent to build one". Nothing shows until both
 * answers land, so the row never appears and then vanishes.
 */
export function useAppsRowVisible(projectId: string | undefined): boolean {
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY);
  const apps = useProjectApps(projectId);
  if (canDeploy.allowed === true) return true;
  if (canDeploy.isLoading) return false;
  return (apps.data?.length ?? 0) > 0;
}

export function ProjectAppsNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const visible = useAppsRowVisible(projectId);

  if (!projectId || !visible) return null;
  return (
    <ProjectNavRow
      active={pathname?.startsWith(`/projects/${projectId}/apps`) === true}
      label={tI18nComplete.raw('text89dd748442c1')}
      href={`/projects/${projectId}/apps`}
      prefetch
    >
      {/* shrink-0 so the glyph keeps its box when the label is long or the
              sidebar is narrow — the sibling rows wrap their icons the same way. */}
      <span className="shrink-0">
        <AppWindowIcon />
      </span>
      {tI18nComplete.raw('text89dd748442c1')}
    </ProjectNavRow>
  );
}
