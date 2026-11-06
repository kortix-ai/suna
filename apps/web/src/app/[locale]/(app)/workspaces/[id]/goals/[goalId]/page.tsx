'use client';

import { useParams } from 'next/navigation';

import { GoalDetail } from '@/features/workspace/goals/goal-detail';

/** /workspaces/[id]/goals/[goalId] — one goal by its `goal_id` (the layout gates the flag). */
export default function ProjectGoalPage() {
  const { id, goalId } = useParams<{ id: string; goalId: string }>();
  return <GoalDetail projectId={id} goalId={decodeURIComponent(goalId)} />;
}
