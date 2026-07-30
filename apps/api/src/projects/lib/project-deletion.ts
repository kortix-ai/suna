import { getBackend, type GitHostBackend } from '../git-backends';
import {
  buildConnectionRef,
  getProjectGitConnection,
  getProjectGitRemote,
} from './git';
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
