'use client';

/**
 * /projects/[id]/customize — single-page Customize surface.
 *
 * Hosts every per-project config (Files, Skills, Agents, Commands, Secrets,
 * Schedules, Webhooks, Channels, Settings) behind a left rail. Section
 * selection is driven by the `?section=` search param so a refresh / share
 * lands on the same tab.
 *
 * Wrapped in `ProjectShell` so the project sidebar + session tab bar stay
 * anchored — Customize is just another tab among the open project tabs.
 */

import { use, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';

import { CustomizeView } from '@/components/projects/customize/customize-view';
import { ProjectShell } from '@/components/projects/project-shell';
import {
  DEFAULT_CUSTOMIZE_SECTION,
  parseCustomizeSection,
} from '@/lib/customize-sections';

export default function ProjectCustomizePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const searchParams = useSearchParams();
  const section = useMemo(
    () =>
      parseCustomizeSection(searchParams.get('section')) ?? DEFAULT_CUSTOMIZE_SECTION,
    [searchParams],
  );

  return (
    <ProjectShell projectId={projectId}>
      <CustomizeView projectId={projectId} section={section} />
    </ProjectShell>
  );
}
