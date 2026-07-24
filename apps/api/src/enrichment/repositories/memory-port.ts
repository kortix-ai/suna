/**
 * Binds the memory writer to a real project repository.
 *
 * Follows the background-commit precedent in `executor/channel-manifest.ts`:
 * given only a projectId, load the row and hand it to the repo-commit engine,
 * which resolves git credentials internally. Nothing here handles auth, and
 * nothing needs a request context.
 *
 * `commitMany` goes straight through `commitMultipleFilesToBranch` (the same
 * multi-file/atomic-commit engine `agent-config.ts` uses for its governance +
 * behavior writes) rather than the GitHub-Contents-API fast path
 * `commitRepoFile` used for single files — a domain write is a whole folder
 * plus the index in one commit, which only the git-CLI tree/commit-tree path
 * can do atomically across providers.
 */
import { commitMultipleFilesToBranch } from '../../projects/git/branches';
import { readRepoFile } from '../../projects/git/files';
import { withProjectGitAuth } from '../../projects/lib/git';
import type { ProjectRow } from '../../projects/lib/serializers';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { MemoryPort } from '../services/memory-write';

export async function loadProject(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export function createProjectMemoryPort(project: ProjectRow): MemoryPort {
  return {
    read: async (path) => {
      try {
        return await readRepoFile(project as never, path);
      } catch {
        // `git show` fails for a path that does not exist at the ref, which is
        // the normal first-write case rather than an error.
        return null;
      }
    },
    commitMany: async ({ files, deletes, message }) => {
      const gitProject = await withProjectGitAuth(project);
      await commitMultipleFilesToBranch(gitProject, {
        files,
        deletes,
        message,
        branch: project.defaultBranch,
      });
    },
  };
}
