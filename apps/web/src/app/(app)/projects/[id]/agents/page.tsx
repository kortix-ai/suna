'use client';

import { useParams } from 'next/navigation';

import { AgentsView } from '@/features/workspace/customize/sections/view/agents-view';
import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';

/**
 * Route for the agents section. Renders the existing view for now — the screen
 * itself migrates to ProjectSectionPage in its own change, so this step is a
 * pure "the URL exists" move with no visual diff below the tab strip.
 */
export default function AgentsSectionPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectSectionTabs projectId={projectId} active="agents" />
      <div className="min-h-0 flex-1">
        <AgentsView projectId={projectId} />
      </div>
    </div>
  );
}
