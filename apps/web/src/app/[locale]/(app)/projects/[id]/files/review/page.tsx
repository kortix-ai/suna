import { ProjectRepoPage } from '@/features/workspace/project-layout/project-repo-page';

/**
 * /projects/[id]/files/review — the Review Center as the review section of
 * the merged Repo page (KRTX-2444). The `?id=<review item id>` deep link the
 * session briefs mint keeps working: it lands on this section and the inbox
 * opens that item.
 */
export default async function ProjectRepoReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectRepoPage projectId={id} section="review" />;
}
