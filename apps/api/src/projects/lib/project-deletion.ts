import { getBackend, type GitHostBackend } from '../git-backends';
import {
  buildConnectionRef,
  getProjectGitConnection,
  getProjectGitRemote,
} from './git';
import { connectors, projectSessionConnectorBindings } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ProjectGitConnectionRow, ProjectRow } from './serializers';

export interface ProjectDeletionDeps {
  getConnection(projectId: string): Promise<ProjectGitConnectionRow | null>;
  getBackend(provider: string): Pick<GitHostBackend, 'deleteRepo'>;
}

const defaultDeps: ProjectDeletionDeps = {
  getConnection: getProjectGitConnection,
  getBackend,
};

/** Delete only Kortix-managed upstreams; user-connected repositories are never touched. */
export async function deleteManagedProjectRepo(
  project: ProjectRow,
  deps: ProjectDeletionDeps = defaultDeps,
): Promise<boolean> {
  const connection = await deps.getConnection(project.projectId);
  const remote = getProjectGitRemote(project, connection);
  if (!remote.managed) return false;

  const backend = deps.getBackend(remote.provider);
  await backend.deleteRepo(buildConnectionRef(project, remote));
  return true;
}

/**
 * Delete a project's connector rows. Called by the project-delete route BEFORE
 * the archive: after it the project answers 404, so a failed purge could never
 * be retried. Without this, the rows outlived the purged project — the project
 * row survives its archive as an internal tombstone, so the
 * `connectors.project_id` FK cascade never fires, and the connectors list kept
 * serving rows for projects that no longer exist.
 *
 * The database cascades the rest of the connector family (connections,
 * credentials, policies, actions); `connector_calls` and event-subscription
 * references keep their rows with the connector reference nulled. Connector
 * state keyed by the PROJECT instead (project policies, settings, sync
 * fences) is archive-surviving by design — it cascades only when the
 * tombstone row itself goes.
 *
 * Session connector bindings RESTRICT on the connector, so they go first —
 * both deletes in one transaction, because a connectors delete without the
 * bindings delete would leave the project purged but half its connector
 * family behind.
 */
export async function purgeProjectConnectors(projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectSessionConnectorBindings)
      .where(eq(projectSessionConnectorBindings.projectId, projectId));
    await tx.delete(connectors).where(eq(connectors.projectId, projectId));
  });
}
