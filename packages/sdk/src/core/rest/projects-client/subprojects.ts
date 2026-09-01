// Subprojects — the store index (`/v1/subprojects/*`) and the per-project surface
// (`/v1/projects/:id/subprojects/*`).
//
// A subproject is a GitHub repo, or an uploaded .zip, whose `kortix.yaml` declares
// agents, skills, connectors and triggers. Installing one MERGES that
// declaration into a project through an agent-driven session that lands a change
// request — so `createSubprojectInstallSession` returns a SESSION to open, never a
// finished install. The same is true of uninstall.
//
// A subproject "run" is one trigger fire, read out of the project's own execution
// history. Nothing here writes a run; the runs endpoints are pure reads.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Where a subproject's files come from. */
export type SubprojectSourceKind = 'github' | 'upload';

/** Who may see a subproject in the store. */
export type SubprojectVisibility = 'public' | 'private';

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

export interface SubmitSubprojectInput {
  /** `owner/repo`, optionally `@branch-or-tag`. A browser or clone URL works. */
  repo: string;
  /** Defaults to `private` server-side — a subproject goes public on purpose. */
  visibility?: SubprojectVisibility;
  account_id?: string;
}

export interface SubmitSubprojectArchiveInput {
  /**
   * A `.zip` of the subproject. Bounded server-side on TWO axes: the archive itself
   * up to 10 MB, and the text extracted from it up to 5 MB (256 KB per file,
   * 200 files). Non-text entries are skipped, not rejected.
   */
  file: File | Blob;
  visibility?: SubprojectVisibility;
  account_id?: string;
}

