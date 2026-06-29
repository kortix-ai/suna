// Shared helpers + cross-cutting types used by multiple projects-client modules.

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'editor' | 'viewer';

export type ConnectorSharing =
  | { mode: 'project' }
  | { mode: 'private'; ownerId: string }
  | { mode: 'members'; memberIds?: string[]; groupIds?: string[] };

export interface ProjectGitConnection {
  connection_id: string;
  account_id: string;
  project_id: string;
  provider: string;
  repo_url: string;
  repo_owner: string | null;
  repo_name: string | null;
  external_repo_id: string | null;
  default_branch: string;
  auth_method: string;
  installation_id: string | null;
  visibility: string | null;
  status: string;
  last_validated_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectFileEntry {
  path: string;
  type: 'file';
  size: number | null;
}

export function unwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Project request failed');
  }
  return response.data;
}
