'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { CatalogConnectorPage } from '@/features/workspace/capabilities/connectors/detail/catalog-connector-page';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

export default function ProjectCatalogConnectorDetailPage() {
  const {
    id: projectId,
    source,
    slug,
  } = useParams<{
    id: string;
    source: string;
    slug: string;
  }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<CapabilitiesSkeleton />}>
        <CatalogConnectorPage projectId={projectId} sourceValue={source} slug={slug} />
      </Suspense>
    </div>
  );
}
