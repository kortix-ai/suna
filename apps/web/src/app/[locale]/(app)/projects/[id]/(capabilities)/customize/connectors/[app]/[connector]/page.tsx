'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { ConnectorsAppReturnBar } from '@/features/workspace/capabilities/connectors/connectors-app-return-bar';
import { ConnectorPage } from '@/features/workspace/capabilities/connectors/detail/connector-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

/** A hand-typed URL may carry a malformed escape; use the raw segment then. */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * /projects/[id]/customize/connectors/[app]/[connector] — one connector, as a
 * page. See `features/workspace/capabilities/connectors/detail/connector-page.tsx`.
 *
 * The `Suspense` boundary is required: `ConnectorPage` reads
 * `useSearchParams()` (the tab, the install hand-off, the `?oauth2=` return
 * leg). Same pattern as the list route beside this one.
 */
export default function ProjectConnectorDetailPage() {
  const {
    id: projectId,
    app,
    connector,
  } = useParams<{
    id: string;
    app: string;
    connector: string;
  }>();
  const connectorSlug = decodeSegment(connector);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <ConnectorPage
          key={connectorSlug}
          projectId={projectId}
          appSegment={decodeSegment(app)}
          connectorSlug={connectorSlug}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ConnectorsAppReturnBar />
      </Suspense>
    </div>
  );
}
