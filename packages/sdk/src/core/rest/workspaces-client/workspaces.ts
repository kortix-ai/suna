// Canonical Workspace collection and item operations.
//
// The database still stores the compatibility `project_*` identifiers during
// the expand phase. The public Workspace API uses `workspace_*` identifiers.

import { type ApiClientOptions, backendApi } from '../../http/api-client';
import type {
  CreateProjectRepoInput,
  KortixProject,
  ProjectConfigSummary,
  ProjectDetail,
  ProjectInput,
  ProvisionProjectInput,
} from '../projects-client/projects';
import type { ProjectFileEntry, ProjectGitConnection, ProjectRole } from '../projects-client/shared';
import { unwrap } from '../projects-client/shared';

export type WorkspaceRole = ProjectRole;

export type KortixWorkspace = Omit<
  KortixProject,
  'project_id' | 'project_role' | 'effective_project_role'
> & {
  workspace_id: string;
  workspace_role?: WorkspaceRole | null;
  effective_workspace_role?: WorkspaceRole | null;
};

export type WorkspaceInput = ProjectInput;
export type CreateWorkspaceRepoInput = CreateProjectRepoInput;
export type ProvisionWorkspaceInput = ProvisionProjectInput;
export type WorkspaceConfigSummary = ProjectConfigSummary;

export type WorkspaceDetail = Omit<ProjectDetail, 'project' | 'git_connection' | 'files'> & {
  workspace: KortixWorkspace;
  git_connection?: ProjectGitConnection | null;
  files: ProjectFileEntry[];
};

export async function listWorkspaces() {
  return unwrap(await backendApi.get<KortixWorkspace[]>('/workspaces'));
}

export async function listWorkspacesForAccount(accountId?: string) {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(await backendApi.get<KortixWorkspace[]>(`/workspaces${query}`));
}

export async function getWorkspace(workspaceId: string, options?: ApiClientOptions) {
  return unwrap(await backendApi.get<KortixWorkspace>(`/workspaces/${workspaceId}`, options));
}

export async function getWorkspaceDetail(workspaceId: string, options?: ApiClientOptions) {
  const detail = unwrap(
    await backendApi.get<WorkspaceDetail>(`/workspaces/${workspaceId}/detail`, {
      showErrors: false,
      ...options,
    }),
  );
  return {
    ...detail,
    config: {
      ...detail.config,
      default_agent: detail.config.default_agent ?? detail.config.open_code_default_agent ?? null,
    },
  };
}

export async function createWorkspace(input: WorkspaceInput) {
  return unwrap(await backendApi.post<KortixWorkspace>('/workspaces', input));
}

export async function createWorkspaceRepo(input: CreateWorkspaceRepoInput) {
  return unwrap(await backendApi.post<KortixWorkspace>('/workspaces/create-repo', input));
}

export async function provisionWorkspace(
  input: ProvisionWorkspaceInput,
  options: ApiClientOptions = {},
) {
  return unwrap(
    await backendApi.post<KortixWorkspace>(
      '/workspaces/provision',
      { seed_starter: true, ...input },
      { timeout: 120_000, ...options },
    ),
  );
}

export async function updateWorkspace(workspaceId: string, input: Partial<WorkspaceInput>) {
  return unwrap(
    await backendApi.patch<KortixWorkspace>(`/workspaces/${workspaceId}`, input),
  );
}

export async function archiveWorkspace(workspaceId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/workspaces/${workspaceId}`));
}
