'use client';

import { useParams } from 'next/navigation';

import { TriggersPage } from '@kortix/ui/customize';

/**
 * /projects/[id]/triggers — the standalone Triggers page, replacing the old
 * split Schedules (`/schedules`) and Webhooks (`/webhooks`) capability pages.
 * A trigger is one resource with two ways to start it, so it is one tab, one
 * route, one list.
 *
 * The tab opens for a caller with `project.trigger.read` plus one trigger
 * write leaf (`TAB_PREFERENCE` in `project-sidebar/project-settings-nav.tsx`):
 * a member who can only read and fire triggers does not see trigger
 * configuration. The API still enforces each leaf on its own route.
 */
export default function ProjectTriggersPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TriggersPage projectId={projectId} />
    </div>
  );
}
