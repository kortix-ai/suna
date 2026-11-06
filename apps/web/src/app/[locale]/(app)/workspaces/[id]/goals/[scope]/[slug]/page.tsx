'use client';

import { useParams } from 'next/navigation';

import { GoalDetail } from '@/features/workspace/goals/goal-detail';

/** /projects/[id]/goals/[scope]/[slug] — one goal (the layout gates the flag). */
export default function ProjectGoalPage() {
  const { id, scope, slug } = useParams<{ id: string; scope: string; slug: string }>();
  return <GoalDetail projectId={id} scope={scope} slug={decodeURIComponent(slug)} />;
}
