'use client';

import { useParams } from 'next/navigation';

import { ConnectorsView } from '@/features/workspace/customize/sections/connectors-view';
import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';

/**
 * Route for the connectors section. Renders the existing view for now — the screen
 * itself migrates to ProjectSectionPage in its own change, so this step is a
 * pure "the URL exists" move with no visual diff below the tab strip.
 */
export default function ConnectorsSectionPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectSectionTabs projectId={projectId} active="connectors" />
      <div className="min-h-0 flex-1">
        <ConnectorsView projectId={projectId} />
      </div>
    </div>
  );
}
