'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { AppConnectorSplitPage } from '@/features/workspace/capabilities/connectors/detail/app-connector-split-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

export default function ProjectAppConnectorSplitPage() {
  const {
    id: projectId,
    slug,
    connectorSlug,
  } = useParams<{ id: string; slug: string; connectorSlug: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <AppConnectorSplitPage
          projectId={projectId}
          appSlug={decodeURIComponent(slug)}
          connectorSlug={decodeURIComponent(connectorSlug)}
        />
      </Suspense>
    </div>
  );
}
