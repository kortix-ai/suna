'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { ConnectedConnectorPage } from '@/features/workspace/capabilities/connectors/detail/connected-connector-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

export default function ProjectConnectorDetailPage() {
  const { id: projectId, slug } = useParams<{ id: string; slug: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <ConnectedConnectorPage projectId={projectId} slug={slug} />
      </Suspense>
    </div>
  );
}
