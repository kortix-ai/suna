'use client';

/**
 * /projects/[id]/customize/[section] — path-based Customize deep links.
 *
 * Mirrors the query-param Customize page while giving Cmd+K and browser
 * bookmarks stable URLs such as `/customize/skills` and `/customize/settings`.
 */

import { useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

import { CustomizeView } from '@/components/projects/customize/customize-view';
import { ProjectShell } from '@/components/projects/project-shell';
import {
  DEFAULT_CUSTOMIZE_SECTION,
  parseCustomizeSection,
} from '@/lib/customize-sections';

export default function ProjectCustomizeSectionPage() {
  const params = useParams<{ id: string; section: string }>();
  const projectId = params?.id ?? '';
  const rawSection = params?.section;
  const searchParams = useSearchParams();
  const section = useMemo(
    () =>
      parseCustomizeSection(rawSection) ??
      parseCustomizeSection(searchParams.get('section')) ??
      DEFAULT_CUSTOMIZE_SECTION,
    [rawSection, searchParams],
  );

  return (
    <ProjectShell projectId={projectId}>
      <CustomizeView projectId={projectId} section={section} />
    </ProjectShell>
  );
}
