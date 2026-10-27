// Session groups — `/v1/projects/:id/session-groups` (apps/api/src/projects/routes/session-groups.ts).
// A group is a named folder of the project's sessions that every member sees,
// in one shared order. A session is in at most one group
// (`ProjectSession.group_id`); list a group's sessions with
// `listProjectSessionsPage(projectId, { group })`. Every route answers 403
// `feature_disabled` while the project's `session_groups` flag is off.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** A session group. Same fields as the API's `SessionGroup`. */
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

export interface CreateProjectSessionGroupInput {
  /** 1–80 characters after trimming. */
  name: string;
}

/** A session and the group it is filed in (null: none). */
export interface ProjectSessionGroupAssignment {
  session_id: string;
  group_id: string | null;
}

/** The project's groups, in order. A background read: a failure reaches the caller's query state, not the host error handler. */
export async function listProjectSessionGroups(projectId: string): Promise<ProjectSessionGroup[]> {
  const body = unwrap(
    await backendApi.get<{ groups: ProjectSessionGroup[] }>(`/projects/${projectId}/session-groups`, { showErrors: false }),
  );
  return body.groups;
}

/**
 * Create a group, last in the order. A name another group of the project has
 * (any case) rejects with an `ApiError` 409 `group_name_taken`; a project with
 * 50 groups rejects with 409 `group_limit`. The caller shows the error, so it
 * never reaches the host error handler.
 */
export async function createProjectSessionGroup(projectId: string, input: CreateProjectSessionGroupInput) {
  return unwrap(
    await backendApi.post<ProjectSessionGroup>(`/projects/${projectId}/session-groups`, input, { showErrors: false }),
  );
}

/** Rename a group. A taken name rejects with 409 `group_name_taken`; an unknown group with 404 `group_not_found`. */
export async function renameProjectSessionGroup(projectId: string, groupId: string, name: string) {
  return unwrap(
    await backendApi.patch<ProjectSessionGroup>(`/projects/${projectId}/session-groups/${groupId}`, { name }, { showErrors: false }),
  );
}

/** Delete a group. Its sessions stay, in no group; the groups after it move up one place. */
export async function deleteProjectSessionGroup(projectId: string, groupId: string): Promise<void> {
  unwrap(await backendApi.delete<{ ok: true }>(`/projects/${projectId}/session-groups/${groupId}`, { showErrors: false }));
}

/**
 * Put the project's groups in this order: every group id, each once. A list
 * that is out of date (a group missing, added or foreign) changes nothing and
 * rejects with 409 `group_order_stale`: read the list again. Resolves the
 * groups in the new order.
 */
export async function reorderProjectSessionGroups(projectId: string, groupIds: readonly string[]): Promise<ProjectSessionGroup[]> {
  const body = unwrap(
    await backendApi.put<{ groups: ProjectSessionGroup[] }>(
      `/projects/${projectId}/session-groups/order`,
      { group_ids: groupIds },
      { showErrors: false },
    ),
  );
  return body.groups;
}

/**
 * File a session into a group of its project, or take it out of its group
 * (`null`). The session keeps its `updated_at`, so it keeps its place in the
 * list. An unknown group rejects with 404 `group_not_found`; a session the
 * caller cannot see with 404.
 */
export async function setProjectSessionGroup(projectId: string, sessionId: string, groupId: string | null) {
  return unwrap(
    await backendApi.put<ProjectSessionGroupAssignment>(
      `/projects/${projectId}/sessions/${sessionId}/group`,
      { group_id: groupId },
      { showErrors: false },
    ),
  );
}
