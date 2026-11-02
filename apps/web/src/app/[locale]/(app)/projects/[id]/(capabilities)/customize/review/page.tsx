import { ReviewPage } from '@kortix/ui/customize/sections/view/review-view';

/**
 * /projects/[id]/customize/review — the Review Center, a Customize page
 * (`reviewHref`). `ReviewPage` draws the one Customize header, with its title
 * from the i18n catalog (Customize has no top bar). Its access rule comes from
 * the `(capabilities)` layout: only a caller holding `project.review.act`
 * reaches it. `?id=<review item id>` opens one item.
 */
export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewPage projectId={id} />;
}
