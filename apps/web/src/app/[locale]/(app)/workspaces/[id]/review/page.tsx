import { ReviewStandalonePage } from '@kortix/ui/customize/sections/view/review-view';

/**
 * /workspaces/[id]/review — Review as its own page beside the app sidebar,
 * outside Customize (2026-11-04): the deck of what waits on the person, then
 * the inbox. `?id=<review item id>` opens one item. `/customize/review`
 * redirects here.
 */
export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewStandalonePage projectId={id} />;
}
