import {
  PlatinumApi,
  PlatinumHttpError,
  type PlatinumSandbox,
  platinumSandboxListPath,
} from './platinum-ci';
import {
  PLATINUM_POOL_MB_DEFAULT,
  PREVIEW_HOST_MAX_IDLE_MS,
  PREVIEW_SESSION_MAX_IDLE_MS,
  type PlatinumListedSandbox,
  formatPoolUsage,
  previewHostNames,
  selectIdlePreviewHosts,
  selectPreviewSessionsForTeardown,
  selectStalePreviewSessions,
  summarizePoolUsage,
} from './preview-session-reaper';
import { selectStalePreviewSandboxIds, selectTeardownSandboxIds } from './sandbox-preview';

export type ListedPlatinumSandbox = PlatinumSandbox & PlatinumListedSandbox;

interface PlatinumSandboxPage {
  rows?: ListedPlatinumSandbox[];
  has_more?: boolean;
}

export async function allPlatinumPreviewSandboxes(api: PlatinumApi): Promise<ListedPlatinumSandbox[]> {
  const sandboxes: ListedPlatinumSandbox[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await api.json<PlatinumSandboxPage>(
      platinumSandboxListPath(limit, offset),
    );
    sandboxes.push(...(page.rows ?? []));
    if (!page.has_more || (page.rows ?? []).length === 0) return sandboxes;
  }
}

export async function deletePlatinum(api: PlatinumApi, sandboxId: string): Promise<void> {
  try {
    await api.json(`/v1/sandboxes/${sandboxId}`, { method: 'DELETE' });
  } catch (error) {
    if (!String(error).includes('-> 404:')) throw error;
  }
}

/**
 * Stop, never delete: a stop is reversible and releases the box's RAM, which
 * is the resource the org ran out of. 404 (gone) and 409 (not running) are the
 * desired end state.
 */
async function stopPlatinum(api: PlatinumApi, sandboxId: string): Promise<boolean> {
  try {
    await api.json(`/v1/sandboxes/${sandboxId}/stop`, { method: 'POST' }, { retry: true });
    return true;
  } catch (error) {
    if (error instanceof PlatinumHttpError && (error.status === 404 || error.status === 409)) {
      return false;
    }
    throw error;
  }
}

/**
 * Stop each id, warning and moving on when one stop fails. Returns the ids
 * that actually stopped.
 */
async function stopEach(
  api: PlatinumApi,
  sandboxIds: readonly string[],
  label: string,
): Promise<string[]> {
  const stopped: string[] = [];
  for (const sandboxId of sandboxIds) {
    try {
      if (await stopPlatinum(api, sandboxId)) stopped.push(sandboxId);
    } catch (error) {
      console.warn(`[sandbox-preview] ${label}: stop ${sandboxId} failed: ${String(error)}`);
    }
  }
  return stopped;
}

/** Stop the running session boxes that belong to these preview hosts. */
export async function stopPreviewSessionsOf(
  api: PlatinumApi,
  sandboxes: readonly ListedPlatinumSandbox[],
  hostNames: readonly string[],
  createdSinceMs?: number,
): Promise<number> {
  const ids = selectPreviewSessionsForTeardown(sandboxes, hostNames, createdSinceMs);
  const stopped = (await stopEach(api, ids, `sessions of ${hostNames.join(',')}`)).length;
  if (ids.length > 0) {
    console.log(
      `[sandbox-preview] stopped ${stopped}/${ids.length} session box(es) of ${hostNames.join(', ')}`,
    );
  }
  return stopped;
}

