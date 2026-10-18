import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';

/**
 * /projects/[id]/customize/review — the Review Center, a Customize tab
 * (`reviewHref`). The tab bar and its access rule come from the
 * `(capabilities)` layout: only a caller holding `project.review.act` reaches
 * it. `?id=<review item id>` opens one item.
 */
export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ReviewView projectId={id} />
    </div>
  );
}
