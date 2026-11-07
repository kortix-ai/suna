import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { projectsView } from '../../workspaces/rows';

/** The three git columns of a project's `projectsView` row; undefined when the project is gone. */
export async function loadGitProjectRow(projectId: string) {
  const [project] = await db
    .select({
      repoUrl: projectsView.repoUrl,
      defaultBranch: projectsView.defaultBranch,
      manifestPath: projectsView.manifestPath,
    })
    .from(projectsView)
    .where(eq(projectsView.projectId, projectId))
    .limit(1);
  return project;
}
