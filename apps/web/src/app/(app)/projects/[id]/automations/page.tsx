'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { ScheduleView } from '@/components/projects/schedule-view';
import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';

/**
 * Automations — schedules and webhooks on one page.
 *
 * They were two rail entries over one API resource with one set of IAM leaves.
 * `?type=webhook` selects the webhook side; anything else is the schedule side.
 */
export default function AutomationsSectionPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const projectId = params?.id ?? '';
  const type = searchParams.get('type') === 'webhook' ? 'webhook' : 'cron';

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectSectionTabs projectId={projectId} active="automations" />
      <div className="min-h-0 flex-1">
        <ScheduleView projectId={projectId} type={type} />
      </div>
    </div>
  );
}
