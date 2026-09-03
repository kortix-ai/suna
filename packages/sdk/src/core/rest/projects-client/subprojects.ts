// Project subprojects — named containers inside a project. The repo manifest
// (`kortix.yaml` → `subprojects.<slug>`) is the source of truth; the database
// holds only the session join (`project_sessions.subproject`) and the IAM
// grants. Every route below reads/writes the manifest through the API.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/**
 * Who may read the sessions started inside a subproject.
 * `private` = the ordinary model (a session is its creator's unless shared).
 * `shared` = every session in the subproject is readable by everyone granted
 * the subproject. Lifecycle rights (stop/restart/delete) are unchanged.
 */
export type SubprojectSessionsMode = 'private' | 'shared';

/** One subproject, as served by `GET /projects/:id/subprojects`. */
export interface Subproject {
  /** Stable manifest key and grant key. Immutable after create. */
  slug: string;
  /** Display name. Defaults to the slug when the manifest omits it. */
  name: string;
  description: string | null;
  /** Inline markdown handed to the sandbox as standing instructions. */
  instructions: string | null;
  /** Repo-relative paths (a file, or a `dir/`) the agent always sees. */
  context: string[];
  /** Default agent for sessions started here — a default, not a binding. */
  agent: string | null;
  sessions: SubprojectSessionsMode;
  /** Where the block lives, e.g. `kortix.yaml#subprojects.marketing`. */
  path: string;
  /** Non-deleted sessions in this subproject that the caller can see. */
  session_count: number;
  /** Triggers whose `subproject` back-reference names this slug. */
  trigger_count: number;
  /** May the caller edit or delete it (`project.customize.write`)? */
  can_manage: boolean;
}

export interface SubprojectsResponse {
  subprojects: Subproject[];
  /** Manifest blocks that failed to parse — reported, never silently dropped.
   *  Deliberately unnamed: `XError` is reserved for `Error` subclasses here, so
   *  address the row type as `SubprojectsResponse['errors'][number]`. */
  errors: { slug: string; path: string; error: string }[];
}

export interface CreateSubprojectInput {
  name: string;
  /** Derived from `name` via `slugify` when omitted. */
  slug?: string;
  description?: string;
  instructions?: string;
  context?: string[];
  agent?: string;
  sessions?: SubprojectSessionsMode;
}

/** Partial merge. `slug` is immutable; `null` clears an optional field. */
export interface UpdateSubprojectInput {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  context?: string[];
  agent?: string | null;
  sessions?: SubprojectSessionsMode;
}

/** UTF-8 text (≤ 256 KB) committed to `.kortix/subprojects/<slug>/` and
 *  appended to `context[]`. `path` contributes only its basename. */
export interface AddSubprojectContextInput {
  path: string;
  content: string;
}

const base = (projectId: string) => `/projects/${projectId}/subprojects`;
const one = (projectId: string, slug: string) =>
  `${base(projectId)}/${encodeURIComponent(slug)}`;

/** Every subproject the caller can access, sorted by slug. */
export async function listProjectSubprojects(projectId: string) {
  return unwrap(await backendApi.get<SubprojectsResponse>(base(projectId)));
}

/** One subproject. `404` when undeclared or inaccessible. */
export async function getProjectSubproject(projectId: string, slug: string) {
  return unwrap(await backendApi.get<Subproject>(one(projectId, slug)));
}

/** Declare a subproject — commits `kortix.yaml`. `409` on a taken slug. */
export async function createProjectSubproject(projectId: string, input: CreateSubprojectInput) {
  return unwrap(await backendApi.post<Subproject>(base(projectId), input));
}

/** Partial merge of the declared fields. `{}` returns 200 without a commit. */
export async function updateProjectSubproject(
  projectId: string,
  slug: string,
  input: UpdateSubprojectInput,
) {
  return unwrap(await backendApi.patch<Subproject>(one(projectId, slug), input));
}

/** Remove the block and strip `subproject:` from the triggers naming it.
 *  Session rows keep their column. */
export async function deleteProjectSubproject(projectId: string, slug: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(one(projectId, slug)));
}

/** Commit a text file into the subproject and append it to `context[]`. */
export async function addProjectSubprojectContext(
  projectId: string,
  slug: string,
  input: AddSubprojectContextInput,
) {
  return unwrap(await backendApi.post<Subproject>(`${one(projectId, slug)}/context`, input));
}

/** Drop one entry from `context[]`. Never deletes the repo file. */
export async function removeProjectSubprojectContext(
  projectId: string,
  slug: string,
  path: string,
) {
  const query = new URLSearchParams({ path });
  return unwrap(
    await backendApi.delete<Subproject>(`${one(projectId, slug)}/context?${query}`),
  );
}
