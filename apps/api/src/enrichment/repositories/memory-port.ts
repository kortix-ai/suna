/**
 * Binds the memory writer to a real project repository.
 *
 * Follows the background-commit precedent in `executor/channel-manifest.ts`:
 * given only a projectId, load the row and hand it to the repo-commit engine,
 * which resolves git credentials internally. Nothing here handles auth, and
 * nothing needs a request context.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { commitRepoFile } from '../../projects';
import { readRepoFile } from '../../projects/git/files';
import { db } from '../../shared/db';
import type { MemoryPort } from '../services/memory-write';

type ProjectRow = typeof projects.$inferSelect;

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
    commit: async (path, content, message) => {
      const result = await commitRepoFile(project, path, content, message);
      if ('error' in result) {
        throw new Error(`${result.error} (status ${result.status})`);
      }
    },
  };
}
