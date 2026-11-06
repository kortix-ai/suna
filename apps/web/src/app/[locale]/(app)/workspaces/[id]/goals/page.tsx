'use client';

import { useParams } from 'next/navigation';

import { GoalsPage } from '@/features/workspace/goals/goals-page';

/** /projects/[id]/goals — every goal, the ones that need a person first (the layout gates the flag). */
export default function ProjectGoalsPage() {
  const { id } = useParams<{ id: string }>();
  return <GoalsPage projectId={id} />;
}
