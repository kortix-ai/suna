'use client';

import { ProjectNavRow } from '@/features/workspace/project-sidebar/project-nav-row';

import { useTranslations } from '@/i18n/use-translations';
import { AppWindowIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';

export function ProjectAppsNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;

  if (!projectId) return null;
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
