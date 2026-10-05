import { ReviewPage } from '@/features/workspace/customize/sections/view/review-view';

/**
 * /projects/[id]/review — the Review Center, a project page of its own. It
 * left the Customize tab bar on 2026-10-02: the inbox where a person approves
 * what agents do is a primary surface, not configuration. The sidebar's Review
 * row opens it; `/customize/review` redirects here. No feature flag gates it:
 * the row shows for anyone holding `project.review.read`, and the view gates
 * acting on `project.review.act`.
 */
export default async function ProjectReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReviewPage projectId={id} />;
}
