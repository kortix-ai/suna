'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { ConnectorsAppReturnBar } from '@/features/workspace/capabilities/connectors/connectors-app-return-bar';
import { AppPage } from '@/features/workspace/capabilities/connectors/detail/app-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

/**
 * /projects/[id]/customize/connectors/[app] — one catalogue app. See
 * `features/workspace/capabilities/connectors/detail/app-page.tsx`.
 *
 * The `Suspense` boundary is required: `AppPage` reads `useSearchParams()`
 * (`?id=` for a Discover app, `?src=apps` for a managed one).
 */
export default function ProjectConnectorAppPage() {
  const { id: projectId, app } = useParams<{ id: string; app: string }>();
  let appSegment = app;
  try {
    appSegment = decodeURIComponent(app);
  } catch {
    // A malformed escape in a hand-typed URL: the page's not-found state answers.
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <AppPage key={appSegment} projectId={projectId} appSegment={appSegment} />
      </Suspense>
      <Suspense fallback={null}>
        <ConnectorsAppReturnBar />
      </Suspense>
    </div>
  );
}
