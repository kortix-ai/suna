// Sidebar session folders — organize a project's sessions into named silos.
// Manual folders live server-side; auto-folders (Slack/Email/Scheduled/
// Webhooks) are virtual and derived client-side from session metadata.

import { backendApi } from '../api-client';
import type { ProjectSession } from './sessions';
import { unwrap } from './shared';

export type SessionFolderVisibility = 'private' | 'project' | 'restricted';

export interface SessionFolder {
  folder_id: string;
  project_id: string;
  account_id: string;
  name: string;
  /**
   * 'private' = only the creator sees the folder; 'project' = every member
   * sees it and its sessions inherit project-wide visibility. 'restricted'
   * is reserved (not yet assignable).
   */
  visibility: SessionFolderVisibility;
  position: number;
  created_by: string | null;
  is_owner: boolean;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
}

export async function listSessionFolders(projectId: string) {
  return unwrap(await backendApi.get<SessionFolder[]>(`/projects/${projectId}/session-folders`));
}

export async function createSessionFolder(
  projectId: string,
  input: { name: string; visibility?: 'private' | 'project' },
) {
  return unwrap(
    await backendApi.post<SessionFolder>(`/projects/${projectId}/session-folders`, input),
  );
}

export async function updateSessionFolder(
  projectId: string,
  folderId: string,
  input: { name?: string; visibility?: 'private' | 'project'; position?: number },
) {
  return unwrap(
    await backendApi.patch<SessionFolder>(
      `/projects/${projectId}/session-folders/${folderId}`,
      input,
    ),
  );
}

/** Deleting a folder unfiles its sessions — it never deletes them. */
export async function deleteSessionFolder(projectId: string, folderId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/session-folders/${folderId}`),
  );
}

/** Move a session into a folder, or unfile it with folderId = null. */
export async function setSessionFolder(
  projectId: string,
  sessionId: string,
  folderId: string | null,
) {
  return unwrap(
    await backendApi.put<ProjectSession>(`/projects/${projectId}/sessions/${sessionId}/folder`, {
      folder_id: folderId,
    }),
  );
}
