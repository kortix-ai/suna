import { ReviewView } from '@kortix/ui/customize/sections/view/review-view';
import { ProjectPageHeader } from '@kortix/ui/workspace';

/**
 * /projects/[id]/customize/review — the Review Center, a Customize tab
 * (`reviewHref`). It draws its own header (Customize has no top bar); its
 * access rule comes from the `(capabilities)` layout: only a caller holding `project.review.act` reaches
 * it. `?id=<review item id>` opens one item.
 */
export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectPageHeader title="Review" />
      <ReviewView projectId={id} />
    </div>
  );
}