function maxIdleMs(): number {
  const hours = Number(process.env.PREVIEW_SESSION_MAX_IDLE_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : PREVIEW_SESSION_MAX_IDLE_MS;
}

function poolMb(): number {
  const value = Number(process.env.PREVIEW_PLATINUM_POOL_MB);
  return Number.isFinite(value) && value > 0 ? value : PLATINUM_POOL_MB_DEFAULT;
}

/**
 * Stop preview session boxes whose host is gone or that idled past the limit.
 * Returns the stopped ids, so a caller can drop them from its pool estimate.
 */
async function sweepStalePreviewSessions(
  api: PlatinumApi,
  sandboxes: readonly ListedPlatinumSandbox[],
  liveHostNames: ReadonlySet<string>,
): Promise<Set<string>> {
  const stale = selectStalePreviewSessions(sandboxes, {
    liveHostNames,
    nowMs: Date.now(),
    maxIdleMs: maxIdleMs(),
  });
  const stopped = new Set(await stopEach(api, stale.map((box) => box.id), 'sweep'));
  if (stale.length > 0) {
    const ownerGone = stale.filter((box) => box.reason === 'owner-gone').length;
    console.log(
      `[sandbox-preview] sweep stopped ${stopped.size}/${stale.length} preview session box(es): ` +
        `${ownerGone} with no live host, ${stale.length - ownerGone} idle > ${maxIdleMs() / 3_600_000} h`,
    );
  }
  return stopped;
}

/**
 * Every deploy (and every suite's capacity wait) sweeps the shared org first:
 * preview deploys are frequent, and the daily reconcile alone let 87 idle
 * session boxes fill the pool in under 8 hours on 2026-09-23. Returns who
 * holds the pool after the sweep, so a refusal below is diagnosable from this
 * log alone.
 */
export async function reportPoolUsage(api: PlatinumApi, listing: readonly ListedPlatinumSandbox[]) {
  const swept = await sweepStalePreviewSessions(api, listing, previewHostNames(listing)).catch(
    (error) => {
      console.warn(`[sandbox-preview] session sweep failed: ${String(error)}`);
      return new Set<string>();
    },
  );
  return summarizePoolUsage(listing.filter((sandbox) => !swept.has(sandbox.id)), poolMb());
}

export function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Delete this pull request's sandbox, in whichever shape it was deployed.
 *
 * `branchEnv` is passed when the pull request runs a persistent environment. Its
 * sandbox is named after the BRANCH, so looking only for the PR-named one would
 * leave it running forever — a branch environment has no expiry to fall back on.
 */
export async function teardownPlatinumPreview(input: {
  apiUrl: string;
  apiKey: string;
  prNumber?: number;
  branchEnv?: string;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new PlatinumApi(input.apiUrl, input.apiKey);
  const sandboxes = await allPlatinumPreviewSandboxes(api);
  const owned = selectTeardownSandboxIds(sandboxes, input);
  const ownedNames = sandboxes
    .filter((sandbox) => owned.includes(sandbox.id) && sandbox.name)
    .map((sandbox) => sandbox.name as string);
  // The host's database dies with it; its session boxes can never resume.
  await stopPreviewSessionsOf(api, sandboxes, ownedNames);
  for (const sandboxId of owned) await deletePlatinum(api, sandboxId);
  return owned.length;
}

export async function reconcilePlatinumPreviews(input: {
  apiUrl: string;
  apiKey: string;
  activePullRequests: ReadonlyMap<number, string>;
  liveBranchSandboxNames?: ReadonlySet<string>;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new PlatinumApi(input.apiUrl, input.apiKey);
  const sandboxes = await allPlatinumPreviewSandboxes(api);
  const stale = selectStalePreviewSandboxIds(
    sandboxes,
    input.activePullRequests,
    input.liveBranchSandboxNames,
  );
  for (const sandboxId of stale) await deletePlatinum(api, sandboxId);
  // Session boxes are judged against the hosts that SURVIVE this sweep: a box
  // whose host was just deleted, or was deleted long ago, has no database
  // behind it any more.
  const staleIds = new Set(stale);
  const surviving = previewHostNames(sandboxes.filter((sandbox) => !staleIds.has(sandbox.id)));
  const stoppedSessions = await sweepStalePreviewSessions(api, sandboxes, surviving);
  // Stop hosts of closed pull requests and hosts idle past the limit, with
  // their session boxes: a stopped host's API cannot reap them.
  const hostRule = {
    openPullRequests: new Set(input.activePullRequests.keys()),
    nowMs: Date.now(),
    maxIdleMs: envNumber('PREVIEW_HOST_MAX_IDLE_HOURS', PREVIEW_HOST_MAX_IDLE_MS / 3_600_000) * 3_600_000,
  };
  const idleHosts: string[] = [];
  // Re-read each candidate just before the stop. A deploy that started it
  // since the listing has fresh activity; stopping it made that deploy fail
  // with `entered state=stopped` (2026-09-28).
  for (const id of selectIdlePreviewHosts(sandboxes.filter((sandbox) => !staleIds.has(sandbox.id)), hostRule)) {
    const current = await api.json<ListedPlatinumSandbox>(`/v1/sandboxes/${id}`).catch(() => null);
    if (current && selectIdlePreviewHosts([current], { ...hostRule, nowMs: Date.now() }).length === 1) {
      idleHosts.push(id);
    }
  }
  const idleHostNames = sandboxes
    .filter((sandbox) => idleHosts.includes(sandbox.id) && sandbox.name)
    .map((sandbox) => sandbox.name as string);
  if (idleHostNames.length > 0) {
    await stopPreviewSessionsOf(api, sandboxes, idleHostNames);
    const stoppedHosts = await stopEach(api, idleHosts, 'idle preview hosts');
    console.log(`[sandbox-preview] stopped ${stoppedHosts.length}/${idleHosts.length} idle preview host(s): ${idleHostNames.join(', ')}`);
  }
  const idleHostIds = new Set(idleHosts);
  console.log(
    `[sandbox-preview] ${formatPoolUsage(
      summarizePoolUsage(
        sandboxes.filter(
          (sandbox) =>
            !staleIds.has(sandbox.id) && !stoppedSessions.has(sandbox.id) && !idleHostIds.has(sandbox.id),
        ),
        poolMb(),
      ),
    )}`,
  );
  return stale.length;
}
