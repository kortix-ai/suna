'use client';

import { notFound, useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /workspaces/[id]/artifacts* — the project's artifacts. Artifacts are paths in
 * Files, so they exist wherever the platform stores Files (Platinum): the API
 * serves that as the `artifacts` key. Elsewhere a deep link is not found and no
 * artifact data loads, as for the Drive page.
 */
export default function ProjectArtifactsLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const artifacts = useFeatureFlag(id, 'artifacts');

  if (artifacts.isLoading) return null;
  if (!artifacts.enabled) notFound();
  return <>{children}</>;
}
