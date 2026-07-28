'use client';

import { useParams } from 'next/navigation';

import { ConnectorsView } from '@/features/workspace/customize/sections/connectors-view';
import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';

/**
 * Route for the connectors section.
 *
 * The tab strip is handed to the view rather than stacked above it, so the
 * catalogue can render it through ProjectSectionPage's `navTabs` slot and the
 * whole screen keeps one scroll container.
 */
export default function ConnectorsSectionPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;

  return (
    <ConnectorsView
      projectId={projectId}
      navTabs={<ProjectSectionTabs projectId={projectId} active="connectors" />}
    />
  );
}
