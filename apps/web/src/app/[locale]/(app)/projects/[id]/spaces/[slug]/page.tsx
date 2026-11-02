'use client';

import { notFound, useParams } from 'next/navigation';

import { useFeatureFlag } from '@kortix/sdk/react';
import { SPACES_FLAG } from '@kortix/ui/workspace';
import { SpacePage } from '@kortix/ui/workspace/space/space-page';

/**
 * /projects/[id]/spaces/[slug] — one space: its room first, then its configured
 * tabs (`?tab=`). Spaces are Work in progress: the page exists only with the
 * project's `project_channels` flag on, like a channel page (`c/[slug]`).
 */
export default function ProjectSpacePage() {
  const { id, slug } = useParams<{ id: string; slug: string }>();
  const spaces = useFeatureFlag(id, SPACES_FLAG);

  if (!spaces.isLoading && !spaces.enabled) notFound();
  if (!spaces.enabled) return null;
  return <SpacePage projectId={id} slug={decodeURIComponent(slug)} />;
}
