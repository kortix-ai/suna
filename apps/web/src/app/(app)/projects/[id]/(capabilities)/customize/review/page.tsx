'use client';

import { useParams } from 'next/navigation';

import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';

/**
 * /projects/[id]/review — the Review Center inbox as its own capability tab,
 * beside Models / Connectors / Agents / Skills / Triggers (Jay, 2026-09-02:
 * "move the review component to the same line where the agent, skill, model,
 * connector, trigger are listed").
 *
 * It was the `review` section of `/projects/[id]/config` until that page was
 * retired the same day; every other section of it moved into the Settings
 * overlay's Workspace group, and this one — an inbox, not configuration —
 * moved up onto the bar instead. Flag-gated on `review_center` exactly as the
 * section was: the tab bar hides the tab (`visibleCapabilityTabs`) and the
 * view itself gates acting on `project.review.act`.
 */
export default function ProjectReviewPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ReviewView projectId={projectId} />
    </div>
  );
}
