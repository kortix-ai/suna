'use client';

import { useParams } from 'next/navigation';

import { TriggersPage } from '@/features/workspace/capabilities/triggers/triggers-page';

/**
 * /projects/[id]/triggers — the standalone Triggers page, replacing the old
 * split Schedules (`/schedules`) and Webhooks (`/webhooks`) capability pages.
 * A trigger is one resource with two ways to start it, so it is one tab, one
 * route, one list.
 *
 * Access is `project.trigger.read`, which the API enforces: a caller without it
 * gets a 403 from the triggers list and `ScheduleView` renders "You don't have
 * access" in place of the list. The sidebar's Customize row gates on the same
 * leaf (`TAB_PREFERENCE` in `project-sidebar/project-settings-nav.tsx`) so it
 * never lands anyone on a tab they cannot read.
 */
export default function ProjectTriggersPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TriggersPage projectId={projectId} />
    </div>
  );
}
