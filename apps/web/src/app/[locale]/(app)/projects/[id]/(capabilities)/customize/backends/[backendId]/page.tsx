'use client';

import { useParams } from 'next/navigation';

import { BackendDetailView } from '@/features/backends/backend-detail-view';

/** /projects/[id]/customize/backends/[backendId] — one backend: its Convex dashboard, under the Customize bar. */
export default function ProjectBackendPage() {
  const { id: projectId, backendId } = useParams<{ id: string; backendId: string }>();
  return <BackendDetailView projectId={projectId} backendId={decodeURIComponent(backendId)} />;
}
