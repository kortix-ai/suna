'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { ProjectSettingsPage } from '@/features/workspace/capabilities/project-settings/project-settings-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

/**
 * /projects/[id]/config — the Customize bar's "Settings" tab: every
 * project-scoped configuration surface that used to sit in the Settings
 * overlay's `Workspace` and `Agent` rail groups, plus Feature flags and
 * Upgrades. See
 * `features/workspace/capabilities/project-settings/project-settings-page.tsx`
 * for the page body and why the move happened.
 *
 * The segment is `config`, not `settings`: `/projects/[id]/settings` is the
 * overlay's own deep-link route (it opens the store and bounces), so the two
 * cannot share a name.
 *
 * The `Suspense` boundary is required, not decorative: the page reads
 * `useSearchParams()` for `?section=`, and Next refuses to prerender a route
 * that does so unbounded. Same pattern as the Connectors page. The fallback is
 * the route group's own skeleton, so the boundary cannot introduce a jump.
 *
 * Each pane inside re-checks its own permissions and the API re-checks every
 * mutation; the sub-nav only decides which rows are worth showing.
 */
export default function ProjectConfigPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <ProjectSettingsPage projectId={projectId} />
      </Suspense>
    </div>
  );
}
