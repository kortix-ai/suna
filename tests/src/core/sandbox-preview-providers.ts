import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  DaytonaApi,
  type DaytonaCiInput,
  type DaytonaSandbox,
  createDaytonaSandbox,
  deleteSandbox as deleteDaytonaSandbox,
  downloadArtifacts as downloadDaytonaArtifacts,
  ensureWarmSnapshot,
  execute as executeDaytona,
  getSandboxByName,
  readRemoteExitCode,
  readRemoteLog,
  statRemoteLog,
  waitForSandbox as waitForDaytonaSandbox,
} from './daytona-ci';
import {
  PlatinumApi,
  PlatinumHttpError,
  type PlatinumSandbox,
  buildPlatinumTemplateSpec,
  downloadArtifacts as downloadPlatinumArtifacts,
  ensureTemplate,
  ensureWarmTemplate,
  exec as execPlatinum,
  observePlatinumSandboxStart,
  observePlatinumWorker,
  platinumWarmReadinessTimeoutMs,
  stat as statPlatinum,
  waitForWarmSandbox,
} from './platinum-ci';
import {
  PreviewInfrastructureError,
  type SandboxPreviewResult,
  buildPreviewBootstrapScript,
  previewLockfileHash,
  previewDeploymentStatusPath,
  previewSandboxIdentity,
  previewSandboxName,
  selectStalePreviewSandboxIds,
  selectTeardownSandboxIds,
} from './sandbox-preview';
import type { PreviewRuntimeSecrets } from './preview-stack';
import {
  PLATINUM_POOL_MB_DEFAULT,
  PREVIEW_HOST_RAM_MB,
  PREVIEW_SESSION_MAX_IDLE_MS,
  type PlatinumListedSandbox,
  formatPoolUsage,
  poolCannotFit,
  previewHostNames,
  selectPreviewSessionsForTeardown,
  selectStalePreviewSessions,
  summarizePoolUsage,
} from './preview-session-reaper';

const PREVIEW_TIMEOUT_MS = 90 * 60_000;
const LOG_CHUNK_BYTES = 1024 * 1024;

export interface SandboxPreviewDeploymentInput {
  repository: string;
  ref: string;
  sha: string;
  prNumber: number;
  runId: string;
  runAttempt: string;
  root: string;
  lockfileHash: string;
  secrets: PreviewRuntimeSecrets;
  platinum: { apiUrl: string; apiKey: string };
  /**
   * A PERSISTENT per-branch environment instead of an ephemeral per-PR preview.
   *
   * When set, the sandbox is named after the BRANCH and reused across deploys
   * rather than deleted and recreated. That is the whole difference: the
   * sandbox id — and therefore the public URL — stays put, so the environment
   * can be bookmarked, registered as a Stripe webhook target, and keep its
   * Postgres volume (and your signed-in session) across pushes.
   */
  branchEnv?: string;
  /** Run the full suite inside the environment after it comes up. Default true. */
  runTests?: boolean;
  /**
   * The stable origin the environment is reached at, when an operator fronts it
   * with a proxy. The stack is configured with this rather than with the
   * provider's own hostname; the provider hostname stays the proxy's target.
   * Unset for a PR preview, which is reached at its provider origin.
   */
  publicOrigin?: string;
}

type ListedPlatinumSandbox = PlatinumSandbox & PlatinumListedSandbox;

interface PlatinumSandboxPage {
  rows?: ListedPlatinumSandbox[];
  has_more?: boolean;
}

interface PreviewLink {
  url?: string;
  token?: string;
}

function encodedFileCommand(path: string, content: string, mode = '0600'): string {
  if (!/^\/[a-z0-9_./-]+$/i.test(path)) throw new Error(`invalid remote path: ${path}`);
  return `mkdir -p "$(dirname ${path})" && printf %s ${Buffer.from(content).toString('base64')} | base64 -d > ${path} && chmod ${mode} ${path}`;
}

