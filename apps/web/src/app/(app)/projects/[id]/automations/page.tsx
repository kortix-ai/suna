'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { AutomationsView } from '@/features/workspace/automations/automations-view';
import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';

/**
 * Automations — schedules and webhooks on one page.
 *
 * They were two rail entries over one API resource with one set of IAM leaves.
 * `?type=webhook` preselects the webhook filter for old deep links.
 */
export default function AutomationsSectionPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const projectId = params?.id ?? '';
  const initialFilter = searchParams.get('type') === 'webhook' ? 'webhook' : 'all';

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectSectionTabs projectId={projectId} active="automations" />
      <div className="min-h-0 flex-1">
        <AutomationsView projectId={projectId} initialFilter={initialFilter} />
      </div>
    </div>
  );
}
