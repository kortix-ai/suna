'use client';

import { useParams } from 'next/navigation';

import { SpacePage } from '@kortix/ui/workspace/space/space-page';

/** /projects/[id]/spaces/[slug] — one space: its room first, then its configured tabs (`?tab=`). */
export default function ProjectSpacePage() {
  const { id, slug } = useParams<{ id: string; slug: string }>();
  return <SpacePage projectId={id} slug={decodeURIComponent(slug)} />;
}
