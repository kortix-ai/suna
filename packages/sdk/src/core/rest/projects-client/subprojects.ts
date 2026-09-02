// Subprojects — the store index (`/v1/subprojects/*`) and the per-project surface
// (`/v1/projects/:id/subprojects/*`).
//
// A subproject is a GitHub repo, or an uploaded .zip, whose `kortix.yaml` declares
// agents, skills, connectors and triggers. Installing one MERGES that
// declaration into a project through an agent-driven session that lands a change
// request — so `createSubprojectInstallSession` returns a SESSION to open, never a
// finished install. The same is true of uninstall.
//
// A subproject's TRIGGER RUNS are not here. A run belongs to the trigger that
// fired it, not to the subproject that contributed the trigger, and it is read
// through the project's own execution history. This module is the catalogue and
// the install lifecycle only.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Where a subproject's files come from. */
export type SubprojectSourceKind = 'github' | 'upload';

/**
 * Who may see a subproject in the store.
 *
 *   `public`   every Kortix user, in every account. NOT submittable — see
 *              {@link SubmitSubprojectInput.visibility}. A public row exists
 *              only because a migration, a seeder or a direct insert made it,
 *              so the global catalogue is curated rather than open.
 *   `account`  everyone in the submitting account. The default.
 *   `private`  the submitter alone (`submitted_by`), inside their own account.
 */
export type SubprojectVisibility = 'public' | 'account' | 'private';

/**
 * Index health. `unavailable` means the last crawl failed — the subproject is still
 * listed to its owner, carrying `last_error`, rather than silently vanishing.
 */
export type SubprojectStatus = 'active' | 'unavailable' | 'yanked';

/** One agent a subproject contributes. */
export interface SubprojectAgentSummary {
  name: string;
  description: string | null;
}

/** One trigger a subproject contributes — the cadence its card advertises. */
export interface SubprojectTriggerSummary {
  slug: string;
  name: string;
  type: string;
  cron: string | null;
  agent: string;
  enabled: boolean;
}

/** One connector a subproject NEEDS. A requirement list, not a connection state. */
export interface SubprojectConnectorSummary {
  slug: string;
  provider: string;
  app: string | null;
}

