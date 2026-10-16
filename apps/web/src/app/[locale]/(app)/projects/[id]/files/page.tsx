import { ProjectRepoPage } from '@/features/workspace/project-layout/project-repo-page';

/**
 * /projects/[id]/files — the merged Repo page (KRTX-2444): the repo file
 * browser and the Review Center inbox as the two sections of one git-focused
 * surface. Requires `project.file.read` for the repo section (editor-tier:
 * the API 403s the reads and the page falls back to the review section, which
 * every member holds); the review section needs nothing beyond the page
 * itself. `/projects/[id]/review` and `/projects/[id]/customize/review`
 * redirect into the review section.
 */
export default async function ProjectFilesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectRepoPage projectId={id} section="repo" />;
}
