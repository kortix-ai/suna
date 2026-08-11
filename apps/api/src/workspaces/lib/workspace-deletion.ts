import { getBackend, type GitHostBackend } from '../git-backends';
import {
  buildConnectionRef,
  getWorkspaceGitConnection,
  getWorkspaceGitRemote,
} from './git';
import type { WorkspaceGitConnectionRow, WorkspaceRow } from './serializers';

export interface WorkspaceDeletionDeps {
  getConnection(workspaceId: string): Promise<WorkspaceGitConnectionRow | null>;
  getBackend(provider: string): Pick<GitHostBackend, 'deleteRepo'>;
}

const defaultDeps: WorkspaceDeletionDeps = {
  getConnection: getWorkspaceGitConnection,
  getBackend,
};

/** Delete only Kortix-managed upstreams; user-connected repositories are never touched. */
export async function deleteManagedWorkspaceRepo(
  workspace: WorkspaceRow,
  deps: WorkspaceDeletionDeps = defaultDeps,
): Promise<boolean> {
  const connection = await deps.getConnection(workspace.workspaceId);
  const remote = getWorkspaceGitRemote(workspace, connection);
  if (!remote.managed) return false;

  const backend = deps.getBackend(remote.provider);
  await backend.deleteRepo(buildConnectionRef(workspace, remote));
  return true;
}
