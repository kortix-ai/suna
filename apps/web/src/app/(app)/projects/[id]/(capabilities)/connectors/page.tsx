'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';
import { ConnectorsPage } from '@/features/workspace/capabilities/connectors/connectors-page';

/**
 * /projects/[id]/connectors — the standalone Connectors catalog. See
 * `features/workspace/capabilities/connectors/connectors-page.tsx` for the
 * page body.
 *
 * The `Suspense` boundary is required, not decorative: `ConnectorsPage` reads
 * `useSearchParams()` (the `?c=` detail selection and the `?oauth2=` return
 * leg), and Next refuses to prerender a route that does so unbounded. Same
 * pattern as `app/(app)/connectors/page.tsx`. The fallback is the route
 * group's own skeleton, so the boundary cannot introduce a layout jump.
 */
export default function ProjectConnectorsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <ConnectorsPage projectId={projectId} />
      </Suspense>
    </div>
  );
}
