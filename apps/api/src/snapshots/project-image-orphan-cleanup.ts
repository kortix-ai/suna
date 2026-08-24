import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { deleteProjectSandboxImage } from './project-image-delete';

type ProjectLifecycleRow = { status: 'active' | 'archived' } | null;

export interface ProjectImageOrphanCleanupDeps {
  readProject(projectId: string): Promise<ProjectLifecycleRow>;
  deleteProjectImage(snapshotName: string, provider: string): Promise<unknown>;
  info(message: string): void;
  warn(message: string): void;
}

export type ProjectImageOrphanCleanupResult =
  | { outcome: 'deleted'; reason: 'project_absent' | 'project_archived' }
  | {
      outcome: 'kept';
      reason: 'project_active' | 'project_read_failed' | 'image_delete_failed';
    };

const defaultDeps: ProjectImageOrphanCleanupDeps = {
  readProject: async (projectId) => {
    const [project] = await db
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    return project ?? null;
  },
  deleteProjectImage: deleteProjectSandboxImage,
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reap one optional FAST image that finished after its project was deleted.
 * A failed lifecycle read keeps the image because provider deletion is not
 * reversible. An active row also keeps it, including the impossible-but-safe
 * UUID-reuse case where another project now owns the same primary key.
 */
export async function cleanupOrphanedFastProjectImageBuild(
  input: { projectId: string; snapshotName: string; provider: string },
  deps: ProjectImageOrphanCleanupDeps = defaultDeps,
): Promise<ProjectImageOrphanCleanupResult> {
  let project: ProjectLifecycleRow;
  try {
    project = await deps.readProject(input.projectId);
  } catch (error) {
    deps.warn(
      `[snapshots] optional FAST orphan check kept ${input.snapshotName}: ` +
        `project ${input.projectId} state is unverified (${errorMessage(error)})`,
    );
    return { outcome: 'kept', reason: 'project_read_failed' };
  }

  if (project?.status === 'active') {
    deps.info(
      `[snapshots] optional FAST orphan check kept ${input.snapshotName}: ` +
        `project ${input.projectId} remains active`,
    );
    return { outcome: 'kept', reason: 'project_active' };
  }

  const reason = project ? 'project_archived' : 'project_absent';
  try {
    await deps.deleteProjectImage(input.snapshotName, input.provider);
  } catch (error) {
    deps.warn(
      `[snapshots] optional FAST orphan check could not delete ${input.snapshotName} ` +
        `from ${input.provider}: ${errorMessage(error)}`,
    );
    return { outcome: 'kept', reason: 'image_delete_failed' };
  }

  deps.info(
    `[snapshots] optional FAST orphan check deleted ${input.snapshotName} ` +
      `from ${input.provider}: project ${input.projectId} is ${project ? 'archived' : 'absent'}`,
  );
  return { outcome: 'deleted', reason };
}
