'use client';

import { SunDimIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { uiRoutes } from '../../../lib/routes';
import { useUiPathname } from '../../../providers/ui-provider';

/**
 * The Memory row: the project's Company memory and the viewer's My Kortix
 * memory. The sidebar draws it with `project_channels` or Files (`drives`) on;
 * a host that serves no Memory page gets no row.
 */
export function ProjectMemoryNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.memory.company');
  const pathname = useUiPathname();
  const href = uiRoutes().memory(projectId);
  if (!href) return null;
  return (
    <ProjectNavRow active={pathname?.startsWith(href) === true} label={t('title')} href={href} prefetch>
      <span className="shrink-0">
        <SunDimIcon />
      </span>
      {t('title')}
    </ProjectNavRow>
  );
}
