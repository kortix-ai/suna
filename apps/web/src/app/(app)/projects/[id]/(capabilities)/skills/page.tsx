'use client';

import { useParams } from 'next/navigation';

import { EmptyState } from '@/features/layout/section/empty-state';

/**
 * /projects/[id]/skills — stub. Task 6 replaces this with the real skills
 * grid; this task only wires the route and shared tab bar.
 */
export default function ProjectSkillsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <EmptyState title="Skills" />
    </div>
  );
}
