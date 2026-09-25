'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { ConnectorsAppReturnBar } from '@/features/workspace/capabilities/connectors/connectors-app-return-bar';
import { ConnectorsPage } from '@/features/workspace/capabilities/connectors/connectors-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

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
 *
 * `ConnectorsAppReturnBar` is the mobile app's way back (nothing without
 * `?return_to`). It sits below the page's flex-1 column, so it takes its own
 * height and covers no row. It reads `useSearchParams()` too, hence its own
 * boundary with no fallback.
 */
export default function ProjectConnectorsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <ConnectorsPage projectId={projectId} />
      </Suspense>
      <Suspense fallback={null}>
        <ConnectorsAppReturnBar />
      </Suspense>
    </div>
  );
}
