'use client';

import { useParams } from 'next/navigation';

import { EmptyState } from '@/features/layout/section/empty-state';

/**
 * /projects/[id]/commands — stub. Task 7 replaces this with the real
 * commands grid; this task only wires the route and shared tab bar.
 */
export default function ProjectCommandsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <EmptyState title="Commands" />
    </div>
  );
}
