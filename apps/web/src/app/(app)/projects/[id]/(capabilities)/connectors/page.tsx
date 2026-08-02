'use client';

import { useParams } from 'next/navigation';

import { EmptyState } from '@/features/layout/section/empty-state';

/**
 * /projects/[id]/connectors — stub. Task 4 replaces this with the real
 * connectors grid; this task only wires the route and shared tab bar.
 */
export default function ProjectConnectorsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <EmptyState title="Connectors" />
    </div>
  );
}
