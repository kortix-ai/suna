'use client';

import { redirect, useParams, useSearchParams } from 'next/navigation';
import type * as React from 'react';
import { Suspense } from 'react';

import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';

/**
 * Legacy spelling. The app page lives at `/connectors/<slug>` now (with
 * `?src=apps` / `?src=computer` naming the non-default catalogues) — this
 * route only forwards old links and bookmarks there, query intact.
 */
// `redirect()` never returns, so the annotation keeps this usable as JSX.
function LegacyCatalogForward(): React.ReactNode {
  const { id: projectId, source, slug } = useParams<{ id: string; source: string; slug: string }>();
  const search = useSearchParams();

  const params = new URLSearchParams(search?.toString() ?? '');
  if (source === 'easy-connect') params.set('src', 'apps');
  else if (source === 'computer') params.set('src', 'computer');
  const suffix = params.toString();
  redirect(
    `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(slug)}${suffix ? `?${suffix}` : ''}`,
  );
}

export default function ProjectCatalogConnectorDetailPage() {
  return (
    <Suspense fallback={<CapabilitiesSkeleton />}>
      <LegacyCatalogForward />
    </Suspense>
  );
}
