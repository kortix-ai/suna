'use client';

import { useParams } from 'next/navigation';

import { BackendsView } from '@/features/backends/backends-view';

/** /projects/[id]/customize/backends — the Backends tab. Shown in the bar only while the `backends` flag is on. */
export default function ProjectBackendsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  return <BackendsView projectId={projectId} />;
}
