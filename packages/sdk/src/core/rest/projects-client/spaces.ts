// Project spaces — named containers inside a project. The repo manifest
// (each space a `spaces.<slug>` block of `kortix.yaml`) is the source of truth; the
// database holds only the session join (`project_sessions.space`) and the
// IAM grants. Every route below reads/writes the manifest through the API.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/**
 * Who may read the sessions started inside a space.
 * `private` = the ordinary model (a session is its creator's unless shared).
 * `shared` = every session in the space is readable by everyone granted
 * the space. Lifecycle rights (stop/restart/delete) are unchanged.
 */
export type SpaceSessionsMode = 'private' | 'shared';

/** One space, as served by `GET /projects/:id/spaces`. */
export interface Space {
  /** Stable manifest key and grant key. Immutable after create. */
  slug: string;
  /** Display name. Defaults to the slug when the manifest omits it. */
  name: string;
  description: string | null;
  /** Default agent for sessions started here — a default, not a binding. */
  agent: string | null;
  sessions: SpaceSessionsMode;
  /** The file it lives in, repo-relative: `kortix-marketing.yaml`. */
  path: string;
  /** Agents usable here beyond the globals — the ones this space's file
   *  owns (declares) or references, in file order. Absent on older servers. */
  agents?: string[];
  /** Non-deleted sessions in this space that the caller can see. */
  session_count: number;
  /** Triggers whose `space` back-reference names this slug. */
  trigger_count: number;
  /** May the caller edit or delete it (`project.customize.write`)? */
  can_manage: boolean;
}

export interface SpacesResponse {
  spaces: Space[];
  /** Manifest blocks that failed to parse — reported, never silently dropped.
   *  Deliberately unnamed: `XError` is reserved for `Error` subclasses here, so
   *  address the row type as `SpacesResponse['errors'][number]`. */
  errors: { slug: string; path: string; error: string }[];
}

export interface CreateSpaceInput {
  name: string;
  /** Derived from `name` via `slugify` when omitted. */
  slug?: string;
  description?: string;
  agent?: string;
  sessions?: SpaceSessionsMode;
}

/** Partial merge. `slug` is immutable; `null` clears an optional field. */
export interface UpdateSpaceInput {
  name?: string;
  description?: string | null;
  agent?: string | null;
  sessions?: SpaceSessionsMode;
}

const base = (projectId: string) => `/projects/${projectId}/spaces`;
const one = (projectId: string, slug: string) =>
  `${base(projectId)}/${encodeURIComponent(slug)}`;

/** Every space the caller can access, sorted by slug. */
export async function listProjectSpaces(projectId: string) {
  return unwrap(await backendApi.get<SpacesResponse>(base(projectId)));
}

/** One space. `404` when undeclared or inaccessible. */
export async function getProjectSpace(projectId: string, slug: string) {
  return unwrap(await backendApi.get<Space>(one(projectId, slug)));
}

/** Declare a space — commits its `spaces.<slug>` block. `409` on a taken slug. */
export async function createProjectSpace(projectId: string, input: CreateSpaceInput) {
  return unwrap(await backendApi.post<Space>(base(projectId), input));
}

/** Partial merge of the declared fields. `{}` returns 200 without a commit. */
export async function updateProjectSpace(
  projectId: string,
  slug: string,
  input: UpdateSpaceInput,
) {
  return unwrap(await backendApi.patch<Space>(one(projectId, slug), input));
}

/** Remove the block and strip `space:` from the triggers naming it.
 *  Session rows keep their column. */
export async function deleteProjectSpace(projectId: string, slug: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(one(projectId, slug)));
}

/**
 * A roster entry as far as the usability rule cares: its name, and the
 * space that declares it. `null` or absent means global — declared in
 * the root `kortix.yaml`.
 */
export interface RosterAgent {
  name: string;
  space?: string | null;
}

/**
 * The agents usable in a session (spec 2026-09-06 §2): the globals, plus the
 * ones the session's space owns or references. A `null` or `undefined`
 * space is the whole project — globals only. Pure, order-preserving.
 */
export function agentsUsableIn<T extends RosterAgent>(
  agents: readonly T[],
  space: { agents: readonly string[] } | null | undefined,
): T[] {
  const extra = new Set(space?.agents ?? []);
  return agents.filter((agent) => !agent.space || extra.has(agent.name));
}
