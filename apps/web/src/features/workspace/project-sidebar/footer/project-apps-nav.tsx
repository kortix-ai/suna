'use client';

import { ProjectNavRow } from '@/features/workspace/project-sidebar/project-nav-row';

import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag } from '@kortix/sdk/react';
import { AppWindowIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';

export function ProjectAppsNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const appsGate = useFeatureFlag(projectId, 'apps');

  if (!projectId) return null;
  /* Fail-closed like every other flagged surface: the entry exists once the
     project turns the `apps` feature flag on in Settings → Feature flags.
     Loading counts as disabled. Apps is a STABLE flag — an ordinary per-project
     opt-in, so the row carries no stability badge. */
  if (!appsGate.enabled) return null;
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
