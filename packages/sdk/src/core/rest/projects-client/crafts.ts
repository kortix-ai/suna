// Crafts — the store index (`/v1/crafts/*`) and the per-project surface
// (`/v1/projects/:id/crafts/*`).
//
// A craft is a GitHub repo, or an uploaded .zip, whose `kortix.yaml` declares
// agents, skills, connectors and triggers. Installing one MERGES that
// declaration into a project through an agent-driven session that lands a change
// request — so `createCraftInstallSession` returns a SESSION to open, never a
// finished install. The same is true of uninstall.
//
// A craft "run" is one trigger fire, read out of the project's own execution
// history. Nothing here writes a run; the runs endpoints are pure reads.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Where a craft's files come from. */
export type CraftSourceKind = 'github' | 'upload';

/** Who may see a craft in the store. */
export type CraftVisibility = 'public' | 'private';

/**
 * Index health. `unavailable` means the last crawl failed — the craft is still
 * listed to its owner, carrying `last_error`, rather than silently vanishing.
 */
export type CraftStatus = 'active' | 'unavailable' | 'yanked';

/** One agent a craft contributes. */
export interface CraftAgentSummary {
  name: string;
  description: string | null;
}

/** One trigger a craft contributes — the cadence its card advertises. */
export interface CraftTriggerSummary {
  slug: string;
  name: string;
  type: string;
  cron: string | null;
  agent: string;
  enabled: boolean;
}

/** One connector a craft NEEDS. A requirement list, not a connection state. */
export interface CraftConnectorSummary {
  slug: string;
  provider: string;
  app: string | null;
}

