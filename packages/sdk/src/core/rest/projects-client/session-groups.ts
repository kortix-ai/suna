// Session groups — `/v1/projects/:id/session-groups` (apps/api/src/projects/routes/session-groups.ts).
// A group is a named folder of the project's sessions that every member sees,
// in one shared order. A session is in at most one group
// (`ProjectSession.group_id`); list a group's sessions with
// `listProjectSessionsPage(projectId, { group })`. Every route answers 403
// `feature_disabled` while the project's `session_groups` flag is off.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/**
 * A session group. Same fields as the API's `SessionGroup`.
 *
 * @deprecated Use `WorkspaceSessionGroup`. Kept permanently.
 */
export interface ProjectSessionGroup {
  group_id: string;
  /** 1–80 characters, unique in the project in any case. */
  name: string;
  /** 0-based place in the project's order. */
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The workspace name of {@link ProjectSessionGroup}: the same type. */
export type WorkspaceSessionGroup = ProjectSessionGroup;

/** @deprecated Use `CreateWorkspaceSessionGroupInput`. Kept permanently. */
export interface CreateProjectSessionGroupInput {
  /** 1–80 characters after trimming. */
  name: string;
}

/** The workspace name of {@link CreateProjectSessionGroupInput}: the same type. */
export type CreateWorkspaceSessionGroupInput = CreateProjectSessionGroupInput;

/**
 * A session and the group it is filed in (null: none).
 *
 * @deprecated Use `WorkspaceSessionGroupAssignment`. Kept permanently.
 */
export interface ProjectSessionGroupAssignment {
  session_id: string;
  group_id: string | null;
}

/** The workspace name of {@link ProjectSessionGroupAssignment}: the same type. */
export type WorkspaceSessionGroupAssignment = ProjectSessionGroupAssignment;

/** The project's groups, in order. A background read: a failure reaches the caller's query state, not the host error handler. */
export async function listWorkspaceSessionGroups(projectId: string): Promise<ProjectSessionGroup[]> {
  const body = unwrap(
    await backendApi.get<{ groups: ProjectSessionGroup[] }>(`/workspaces/${projectId}/session-groups`, { showErrors: false }),
  );
  return body.groups;
}

/** @deprecated Use `listWorkspaceSessionGroups`. Kept permanently. */
export const listProjectSessionGroups = listWorkspaceSessionGroups;

/**
 * Create a group, last in the order. A name another group of the project has
 * (any case) rejects with an `ApiError` 409 `group_name_taken`; a project with
 * 50 groups rejects with 409 `group_limit`. The caller shows the error, so it
 * never reaches the host error handler.
 */
export async function createWorkspaceSessionGroup(projectId: string, input: CreateProjectSessionGroupInput) {
  return unwrap(
    await backendApi.post<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups`, input, { showErrors: false }),
  );
}

/** @deprecated Use `createWorkspaceSessionGroup`. Kept permanently. */
export const createProjectSessionGroup = createWorkspaceSessionGroup;

/** Rename a group. A taken name rejects with 409 `group_name_taken`; an unknown group with 404 `group_not_found`. */
export async function renameWorkspaceSessionGroup(projectId: string, groupId: string, name: string) {
  return unwrap(
    await backendApi.patch<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups/${groupId}`, { name }, { showErrors: false }),
  );
}

/** @deprecated Use `renameWorkspaceSessionGroup`. Kept permanently. */
export const renameProjectSessionGroup = renameWorkspaceSessionGroup;

/** Delete a group. Its sessions stay, in no group; the groups after it move up one place. */
export async function deleteWorkspaceSessionGroup(projectId: string, groupId: string): Promise<void> {
  unwrap(await backendApi.delete<{ ok: true }>(`/workspaces/${projectId}/session-groups/${groupId}`, { showErrors: false }));
}

/** @deprecated Use `deleteWorkspaceSessionGroup`. Kept permanently. */
export const deleteProjectSessionGroup = deleteWorkspaceSessionGroup;

/**
 * Put the project's groups in this order: every group id, each once. A list
 * that is out of date (a group missing, added or foreign) changes nothing and
 * rejects with 409 `group_order_stale`: read the list again. Resolves the
 * groups in the new order.
 */
export async function reorderWorkspaceSessionGroups(projectId: string, groupIds: readonly string[]): Promise<ProjectSessionGroup[]> {
  const body = unwrap(
    await backendApi.put<{ groups: ProjectSessionGroup[] }>(
      `/workspaces/${projectId}/session-groups/order`,
      { group_ids: groupIds },
      { showErrors: false },
    ),
  );
  return body.groups;
}

/** @deprecated Use `reorderWorkspaceSessionGroups`. Kept permanently. */
export const reorderProjectSessionGroups = reorderWorkspaceSessionGroups;

/**
 * File a session into a group of its project, or take it out of its group
 * (`null`). The session keeps its `updated_at`, so it keeps its place in the
 * list. An unknown group rejects with 404 `group_not_found`; a session the
 * caller cannot see with 404.
 */
export async function setWorkspaceSessionGroup(projectId: string, sessionId: string, groupId: string | null) {
  return unwrap(
    await backendApi.put<ProjectSessionGroupAssignment>(
      `/workspaces/${projectId}/sessions/${sessionId}/group`,
      { group_id: groupId },
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `setWorkspaceSessionGroup`. Kept permanently. */
export const setProjectSessionGroup = setWorkspaceSessionGroup;
