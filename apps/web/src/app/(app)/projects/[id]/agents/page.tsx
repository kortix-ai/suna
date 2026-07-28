'use client';

import { useParams } from 'next/navigation';

import { AgentsView } from '@/features/workspace/customize/sections/view/agents-view';
import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';

/**
 * Route for the agents section. The screen is a ProjectSectionPage now, and
 * that shell owns the whole frame — including the section tab strip, which it
 * renders above its own header. So the route hands the tabs down instead of
 * stacking its own wrapper around the view.
 */
export default function AgentsSectionPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;

  return (
    <AgentsView
      projectId={projectId}
      navTabs={<ProjectSectionTabs projectId={projectId} active="agents" />}
    />
  );
}