function subprojectQuery(options?: ListSubprojectsOptions | { limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  const q = (options as ListSubprojectsOptions | undefined)?.q?.trim();
  if (q) params.set('q', q);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  return params.size > 0 ? `?${params}` : '';
}

/** Browse the store: every public subproject, plus the caller's own private ones. */
export async function listSubprojects(options?: ListSubprojectsOptions): Promise<SubprojectListing> {
  return unwrap(await backendApi.get<SubprojectListing>(`/subprojects${subprojectQuery(options)}`));
}

/** One subproject by id. */
export async function getSubproject(subprojectId: string): Promise<Subproject> {
  const res = await backendApi.get<{ subproject: Subproject }>(`/subprojects/${encodeURIComponent(subprojectId)}`);
  return unwrap(res).subproject;
}

/** Index a subproject from a GitHub repo. */
export async function submitSubproject(input: SubmitSubprojectInput): Promise<SubprojectSubmitResult> {
  const body: Record<string, unknown> = { repo: input.repo };
  // Only send what the caller chose. The server defaults visibility to private,
  // so an explicit `undefined` would be noise on the wire.
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
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/subprojects/${encodeURIComponent(subprojectId)}`));
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
  /** What this subproject contributed, by entity kind — what an uninstall removes. */
  owns: Partial<Record<'agents' | 'skills' | 'connectors' | 'triggers', string[]>>;
  /**
   * Whether its triggers are firing, DERIVED from the manifest's trigger
   * entries — there is no stored flag, because a subproject is on exactly when its
   * triggers are.
   *
   * `null` means the question has no single answer: SOME of its triggers are on,
   * or it owns none at all. Render that as indeterminate; a switch that picked
   * on or off would claim a state the manifest does not have.
   */
  enabled: boolean | null;
  /** How many triggers this subproject owns. `0` means nothing to activate. */
  trigger_count: number;
  /** How many of those are currently enabled. */
  enabled_trigger_count: number;
}

export interface InstalledSubprojectListing {
  subprojects: InstalledSubproject[];
  /** Per-entry manifest parse errors, so a broken subproject renders beside healthy ones. */
  errors: Array<{ slug: string; error: string }>;
}

/** What is installed in one project, read from its manifest. */
export async function listProjectSubprojects(projectId: string): Promise<InstalledSubprojectListing> {
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

/** The result of flipping one subproject's triggers. */
export interface SubprojectActivationResult {
  ok: boolean;
  subproject_slug: string;
  title: string;
  enabled: boolean;
  /**
   * The trigger slugs that actually moved.
   *
   * EMPTY means the subproject was already in the requested state — a different
   * answer from "it worked", and the reason this is not just `{ ok: true }`.
   * The route skips the commit entirely in that case.
   */
  triggers: string[];
}

/**
 * Enable or disable one subproject's triggers.
 *
 * A subproject installs with every trigger `enabled: false`, so this is what starts
 * it working. It is NOT the project-wide pause: `setProjectTriggersActivation`
 * stops every trigger in the project at once and is a kill switch. This writes
 * the manifest, so a subproject's activation is committed configuration that
 * survives a redeploy and appears in `git log`.
 */
export async function setSubprojectActivation(
  projectId: string,
  slug: string,
  enabled: boolean,
): Promise<SubprojectActivationResult> {
  return unwrap(
    await backendApi.patch<SubprojectActivationResult>(
      `/projects/${encodeURIComponent(projectId)}/subprojects/${encodeURIComponent(slug)}/activation`,
      { enabled },
    ),
  );
}

// ── runs ───────────────────────────────────────────────────────────────────

/**
 * What a subproject run shows.
 *
 * Overlaps the session sidebar's vocabulary on purpose. Two are run-specific:
 * `retrying` (the fire failed and will be attempted again — collapsing it into
 * `starting` would show a subproject failing every attempt as perpetually starting)
 * and `skipped` (a filter or the pause switch declined the delivery; nothing ran
 * and nothing is wrong).
 */
export type SubprojectRunStatus =
  | 'starting'
  | 'retrying'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'skipped';

/** One run: one trigger fire. */
export interface SubprojectRun {
  execution_id: string;
  subproject_slug: string;
  trigger_slug: string;
  status: SubprojectRunStatus;
  /** The dispatch status underneath, for a report that wants to be precise. */
  execution_status: string;
  /** When the slot was due — the schedule's promise. */
  scheduled_for: string;
  dispatched_at: string | null;
  completed_at: string | null;
  created_at: string;
  attempts: number;
  last_error: string | null;
  /** The session this run produced. Null while queued, or if it was deleted. */
  session_id: string | null;
  session_status: string | null;
  /** The session's generated title — the closest thing to what it delivered. */
  summary: string | null;
  duration_ms: number | null;
}

export interface SubprojectRunStats {
  total: number;
  done: number;
  failed: number;
  /**
   * `done / (done + failed)` as a 0-100 integer, or null with no settled
   * verdict. `stopped` and `skipped` count on NEITHER side: a reaped sandbox is
   * not the subproject failing, and 0% would read as "everything failed".
   */
  successRate: number | null;
  avgDurationSeconds: number | null;
}

export interface SubprojectRunListing {
  runs: SubprojectRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface SubprojectRunReport extends SubprojectRunListing {
  subproject_slug: string;
  /** Aggregated over the RETURNED page; `total` says how many exist. */
  stats: SubprojectRunStats;
}

export interface ListSubprojectRunsOptions {
  limit?: number;
  offset?: number;
}

/** Runs across every installed subproject, newest first. */
export async function listProjectSubprojectRuns(
  projectId: string,
  options?: ListSubprojectRunsOptions,
): Promise<SubprojectRunListing> {
  return unwrap(
    await backendApi.get<SubprojectRunListing>(
      `/projects/${encodeURIComponent(projectId)}/subprojects/runs${subprojectQuery(options)}`,
    ),
  );
}

/** Runs for one subproject, with aggregate stats. */
export async function listSubprojectRuns(
  projectId: string,
  slug: string,
  options?: ListSubprojectRunsOptions,
): Promise<SubprojectRunReport> {
  return unwrap(
    await backendApi.get<SubprojectRunReport>(
      `/projects/${encodeURIComponent(projectId)}/subprojects/${encodeURIComponent(slug)}/runs${subprojectQuery(options)}`,
    ),
  );
}
