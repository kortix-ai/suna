'use client';

import { useParams } from 'next/navigation';

import { GoalDetail } from '@/features/workspace/goals/goal-detail';

/**
 * /workspaces/[id]/goals/[scope]/[slug] — the link shape before goals had ids.
 * The first segment is the old scope (`company` / `personal`); Next.js names
 * it `goalId` because it shares the level with `/goals/[goalId]`. The page
 * resolves the slug to the goal when it is unique and moves to its id link.
 */
export default function LegacyGoalPage() {
  const { id, goalId: scope, slug } = useParams<{ id: string; goalId: string; slug: string }>();
  return <GoalDetail projectId={id} legacy={{ scope, slug: decodeURIComponent(slug) }} />;
}