/** One craft in the store. */
export interface Craft {
  craft_id: string;
  slug: string;
  source_kind: CraftSourceKind;
  /** `owner/repo` for a github craft; the archive name for an upload. */
  repo: string;
  repo_owner: string | null;
  repo_name: string | null;
  /** The uploaded archive's original filename. Null for a github craft. */
  upload_name: string | null;
  /** How many text files an upload carries. 0 for a github craft. */
  file_count: number;
  /** The branch/tag pinned, or null for the default branch. */
  git_ref: string | null;
  /** The commit the card was derived from. Null for an upload. */
  resolved_sha: string | null;
  title: string;
  description: string | null;
  stars: number | null;
  install_count: number;
  visibility: CraftVisibility;
  status: CraftStatus;
  agents: CraftAgentSummary[];
  triggers: CraftTriggerSummary[];
  connectors: CraftConnectorSummary[];
  skills: string[];
  env_required: string[];
  account_id: string | null;
  last_crawled_at: string | null;
  /** Why the last crawl failed. Set with `status: 'unavailable'`. */
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CraftListing {
  crafts: Craft[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListCraftsOptions {
  /** Free-text match over title, description and the repo or archive name. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** A craft submission's result. `warnings` never blocks — see below. */
export interface CraftSubmitResult {
  craft: Craft;
  /**
   * Advisory findings from the crawl: a manifest deprecation, a per-entry parse
   * error, files an archive carried that were not text. The craft IS indexed.
   */
  warnings: string[];
}

export interface SubmitCraftInput {
  /** `owner/repo`, optionally `@branch-or-tag`. A browser or clone URL works. */
  repo: string;
  /** Defaults to `private` server-side — a craft goes public on purpose. */
  visibility?: CraftVisibility;
  account_id?: string;
}

export interface SubmitCraftArchiveInput {
  /**
   * A `.zip` of the craft. Bounded server-side on TWO axes: the archive itself
   * up to 10 MB, and the text extracted from it up to 5 MB (256 KB per file,
   * 200 files). Non-text entries are skipped, not rejected.
   */
  file: File | Blob;
  visibility?: CraftVisibility;
  account_id?: string;
}

function craftQuery(options?: ListCraftsOptions | { limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  const q = (options as ListCraftsOptions | undefined)?.q?.trim();
  if (q) params.set('q', q);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  return params.size > 0 ? `?${params}` : '';
}

/** Browse the store: every public craft, plus the caller's own private ones. */
export async function listCrafts(options?: ListCraftsOptions): Promise<CraftListing> {
  return unwrap(await backendApi.get<CraftListing>(`/crafts${craftQuery(options)}`));
}

/** One craft by id. */
export async function getCraft(craftId: string): Promise<Craft> {
  const res = await backendApi.get<{ craft: Craft }>(`/crafts/${encodeURIComponent(craftId)}`);
  return unwrap(res).craft;
}

/** Index a craft from a GitHub repo. */
export async function submitCraft(input: SubmitCraftInput): Promise<CraftSubmitResult> {
  const body: Record<string, unknown> = { repo: input.repo };
  // Only send what the caller chose. The server defaults visibility to private,
  // so an explicit `undefined` would be noise on the wire.
  if (input.visibility) body.visibility = input.visibility;
  if (input.account_id) body.account_id = input.account_id;
  return unwrap(await backendApi.post<CraftSubmitResult>('/crafts', body));
}

/**
 * Index a craft from an uploaded `.zip`.
 *
 * Goes through `backendApi.upload`, which strips `Content-Type` so the runtime
 * sets it WITH the multipart boundary. Setting it by hand produces a body the
 * server cannot parse.
 */
export async function submitCraftArchive(
  input: SubmitCraftArchiveInput,
): Promise<CraftSubmitResult> {
  const form = new FormData();
  form.append('file', input.file);
  if (input.visibility) form.append('visibility', input.visibility);
  if (input.account_id) form.append('account_id', input.account_id);
  return unwrap(await backendApi.upload<CraftSubmitResult>('/crafts', form));
}

/**
 * Remove a craft from the index.
 *
 * This does NOT uninstall it anywhere: an install is recorded in the project's
 * own manifest, and the projection's `craft_id` is `ON DELETE SET NULL`
 * precisely so an install outlives its catalogue entry.
 */
export async function deleteCraft(craftId: string): Promise<{ ok: boolean }> {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/crafts/${encodeURIComponent(craftId)}`));
}

// ── per-project ────────────────────────────────────────────────────────────

/** One installed craft, as the project's manifest records it. */
export interface InstalledCraft {
  slug: string;
  /** `owner/repo`, or the archive name for an upload. */
  repo: string;
  git_ref: string | null;
  sha: string | null;
  version: string | null;
  title: string;
  installed_at: string | null;
  /** What this craft contributed, by entity kind — what an uninstall removes. */
  owns: Partial<Record<'agents' | 'skills' | 'connectors' | 'triggers', string[]>>;
  /**
   * Whether its triggers are firing, DERIVED from the manifest's trigger
   * entries — there is no stored flag, because a craft is on exactly when its
   * triggers are.
   *
   * `null` means the question has no single answer: SOME of its triggers are on,
   * or it owns none at all. Render that as indeterminate; a switch that picked
   * on or off would claim a state the manifest does not have.
   */
  enabled: boolean | null;
  /** How many triggers this craft owns. `0` means nothing to activate. */
  trigger_count: number;
  /** How many of those are currently enabled. */
  enabled_trigger_count: number;
}

export interface InstalledCraftListing {
  crafts: InstalledCraft[];
  /** Per-entry manifest parse errors, so a broken craft renders beside healthy ones. */
  errors: Array<{ slug: string; error: string }>;
}

/** What is installed in one project, read from its manifest. */
export async function listProjectCrafts(projectId: string): Promise<InstalledCraftListing> {
  return unwrap(
    await backendApi.get<InstalledCraftListing>(
      `/projects/${encodeURIComponent(projectId)}/crafts`,
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
export async function createCraftInstallSession(
  projectId: string,
  craftId: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/crafts/install-session`,
      { craft_id: craftId },
    ),
  );
}

/**
 * Start the agent-driven uninstall and return the session to open.
 *
 * Keyed on the installed SLUG rather than a craft id: what a project has is
 * recorded in its manifest, which may name a craft the index no longer carries.
 */
export async function createCraftUninstallSession(
  projectId: string,
  slug: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/crafts/${encodeURIComponent(slug)}/uninstall-session`,
      {},
    ),
  );
}

/**
 * Start the agent-driven AUTHORING session — describe a craft, get one built.
 *
 * The inverse of install: install merges an existing craft into a project,
 * authoring produces a new craft from a description. The agent creates the
 * repository, writes the manifest, validates it, and publishes it to the index.
 * Nothing exists when this call resolves except the session.
 */
export async function createCraftAuthorSession(
  projectId: string,
  description: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/crafts/author-session`,
      { description },
    ),
  );
}

/** The result of flipping one craft's triggers. */
export interface CraftActivationResult {
  ok: boolean;
  craft_slug: string;
  title: string;
  enabled: boolean;
  /**
   * The trigger slugs that actually moved.
   *
   * EMPTY means the craft was already in the requested state — a different
   * answer from "it worked", and the reason this is not just `{ ok: true }`.
   * The route skips the commit entirely in that case.
   */
  triggers: string[];
}

/**
 * Enable or disable one craft's triggers.
 *
 * A craft installs with every trigger `enabled: false`, so this is what starts
 * it working. It is NOT the project-wide pause: `setProjectTriggersActivation`
 * stops every trigger in the project at once and is a kill switch. This writes
 * the manifest, so a craft's activation is committed configuration that
 * survives a redeploy and appears in `git log`.
 */
export async function setCraftActivation(
  projectId: string,
  slug: string,
  enabled: boolean,
): Promise<CraftActivationResult> {
  return unwrap(
    await backendApi.patch<CraftActivationResult>(
      `/projects/${encodeURIComponent(projectId)}/crafts/${encodeURIComponent(slug)}/activation`,
      { enabled },
    ),
  );
}

// ── runs ───────────────────────────────────────────────────────────────────

/**
 * What a craft run shows.
 *
 * Overlaps the session sidebar's vocabulary on purpose. Two are run-specific:
 * `retrying` (the fire failed and will be attempted again — collapsing it into
 * `starting` would show a craft failing every attempt as perpetually starting)
 * and `skipped` (a filter or the pause switch declined the delivery; nothing ran
 * and nothing is wrong).
 */
export type CraftRunStatus =
  | 'starting'
  | 'retrying'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'skipped';

/** One run: one trigger fire. */
export interface CraftRun {
  execution_id: string;
  craft_slug: string;
  trigger_slug: string;
  status: CraftRunStatus;
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

export interface CraftRunStats {
  total: number;
  done: number;
  failed: number;
  /**
   * `done / (done + failed)` as a 0-100 integer, or null with no settled
   * verdict. `stopped` and `skipped` count on NEITHER side: a reaped sandbox is
   * not the craft failing, and 0% would read as "everything failed".
   */
  successRate: number | null;
  avgDurationSeconds: number | null;
}

export interface CraftRunListing {
  runs: CraftRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface CraftRunReport extends CraftRunListing {
  craft_slug: string;
  /** Aggregated over the RETURNED page; `total` says how many exist. */
  stats: CraftRunStats;
}

export interface ListCraftRunsOptions {
  limit?: number;
  offset?: number;
}

/** Runs across every installed craft, newest first. */
export async function listProjectCraftRuns(
  projectId: string,
  options?: ListCraftRunsOptions,
): Promise<CraftRunListing> {
  return unwrap(
    await backendApi.get<CraftRunListing>(
      `/projects/${encodeURIComponent(projectId)}/crafts/runs${craftQuery(options)}`,
    ),
  );
}

/** Runs for one craft, with aggregate stats. */
export async function listCraftRuns(
  projectId: string,
  slug: string,
  options?: ListCraftRunsOptions,
): Promise<CraftRunReport> {
  return unwrap(
    await backendApi.get<CraftRunReport>(
      `/projects/${encodeURIComponent(projectId)}/crafts/${encodeURIComponent(slug)}/runs${craftQuery(options)}`,
    ),
  );
}