function validatedPreviewUrl(value: string | undefined): string {
  if (!value) throw new Error('sandbox provider did not return a preview URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`sandbox preview URL must use credential-free HTTPS: ${url.origin}`);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.origin;
}

async function writeDeploymentResult(
  root: string,
  result: SandboxPreviewResult,
  input: SandboxPreviewDeploymentInput,
): Promise<void> {
  const directory = resolve(root, 'tests/test-results/preview');
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'deployment.json'),
    `${JSON.stringify(
      {
        ...result,
        repository: input.repository,
        prNumber: input.prNumber,
        gitSha: input.sha,
        reportUrl: result.previewUrl ? `${result.previewUrl}/_tests/` : null,
      },
      null,
      2,
    )}\n`,
  );
}

async function allPlatinumPreviewSandboxes(api: PlatinumApi): Promise<ListedPlatinumSandbox[]> {
  const sandboxes: ListedPlatinumSandbox[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await api.json<PlatinumSandboxPage>(
      `/v1/sandboxes?paginated=true&limit=${limit}&offset=${offset}`,
    );
    sandboxes.push(...(page.rows ?? []));
    if (!page.has_more || (page.rows ?? []).length === 0) return sandboxes;
  }
}

async function deletePlatinum(api: PlatinumApi, sandboxId: string): Promise<void> {
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

async function stopAll(
  api: PlatinumApi,
  sandboxIds: readonly string[],
  label: string,
): Promise<number> {
  let stopped = 0;
  for (const sandboxId of sandboxIds) {
    try {
      if (await stopPlatinum(api, sandboxId)) stopped += 1;
    } catch (error) {
      console.warn(`[sandbox-preview] ${label}: stop ${sandboxId} failed: ${String(error)}`);
    }
  }
  return stopped;
}

/** Stop the running session boxes that belong to these preview hosts. */
async function stopPreviewSessionsOf(
  api: PlatinumApi,
  sandboxes: readonly ListedPlatinumSandbox[],
  hostNames: readonly string[],
): Promise<number> {
  const ids = selectPreviewSessionsForTeardown(sandboxes, hostNames);
  const stopped = await stopAll(api, ids, `sessions of ${hostNames.join(',')}`);
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
  const stopped = new Set<string>();
  for (const box of stale) {
    try {
      if (await stopPlatinum(api, box.id)) stopped.add(box.id);
    } catch (error) {
      console.warn(`[sandbox-preview] sweep: stop ${box.id} failed: ${String(error)}`);
    }
  }
  if (stale.length > 0) {
    const ownerGone = stale.filter((box) => box.reason === 'owner-gone').length;
    console.log(
      `[sandbox-preview] sweep stopped ${stopped.size}/${stale.length} preview session box(es): ` +
        `${ownerGone} with no live host, ${stale.length - ownerGone} idle > ${maxIdleMs() / 3_600_000} h`,
    );
  }
  return stopped;
}

async function stopOwnSessionsAfterSuite(api: PlatinumApi, hostName: string): Promise<void> {
  try {
    await stopPreviewSessionsOf(api, await allPlatinumPreviewSandboxes(api), [hostName]);
  } catch (error) {
    console.warn(`[sandbox-preview] post-suite session stop failed: ${String(error)}`);
  }
}

async function replaceExistingPlatinumPreview(
  api: PlatinumApi,
  prNumber: number,
  sandboxes: readonly ListedPlatinumSandbox[],
): Promise<void> {
  const name = previewSandboxName(prNumber);
  const existing = sandboxes.filter(
    (sandbox) =>
      sandbox.name === name &&
      sandbox.metadata?.owner === 'kortix-preview' &&
      Number(sandbox.metadata?.pr_number) === prNumber,
  );
  // The replaced host takes its database with it, so its session boxes can
  // never be resumed. Stop them before the host goes.
  if (existing.length > 0) await stopPreviewSessionsOf(api, sandboxes, [name]);
  for (const sandbox of existing) await deletePlatinum(api, sandbox.id);
}

export function platinumPreviewIdempotencyKey(input: {
  prNumber: number;
  sha: string;
  runId: string;
}): string {
  return `kortix-preview-${input.prNumber}-${input.sha}-${input.runId}`;
}

export async function deployPlatinumPreview(
  input: SandboxPreviewDeploymentInput,
): Promise<SandboxPreviewResult> {
  const statusPath = previewDeploymentStatusPath(input.runId, input.runAttempt);
  if (!input.platinum.apiKey) throw new PreviewInfrastructureError('PLATINUM_API_KEY is required');
  const api = new PlatinumApi(input.platinum.apiUrl, input.platinum.apiKey);
  let sandboxId = '';
  let launched = false;
  // Set only when this run adopted an existing branch environment, so the
  // failure path below can tell "a box I made" from "the standing environment".
  let reusedSandboxId = '';
  const identity = previewSandboxIdentity(input);
  try {
    const listing = await allPlatinumPreviewSandboxes(api);
    // A branch environment reuses its sandbox; only an ephemeral PR preview is
    // replaced, which is what rotates its URL on every push.
    const reusable = identity.reuseExisting
      ? listing.find(
          (sandbox) => sandbox.name === identity.name && sandbox.metadata?.owner === identity.owner,
        ) ?? null
      : null;
    // Every deploy sweeps the shared org first: preview deploys are frequent,
    // and the daily reconcile alone let 87 idle session boxes fill the pool in
    // under 8 hours on 2026-09-23. Then report who holds the pool, so a refusal
    // below is diagnosable from this log alone.
    const swept = await sweepStalePreviewSessions(api, listing, previewHostNames(listing)).catch(
      (error) => {
        console.warn(`[sandbox-preview] session sweep failed: ${String(error)}`);
        return new Set<string>();
      },
    );
    const usage = summarizePoolUsage(
      listing.filter((sandbox) => !swept.has(sandbox.id)),
      poolMb(),
    );
    console.log(`[sandbox-preview] ${formatPoolUsage(usage)}`);
    const neededMb = reusable && String(reusable.state).toLowerCase() === 'running' ? 0 : PREVIEW_HOST_RAM_MB;
    if (poolCannotFit(usage, neededMb)) {
      console.warn(
        `[sandbox-preview] the pool shows ${Math.max(0, usage.freeMb)} MB free and this host needs ${neededMb} MB; provisioning may be refused`,
      );
    }
    const poolExhausted = (error: unknown): never => {
      if (error instanceof PlatinumHttpError && error.status === 429) {
        throw new PreviewInfrastructureError(
          `Platinum refused the preview host: the org RAM pool is full.\n${formatPoolUsage(usage)}`,
          error,
        );
      }
      throw error;
    };
    // A branch environment idles between deploys; Platinum may have stopped it.
    if (reusable) {
      reusedSandboxId = reusable.id;
      await api
        .json(`/v1/sandboxes/${reusable.id}/start`, { method: 'POST' })
        .catch(() => undefined);
    }
    if (!identity.reuseExisting) {
      await replaceExistingPlatinumPreview(api, input.prNumber, listing);
    }
    const hash = previewLockfileHash(input.lockfileHash);
    const base = await ensureTemplate(
      api,
      buildPlatinumTemplateSpec({
        lockHash: hash,
        repository: input.repository,
        cacheSha: input.sha,
      }),
    );
    const template = await ensureWarmTemplate(api, base, hash);
    const startedAt = Date.now();
    const created =
      reusable ??
      (await api.json<PlatinumSandbox>(
        '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
        {
          method: 'POST',
          headers: { 'idempotency-key': platinumPreviewIdempotencyKey(input) },
          body: JSON.stringify({
            name: identity.name,
            template: template.id,
            type: 'persistent',
            auto_stop_minutes: 0,
            auto_archive_days: identity.autoArchiveDays,
            auto_delete_days: identity.autoDeleteDays,
            cpu: 8,
            ram_mb: 16_384,
            disk_gb: 50,
            expose: [{ port: 8080, public: true }],
            metadata: {
              owner: identity.owner,
              repository: input.repository,
              pr_number: String(input.prNumber),
              git_sha: input.sha,
              run_id: input.runId,
            },
          }),
        },
      ).catch(poolExhausted));
    sandboxId = created.id;
    const sandbox = await observePlatinumSandboxStart({
      sandbox: created,
      startedAt,
      readSandbox: () => api.json<PlatinumSandbox>(`/v1/sandboxes/${created.id}`),
    });
    // "Warm" means a template restore has finished and NOTHING is running yet.
    // A reused branch-environment sandbox is the opposite by construction — it
    // is still serving the previous deploy — so waiting for warmth there can
    // only ever time out. Wait for it on a fresh sandbox only.
    if (!reusable) {
      await waitForWarmSandbox(api, sandboxId, platinumWarmReadinessTimeoutMs(sandbox.via));
    }
    let previewUrl = sandbox.exposed?.find((item) => item.port === 8080)?.url;
    if (!previewUrl) {
      const exposed = await api.json<{ url: string }>(`/v1/sandboxes/${sandboxId}/expose`, {
        method: 'POST',
        body: JSON.stringify({ port: 8080, public: true }),
      });
      previewUrl = exposed.url;
    }
    const sandboxOrigin = validatedPreviewUrl(previewUrl);
    // The stack is CONFIGURED with the origin people actually visit: it ends up
    // in SITE_URL, API_EXTERNAL_URL, CORS_ALLOWED_ORIGINS, the Supabase redirect
    // allowlist and the frontend's own public URLs. Point those at the sandbox
    // while the browser is on the stable name and every auth redirect leaves it.
    const origin = input.publicOrigin ? validatedPreviewUrl(input.publicOrigin) : sandboxOrigin;
    await execPlatinum(api, sandboxId, ['bash', '-lc', 'mkdir -p /workspace/kortix-preview']);
    await api.write(
      `${sandboxId}:/workspace/kortix-preview/runtime-secrets.json`,
      `${JSON.stringify(input.secrets)}\n`,
      '0600',
    );
    await api.write(
      `${sandboxId}:/workspace/run-kortix-preview.sh`,
      buildPreviewBootstrapScript({ ...input, origin, statusPath, hostName: identity.name }),
      '0755',
    );
    const launch = await execPlatinum(api, sandboxId, [
      'bash',
      '-lc',
      'setsid -f /workspace/run-kortix-preview.sh >/workspace/kortix-preview/bootstrap.log 2>&1 </dev/null',
    ]);
    if ((launch.exit_code ?? 0) !== 0) {
      throw new Error(`Platinum preview launch failed: ${launch.stderr ?? ''}`);
    }
    launched = true;
    const exitCode = await observePlatinumWorker({
      startedAt: Date.now(),
      timeoutMs: PREVIEW_TIMEOUT_MS,
      checkExitCode: async () => {
        const status = await statPlatinum(api, sandboxId, statusPath, 1);
        if (!status) return null;
        const bytes = await api.read(
          sandboxId,
          statusPath,
          undefined,
          undefined,
          1,
        );
        const value = Number(new TextDecoder().decode(bytes).trim());
        if (!Number.isInteger(value)) throw new Error('Platinum preview wrote an invalid exit code');
        return value;
      },
      statLog: () => statPlatinum(api, sandboxId, '/workspace/kortix-preview/kortix-preview.log', 1),
      readLog: (offset, limit) =>
        api.read(
          sandboxId,
          '/workspace/kortix-preview/kortix-preview.log',
          offset,
          Math.min(limit, LOG_CHUNK_BYTES),
          1,
        ),
    });
    // An ephemeral PR preview's suite creates real session boxes, and a gate
    // run has nobody left to use them. Stop them now rather than after an idle
    // timeout: their disks stay for inspection and a session resumes on open.
    // A persistent branch environment is a place people work: a redeploy must
    // not interrupt its sessions, so they are left to its deadline reaper.
    if (!identity.reuseExisting) await stopOwnSessionsAfterSuite(api, identity.name);
    const result: SandboxPreviewResult = {
      provider: 'platinum',
      exitCode,
      sandboxId,
      previewUrl: origin,
      sandboxOrigin,
    };
    await downloadPlatinumArtifacts(api, sandboxId, input.root).catch((error) => {
      console.warn(`[sandbox-preview] Platinum result download failed: ${String(error)}`);
    });
    await writeDeploymentResult(input.root, result, input);
    return result;
  } catch (error) {
    if (launched) {
      if (!identity.reuseExisting) await stopOwnSessionsAfterSuite(api, identity.name);
      throw error;
    }
    // Clean up only a sandbox THIS run created. Deleting a reused branch
    // environment would throw away the stable origin it exists to hold — and a
    // failed deploy is a reason to look at it, not to destroy it.
    if (sandboxId && !reusedSandboxId) await deletePlatinum(api, sandboxId).catch(() => {});
    throw new PreviewInfrastructureError('Platinum preview infrastructure failed', error);
  }
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

export async function teardownDaytonaPreview(input: {
  apiUrl: string;
  apiKey: string;
  prNumber: number;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new DaytonaApi(input.apiUrl, input.apiKey);
  const sandbox = await getSandboxByName(api, previewSandboxName(input.prNumber));
  if (!sandbox) return 0;
  if (
    sandbox.labels?.['kortix-preview'] !== 'true' ||
    sandbox.labels?.['kortix-preview-pr'] !== String(input.prNumber)
  ) {
    throw new Error(`refused to delete unowned Daytona sandbox ${sandbox.id}`);
  }
  await deleteDaytonaSandbox(api, sandbox.id);
  return 1;
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
  console.log(
    `[sandbox-preview] ${formatPoolUsage(
      summarizePoolUsage(
        sandboxes.filter((sandbox) => !staleIds.has(sandbox.id) && !stoppedSessions.has(sandbox.id)),
        poolMb(),
      ),
    )}`,
  );
  return stale.length;
}

interface DaytonaSandboxPage {
  items?: DaytonaSandbox[];
  nextCursor?: string | null;
}

export function daytonaPreviewLabelsFilter(): string {
  return JSON.stringify({ 'kortix-preview': 'true' });
}

async function allDaytonaPreviewSandboxes(api: DaytonaApi): Promise<DaytonaSandbox[]> {
  const sandboxes: DaytonaSandbox[] = [];
  let cursor = '';
  do {
    const query = new URLSearchParams({
      limit: '100',
      labels: daytonaPreviewLabelsFilter(),
    });
    if (cursor) query.set('cursor', cursor);
    const page = await api.json<DaytonaSandboxPage>(`/sandbox?${query}`);
    sandboxes.push(...(page.items ?? []));
    cursor = page.nextCursor ?? '';
  } while (cursor);
  return sandboxes;
}

export async function reconcileDaytonaPreviews(input: {
  apiUrl: string;
  apiKey: string;
  activePullRequests: ReadonlyMap<number, string>;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new DaytonaApi(input.apiUrl, input.apiKey);
  const sandboxes = await allDaytonaPreviewSandboxes(api);
  const records = sandboxes.map((sandbox) => ({
    id: sandbox.id,
    metadata: {
      owner: sandbox.labels?.['kortix-preview'] === 'true' ? 'kortix-preview' : '',
      pr_number: sandbox.labels?.['kortix-preview-pr'],
      git_sha: sandbox.labels?.['kortix-preview-git-sha'],
    },
  }));
  const stale = selectStalePreviewSandboxIds(records, input.activePullRequests);
  for (const sandboxId of stale) await deleteDaytonaSandbox(api, sandboxId);
  return stale.length;
}