/** One subproject in the store. */
export interface Subproject {
  subproject_id: string;
  slug: string;
  source_kind: SubprojectSourceKind;
  /** `owner/repo` for a github subproject; the archive name for an upload. */
  repo: string;
  repo_owner: string | null;
  repo_name: string | null;
  /** The uploaded archive's original filename. Null for a github subproject. */
  upload_name: string | null;
  /** How many text files an upload carries. 0 for a github subproject. */
  file_count: number;
  /** The branch/tag pinned, or null for the default branch. */
  git_ref: string | null;
  /** The commit the card was derived from. Null for an upload. */
  resolved_sha: string | null;
  title: string;
  description: string | null;
  stars: number | null;
  install_count: number;
  visibility: SubprojectVisibility;
  status: SubprojectStatus;
  agents: SubprojectAgentSummary[];
  triggers: SubprojectTriggerSummary[];
  connectors: SubprojectConnectorSummary[];
  skills: string[];
  env_required: string[];
  account_id: string | null;
  /**
   * The user who submitted it. On the wire because `visibility: 'private'`
   * means "this one user", so a client rendering "Only you" has to be able to
   * tell whether "you" is the viewer. Null on a seeded or hand-inserted row.
   */
  submitted_by: string | null;
  last_crawled_at: string | null;
  /** Why the last crawl failed. Set with `status: 'unavailable'`. */
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubprojectListing {
  subprojects: Subproject[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListSubprojectsOptions {
  /** Free-text match over title, description and the repo or archive name. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** A subproject submission's result. `warnings` never blocks — see below. */
export interface SubprojectSubmitResult {
  subproject: Subproject;
  /**
   * Advisory findings from the crawl: a manifest deprecation, a per-entry parse
   * error, files an archive carried that were not text. The subproject IS indexed.
   */
  warnings: string[];
}

/**
 * The scopes a SUBMISSION may ask for. Narrower than {@link SubprojectVisibility}
 * by one value, and that omission is the point: `public` is a curation decision,
 * not an author's, so `POST /v1/subprojects` refuses it at the schema and
 * coerces any unrecognized value to `private`. Global rows come from a
 * migration, a seeder or a direct insert.
 */
export type SubmittableSubprojectVisibility = Exclude<SubprojectVisibility, 'public'>;

export interface SubmitSubprojectInput {
  /** `owner/repo`, optionally `@branch-or-tag`. A browser or clone URL works. */
  repo: string;
  /** Defaults to `account` server-side — everyone in the submitting account. */
  visibility?: SubmittableSubprojectVisibility;
  account_id?: string;
}

export interface SubmitSubprojectArchiveInput {
  /**
   * A `.zip` of the subproject. Bounded server-side on TWO axes: the archive itself
   * up to 10 MB, and the text extracted from it up to 5 MB (256 KB per file,
   * 200 files). Non-text entries are skipped, not rejected.
   */
  file: File | Blob;
  visibility?: SubmittableSubprojectVisibility;
  account_id?: string;
}

function subprojectQuery(options?: ListSubprojectsOptions): string {
  const params = new URLSearchParams();
  const q = options?.q?.trim();
  if (q) params.set('q', q);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  return params.size > 0 ? `?${params}` : '';
}

/**
 * Browse the store. Three scopes, all resolved server-side from the token:
 * every `public` subproject, every `account` one in the caller's account, and
 * the caller's own `private` ones.
 */
export async function listSubprojects(
  options?: ListSubprojectsOptions,
): Promise<SubprojectListing> {
  return unwrap(await backendApi.get<SubprojectListing>(`/subprojects${subprojectQuery(options)}`));
}

/** One subproject by id. */
export async function getSubproject(subprojectId: string): Promise<Subproject> {
  const res = await backendApi.get<{ subproject: Subproject }>(
    `/subprojects/${encodeURIComponent(subprojectId)}`,
  );
  return unwrap(res).subproject;
}

/** Index a subproject from a GitHub repo. */
export async function submitSubproject(
  input: SubmitSubprojectInput,
): Promise<SubprojectSubmitResult> {
  const body: Record<string, unknown> = { repo: input.repo };
  // Only send what the caller chose. The server defaults visibility to
  // `account`, so an explicit `undefined` would be noise on the wire.
  if (input.visibility) body.visibility = input.visibility;
  if (input.account_id) body.account_id = input.account_id;
  return unwrap(await backendApi.post<SubprojectSubmitResult>('/subprojects', body));
}

/**
 * Index a subproject from an uploaded `.zip`.
 *
 * Goes through `backendApi.upload`, which strips `Content-Type` so the runtime
 * sets it WITH the multipart boundary. Setting it by hand produces a body the
 * server cannot parse.
 */
export async function submitSubprojectArchive(
  input: SubmitSubprojectArchiveInput,
): Promise<SubprojectSubmitResult> {
  const form = new FormData();
  form.append('file', input.file);
  if (input.visibility) form.append('visibility', input.visibility);
  if (input.account_id) form.append('account_id', input.account_id);
  return unwrap(await backendApi.upload<SubprojectSubmitResult>('/subprojects', form));
}

/**
 * Remove a subproject from the index.
 *
 * This does NOT uninstall it anywhere: an install is recorded in the project's
 * own manifest, and the projection's `subproject_id` is `ON DELETE SET NULL`
 * precisely so an install outlives its catalogue entry.
 */
export async function deleteSubproject(subprojectId: string): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/subprojects/${encodeURIComponent(subprojectId)}`),
  );
}

// ── per-project ────────────────────────────────────────────────────────────

/** One installed subproject, as the project's manifest records it. */
export interface InstalledSubproject {
  slug: string;
  /** `owner/repo`, or the archive name for an upload. */
  repo: string;
  git_ref: string | null;
  sha: string | null;
  version: string | null;
  title: string;
  installed_at: string | null;
  /**
   * What this subproject contributed, by entity kind — what an uninstall
   * removes.
   *
   * `owns.triggers` names the triggers it added; it does NOT say whether they
   * fire. A trigger is enabled or disabled individually, on the Triggers
   * capability page, because that is where a person can see what each one
   * does. There is no subproject-level on/off: an installed subproject is a set
   * of entries in the manifest, not a running thing.
   */
  owns: Partial<Record<'agents' | 'skills' | 'connectors' | 'triggers', string[]>>;
}

export interface InstalledSubprojectListing {
  subprojects: InstalledSubproject[];
  /** Per-entry manifest parse errors, so a broken subproject renders beside healthy ones. */
  errors: Array<{ slug: string; error: string }>;
}

/** What is installed in one project, read from its manifest. */
export async function listProjectSubprojects(
  projectId: string,
): Promise<InstalledSubprojectListing> {
  return unwrap(
    await backendApi.get<InstalledSubprojectListing>(
      `/projects/${encodeURIComponent(projectId)}/subprojects`,
    ),
  );
}

/**
 * Start the agent-driven install and return the session to open.
 *
 * The install itself happens inside that session: the agent reads both
 * manifests, merges, and opens a change request. Nothing is committed by this
 * call.
 */
export async function createSubprojectInstallSession(
  projectId: string,
  subprojectId: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/subprojects/install-session`,
      { subproject_id: subprojectId },
    ),
  );
}

/**
 * Start the agent-driven uninstall and return the session to open.
 *
 * Keyed on the installed SLUG rather than a subproject id: what a project has is
 * recorded in its manifest, which may name a subproject the index no longer carries.
 */
export async function createSubprojectUninstallSession(
  projectId: string,
  slug: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/subprojects/${encodeURIComponent(slug)}/uninstall-session`,
      {},
    ),
  );
}

/**
 * Start the agent-driven AUTHORING session — describe a subproject, get one built.
 *
 * The inverse of install: install merges an existing subproject into a project,
 * authoring produces a new subproject from a description. The agent creates the
 * repository, writes the manifest, validates it, and publishes it to the index.
 * Nothing exists when this call resolves except the session.
 */
export async function createSubprojectAuthorSession(
  projectId: string,
  description: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/subprojects/author-session`,
      { description },
    ),
  );
}
