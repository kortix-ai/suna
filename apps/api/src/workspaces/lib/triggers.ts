import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TriggerList } from '@kortix/api-contract';
import { connectors, projectSessions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, desc, eq, gt, ne, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { config } from '../../config';
import { auth, errors } from '../../openapi';
import { db } from '../../shared/db';
import { isLeader } from '../../shared/leader-election';
import { commitFileToBranch, invalidateWorkspaceMirror } from '../git';
import { commitFile, getFileSha, type GitHubAuthContext } from '../github';
import {
  createSession,
  drainSessionLifecycleQueue,
  enqueueContinueSessionCommand,
  resolveAgentRunAttribution,
  resolveWorkspaceAutomationActor,
  sessionBackpressureState,
} from '../session-lifecycle';
import {
  type TriggerExecutionRow,
  claimDueScheduleSlots,
  claimTriggerExecutions,
  countUncatalogedTriggerWorkspaces,
  markTriggerExecutionDispatched,
  markTriggerExecutionFailed,
  markTriggerExecutionSkipped,
  markTriggerExecutionSucceeded,
} from '../trigger-execution-store';
import { reconcileWorkspaceTriggerRuntime } from '../trigger-runtime-catalog';
import { validateTriggerCron, validateTriggerTimezone } from '../trigger-schedule';
import {
  GIT_TRIGGER_SESSION_MODES,
  type GitTriggerSessionMode,
  type GitTriggerSpec,
  type LoadedTriggers,
  MANIFEST_FILENAME,
  type ParsedManifest,
  extractTriggers,
  readManifest,
  serializeManifest,
  synthesizeBlankManifest,
  triggerSpecToTomlEntry,
} from '../triggers';
import { parseGitHubRepoUrl, resolveWorkspaceGitAuth, withWorkspaceGitAuth } from './git';
import {
  type WorkspaceRow,
  type RequestAuditContext,
  deriveKortixApiRoot,
  isPlainObject,
  normalizeBoolean,
  normalizeString,
} from './serializers';

export function normalizeSignatureHeader(value: string | null): string | null {
  const header = normalizeString(value);
  if (!header) return null;
  return header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
}

export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string | null,
) {
  const signature = normalizeSignatureHeader(signatureHeader);
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

// Pull a static shared-secret token from a webhook request's headers, for
// sources that can't HMAC-sign the body (e.g. Better Stack error webhooks, which
// only allow custom headers / basic auth). Order: X-Kortix-Token, then
// Authorization (Bearer <token> or Basic <base64(user:token)> → password).
export function extractWebhookToken(
  kortixToken: string | null | undefined,
  authorization: string | null | undefined,
): string | null {
  if (kortixToken && kortixToken.trim()) return kortixToken.trim();
  if (authorization && authorization.trim()) {
    const trimmed = authorization.trim();
    const sep = trimmed.indexOf(' ');
    const scheme = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
    const value = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
    if (scheme === 'bearer' && value) return value;
    if (scheme === 'basic' && value) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
        return password || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Static-token fallback auth (only consulted when no HMAC signature header is
// present). The token must equal the trigger's secret; constant-time compared.
export function verifyWebhookToken(token: string | null, secret: string): boolean {
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// Pure payload helpers live in ./trigger-payload (no config/db imports, so they
// stay unit-testable without booting the server env). Re-exported here because
// this module has always been their import site.
import { renderPromptTemplate, renderSessionKey } from './trigger-payload';

export {
  isPlainPayloadObject,
  renderPromptTemplate,
  renderSessionKey,
  templateValue,
  triggerFilterMatches,
  valueAtPath,
} from './trigger-payload';

export function parseWebhookJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { raw: rawBody };
  }
}

export function webhookPayload(c: Context, rawBody: string) {
  const body = parseWebhookJsonBody(rawBody);
  return {
    body,
    headers: {
      content_type: c.req.header('content-type') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      forwarded_for: c.req.header('x-forwarded-for') ?? null,
    },
  };
}

export async function triggerBackpressureState(accountId: string, workspaceId: string) {
  return sessionBackpressureState(accountId, workspaceId);
}

// POST /v1/webhooks/workspaces/:workspaceId/:slug
//
// Public fire endpoint for GIT-BACKED webhook triggers. The trigger config
// lives in `.opencode/triggers/<slug>.md` in the workspace repo; the signing
// secret lives in `project_secrets` (referenced from the file via
// `secret_env`). On a valid signed POST, we render the prompt template and
// spawn a session — same as the DB-backed `/v1/webhooks/:triggerId` path,
// but the source of truth is git.

export type TriggerSchedulerTimer = ReturnType<typeof setInterval>;

export const globalForWorkspaceTriggers = globalThis as typeof globalThis & {
  __kortixWorkspaceTriggerSchedulerTimer?: TriggerSchedulerTimer | null;
};

export let triggerSchedulerTimer: TriggerSchedulerTimer | null = null;

export let triggerSweepRunning = false;
let triggerExecutionDrainRunning = false;

// In-memory heartbeat for the trigger scheduler, surfaced at /health so an
// operator can tell at a glance whether the leader's sweep is alive and what
// the last pass did. Lives on the leader pod; resets on restart. This is the
// answer to "how would anyone know the scheduler stopped firing?".
export interface TriggerSchedulerHealth {
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  lastSweepDurationMs: number | null;
  lastResult: {
    projects: number;
    workspaceFailures: number;
    scanned: number;
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  } | null;
  lastError: string | null;
  catalogPendingWorkspaces: number | null;
  lastCatalogSweepCompletedAt: string | null;
  lastCatalogSweepResult: {
    scanned: number;
    synced: number;
    errors: number;
  } | null;
  lastCatalogSweepError: string | null;
  catalogCursor: string | null;
  discoveryCursor: string | null;
  catalogCycleCompletedAt: string | null;
  discoveryCycleCompletedAt: string | null;
  lastClaimLagMs: number | null;
  maxObservedClaimLagMs: number | null;
  lastExecutionDrainStartedAt: string | null;
  lastExecutionDrainCompletedAt: string | null;
  lastExecutionResult: {
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  } | null;
  lastExecutionError: string | null;
}
const schedulerHealth: TriggerSchedulerHealth = {
  lastSweepStartedAt: null,
  lastSweepCompletedAt: null,
  lastSweepDurationMs: null,
  lastResult: null,
  lastError: null,
  catalogPendingWorkspaces: null,
  lastCatalogSweepCompletedAt: null,
  lastCatalogSweepResult: null,
  lastCatalogSweepError: null,
  catalogCursor: null,
  discoveryCursor: null,
  catalogCycleCompletedAt: null,
  discoveryCycleCompletedAt: null,
  lastClaimLagMs: null,
  maxObservedClaimLagMs: null,
  lastExecutionDrainStartedAt: null,
  lastExecutionDrainCompletedAt: null,
  lastExecutionResult: null,
  lastExecutionError: null,
};
export function getTriggerSchedulerHealth(): TriggerSchedulerHealth {
  return schedulerHealth;
}

export function initialCatalogBackfillIncomplete(
  health: Pick<
    TriggerSchedulerHealth,
    'catalogCycleCompletedAt' | 'discoveryCycleCompletedAt' | 'catalogPendingWorkspaces'
  >,
): boolean {
  return (
    health.catalogCycleCompletedAt === null ||
    health.discoveryCycleCompletedAt === null ||
    (health.catalogPendingWorkspaces ?? 1) > 0
  );
}

// ─── Reliability: timeouts + stall detection ─────────────────────────────────
// The 2026-06-21 fleet-wide cron outage: one trigger fire (continueSession
// resuming a dead sandbox) hung forever inside a SEQUENTIAL sweep that awaited
// it with no timeout, so the in-flight guard never cleared and EVERY cron
// stopped firing for ~18h with no error. These bounds make a hung/slow fire
// survivable: one trigger can fail, the rest of the fleet still fires, and the
// scheduler can never wedge — no matter what.

/** Hard cap on a single trigger fire (createSession/continueSession). */
export function triggerFireTimeoutMs(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_FIRE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 45_000;
}

/** Number of project manifests the connector reconciler processes in parallel. */
export function connectorWorkspaceConcurrency(): number {
  const raw = Number(process.env.KORTIX_CONNECTOR_WORKSPACE_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

/** Maximum wall time for one connector reconciliation. */
export function connectorWorkspaceTimeoutMs(): number {
  const raw = Number(process.env.KORTIX_CONNECTOR_WORKSPACE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

/** Rotating raw-git discovery batch size. */
export function manifestDiscoveryBatchSize(): number {
  const raw = Number(process.env.KORTIX_MANIFEST_DISCOVERY_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}

/** Known manifest projects reconciled per connector sweep. */
export function manifestCatalogBatchSize(): number {
  const raw = Number(process.env.KORTIX_MANIFEST_CATALOG_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/**
 * Resolve `p`, or reject once `ms` elapses. The underlying work is NOT
 * cancellable (JS has no promise cancellation), but rejecting lets the caller
 * move on / clear its guard instead of blocking forever on a hung await.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map all items through a bounded worker pool.
 *
 * The output order matches the input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  configuredConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(items.length, Math.floor(configuredConcurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

/**
 * Pure stall check: is the leader's scheduler failing to make progress? Surfaced
 * at /health and used by the in-loop watchdog so a frozen scheduler is loud, not
 * silent. NOT stale when: not leader, the scheduler hasn't ticked yet (grace
 * right after promotion), a sweep completed recently, OR a sweep is in-flight and
 * still within the stale window. Stale only when the latest sweep has been
 * IN-FLIGHT longer than `staleMs`, or the last COMPLETED sweep is older than
 * `staleMs` (the interval died). The in-flight case is why we key off the start
 * time, not a `lastDone=0` sentinel — otherwise a fresh leader's very first
 * (legitimately long) sweep would read as stale the instant it began.
 */
export function isSweepStale(opts: {
  isLeader: boolean;
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  nowMs: number;
  staleMs: number;
}): boolean {
  if (!opts.isLeader) return false;
  if (!opts.lastSweepStartedAt) return false;
  const startedMs = Date.parse(opts.lastSweepStartedAt);
  const completedMs = opts.lastSweepCompletedAt ? Date.parse(opts.lastSweepCompletedAt) : 0;
  // The latest sweep already completed → healthy unless the NEXT one is overdue.
  if (completedMs >= startedMs) return opts.nowMs - completedMs > opts.staleMs;
  // A sweep is in-flight (started, not yet completed) → stale only if it has been
  // running longer than the stale window.
  return opts.nowMs - startedMs > opts.staleMs;
}

function schedulerStaleMs(): number {
  return Math.max(5 * triggerSchedulerIntervalMs(), 5 * 60_000);
}

/** Is the leader's trigger sweep stalled right now? (Wraps the pure check.) */
export function schedulerSweepIsStale(isLeaderNow: boolean, nowMs: number = Date.now()): boolean {
  return isSweepStale({
    isLeader: isLeaderNow,
    lastSweepStartedAt: schedulerHealth.lastSweepStartedAt,
    lastSweepCompletedAt: schedulerHealth.lastSweepCompletedAt,
    nowMs,
    staleMs: schedulerStaleMs(),
  });
}

// Connector reconcile sweep — runs on a slower cadence than the trigger sweep.

export let connectorSweepRunning = false;

export let lastConnectorSweepAt = 0;

export function connectorSweepIntervalMs() {
  const raw = Number(process.env.KORTIX_CONNECTOR_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

export function triggerSchedulerIntervalMs() {
  const raw = Number((config as any).KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_000;
}

export function triggerScheduleClaimLimit(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_SCHEDULE_CLAIM_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 250;
}

export function triggerExecutionConcurrency(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_EXECUTION_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

/**
 * Server-side, per-workspace trigger kill-switch (`projects.metadata.triggers_paused`).
 * When paused, the platform does NOT auto-run any of the workspace's triggers —
 * the cron sweep skips it and inbound webhooks are ignored — even though each
 * trigger is still `enabled` in the repo. This is how you stop ONE repo
 * deployed to TWO independent control planes (e.g. dev.kortix.com + kortix.com,
 * separate DBs/schedulers with no cross-platform dedup) from double-firing every
 * cron: pause it on the deployment you don't want firing. A manual
 * `…/triggers/:slug/fire` is an explicit action and still runs. Toggle via
 * `PATCH /:workspaceId/triggers/activation`.
 */
export function triggersPausedForWorkspace(metadata: unknown): boolean {
  return isPlainObject(metadata) && (metadata as Record<string, unknown>).triggers_paused === true;
}

export function withTriggersPaused(metadata: unknown, paused: boolean): Record<string, unknown> {
  const base = isPlainObject(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  if (paused) base.triggers_paused = true;
  else delete base.triggers_paused;
  return base;
}

/**
 * Loads cataloged trigger projects and fires due cron triggers.
 *
 * Trigger configuration stays in git. The runtime table is the workspace catalog
 * and the last-fire state store.
 */

export async function runWorkspaceTriggerSweep(now = new Date()): Promise<{
  projects: number;
  workspaceFailures: number;
  scanned: number;
  fired: number;
  queued: number;
  failed: number;
  skipped: number;
}> {
  if (triggerSweepRunning) {
    return {
      projects: 0,
      workspaceFailures: 0,
      scanned: 0,
      fired: 0,
      queued: 0,
      failed: 0,
      skipped: 0,
    };
  }
  triggerSweepRunning = true;
  const startedMs = Date.now();
  schedulerHealth.lastSweepStartedAt = now.toISOString();
  const result = {
    projects: 0,
    workspaceFailures: 0,
    scanned: 0,
    fired: 0,
    queued: 0,
    failed: 0,
    skipped: 0,
  };
  let status: 'completed' | 'failed' = 'completed';
  try {
    await runGitTriggerSweep(now, result);
    schedulerHealth.lastError = null;
    return result;
  } catch (err) {
    status = 'failed';
    schedulerHealth.lastError = err instanceof Error ? err.message : String(err);
    console.error('[workspace-triggers/git] sweep failed', err);
    return result;
  } finally {
    schedulerHealth.lastSweepCompletedAt = new Date().toISOString();
    schedulerHealth.lastSweepDurationMs = Date.now() - startedMs;
    schedulerHealth.lastResult = result;
    triggerSweepRunning = false;
    if (status === 'failed' || result.scanned > 0) {
      console.log('[workspace-triggers] schedule claim completed', {
        status,
        durationMs: schedulerHealth.lastSweepDurationMs,
        ...result,
        error: schedulerHealth.lastError,
      });
    }
  }
}

/**
 * Reconcile bounded, rotating batches of manifest projects.
 *
 * UI CRUD and `kortix ship` reconcile inline. The discovery batch catches raw
 * git pushes. The catalog batch refreshes known trigger and connector projects.
 */

let manifestCatalogCursor: string | null = null;

/** Select one keyset-paginated batch of known trigger or connector projects. */
async function selectManifestCatalogWorkspaces(): Promise<WorkspaceRow[]> {
  const limit = manifestCatalogBatchSize();
  const catalogPredicate = or(
    sql`exists (
      select 1
      from ${projectTriggerRuntime}
      where ${projectTriggerRuntime.workspaceId} = ${projects.workspaceId}
    )`,
    sql`exists (
      select 1
      from ${connectors}
      where ${connectors.workspaceId} = ${projects.workspaceId}
    )`,
  );
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.status, 'active'),
        manifestCatalogCursor ? gt(projects.workspaceId, manifestCatalogCursor) : undefined,
        catalogPredicate,
      ),
    )
    .orderBy(projects.workspaceId)
    .limit(limit);

  manifestCatalogCursor = rows.length < limit ? null : (rows.at(-1)?.workspaceId ?? null);
  return rows;
}

let manifestDiscoveryCursor: string | null = null;

/**
 * Select one keyset-paginated batch for raw git pushes.
 *
 * CRUD and `kortix ship` reconcile immediately. This rotating batch is the
 * backstop for pushes that bypass both paths.
 */
async function selectManifestDiscoveryWorkspaces(): Promise<WorkspaceRow[]> {
  const limit = manifestDiscoveryBatchSize();
  const rows = await db
    .select()
    .from(projects)
    .where(
      manifestDiscoveryCursor
        ? and(eq(projects.status, 'active'), gt(projects.workspaceId, manifestDiscoveryCursor))
        : eq(projects.status, 'active'),
    )
    .orderBy(projects.workspaceId)
    .limit(limit);

  manifestDiscoveryCursor = rows.length < limit ? null : (rows.at(-1)?.workspaceId ?? null);
  return rows;
}

export async function runWorkspaceConnectorSweep(): Promise<{
  scanned: number;
  synced: number;
  errors: number;
}> {
  if (connectorSweepRunning) return { scanned: 0, synced: 0, errors: 0 };
  connectorSweepRunning = true;
  const startedMs = Date.now();
  const out = { scanned: 0, synced: 0, errors: 0 };
  let status: 'completed' | 'failed' = 'completed';
  let catalogCycleCompleted = false;
  let discoveryCycleCompleted = false;
  try {
    const { syncWorkspaceConnectors } = await import('../../connectors/sync');
    const [catalogWorkspaces, discoveryWorkspaces] = await Promise.all([
      selectManifestCatalogWorkspaces(),
      selectManifestDiscoveryWorkspaces(),
    ]);
    catalogCycleCompleted = manifestCatalogCursor === null;
    discoveryCycleCompleted = manifestDiscoveryCursor === null;
    const uniqueWorkspaces = new Map<string, WorkspaceRow>();
    for (const workspace of [...catalogWorkspaces, ...discoveryWorkspaces]) {
      uniqueWorkspaces.set(workspace.workspaceId, workspace);
    }
    const workspacesForSweep = [...uniqueWorkspaces.values()];

    const results = await mapWithConcurrency(
      workspacesForSweep,
      connectorWorkspaceConcurrency(),
      async (workspace) => {
        invalidateWorkspaceMirror(workspace.workspaceId);
        try {
          const result = await withTimeout(
            syncWorkspaceConnectors(workspace.workspaceId, workspace.accountId),
            connectorWorkspaceTimeoutMs(),
            `sync connectors ${workspace.workspaceId}`,
          );
          return { synced: result.synced, errors: result.errors.length };
        } catch (error) {
          console.warn('[workspace-connectors] workspace reconcile failed', {
            workspaceId: workspace.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { synced: 0, errors: 1 };
        }
      },
    );
    out.scanned = workspacesForSweep.length;
    for (const result of results) {
      out.synced += result.synced;
      out.errors += result.errors;
    }
    schedulerHealth.catalogPendingWorkspaces = await countUncatalogedTriggerWorkspaces();
    schedulerHealth.lastCatalogSweepError = null;
    return out;
  } catch (error) {
    status = 'failed';
    out.errors += 1;
    schedulerHealth.lastCatalogSweepError = error instanceof Error ? error.message : String(error);
    console.error('[workspace-connectors] sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return out;
  } finally {
    const completedAt = new Date().toISOString();
    schedulerHealth.lastCatalogSweepCompletedAt = completedAt;
    schedulerHealth.lastCatalogSweepResult = out;
    schedulerHealth.catalogCursor = manifestCatalogCursor;
    schedulerHealth.discoveryCursor = manifestDiscoveryCursor;
    if (status === 'completed' && catalogCycleCompleted) {
      schedulerHealth.catalogCycleCompletedAt = completedAt;
    }
    if (status === 'completed' && discoveryCycleCompleted) {
      schedulerHealth.discoveryCycleCompletedAt = completedAt;
    }
    connectorSweepRunning = false;
    console.log('[workspace-connectors] sweep completed', {
      status,
      durationMs: Date.now() - startedMs,
      ...out,
      catalogCursor: manifestCatalogCursor,
      discoveryCursor: manifestDiscoveryCursor,
    });
  }
}

// ─── Git-backed triggers ────────────────────────────────────────────────────
//
// Triggers can ALSO live in the workspace repo at `.opencode/triggers/<slug>.md`
// — see ./triggers.ts for the file format. The repo is the source of truth
// for config (cron expr, prompt, secret_env reference). Runtime state
// (last_fired_at) lives in `project_trigger_runtime` because writing the
// repo on every fire would amplify a 5s scheduler tick into a flood of
// git commits.

/**
 * Find a user we can attribute trigger-spawned sessions to. Git-backed
 * triggers don't have a `created_by` like the DB-backed ones do — we pick
 * the account's first owner as a stable, audit-friendly stand-in.
 */

export async function resolveGitTriggerActor(accountId: string): Promise<string | null> {
  return resolveWorkspaceAutomationActor(accountId);
}

/**
 * Resolve the identity a trigger's automated session PROVISIONS as — the
 * account-member stand-in `createWorkspaceSession` needs for the provisioning/
 * authorization actor (concurrency cap, secret-visibility subject, the
 * standing-role fallback an unactivated agent SA relies on — see
 * `resolveActingActor` in iam/engine-v2.ts). This is intentionally NOT the
 * run's recorded identity: see `attributeFiredTriggerSession` below, which
 * overwrites `project_sessions.created_by` to the agent's own service account
 * right after the row exists — "attribution and authorization stop sharing
 * one field" (docs/specs/2026-07-05-agent-first-config-unification.md §2.2).
 * What a run can actually ACCESS is governed by the AGENT's declared scope in
 * kortix.yaml's `agents:` map (secrets + connectors), applied when the session
 * env is built — not by this stand-in.
 */
export async function resolveTriggerActor(workspace: WorkspaceRow): Promise<string | null> {
  return resolveWorkspaceAutomationActor(workspace.accountId);
}

/**
 * Re-attribute a freshly created trigger-fired session to the firing agent's
 * standing-identity service account: `created_by` (session identity/audit —
 * NOT the visibility gate, which is `visibility: 'project'` for every trigger
 * session regardless of owner) moves off the arbitrary account-owner stand-in
 * `resolveTriggerActor` returns and onto the agent itself. Closes the TODO
 * that lived here: "resolve to the agent's SERVICE ACCOUNT so per-user
 * connectors + secrets bind to the AGENT itself, with no human userId at all."
 *
 * Deliberately a POST-creation fixup rather than changing what `fireGitTrigger`
 * passes as `userId` into `createSession`: that value also drives provisioning
 * (concurrency cap, secret-share subject) and is the fallback identity IAM
 * v2 authorizes as when the agent's SA has no role bound yet (unactivated —
 * the default state for an auto-provisioned agent). Swapping it for the SA
 * there would make every un-activated trigger agent authorize as a bare,
 * role-less service account and lose that fallback outright — see
 * `resolveActingActor` in iam/engine-v2.ts. The authorization path stays
 * exactly as it is today; only the audit-facing owner changes.
 *
 * Best-effort: failures are logged and swallowed — a session that already
 * fired must not be reported as failed over a cosmetic attribution miss.
 * No-op for the `session_mode = "reuse"` path (the reused session's
 * `created_by` was already fixed up the first time it was created).
 */
export async function attributeFiredTriggerSession(input: {
  workspace: WorkspaceRow;
  sessionId: string;
  agentName: string;
}): Promise<void> {
  const serviceAccountId = await resolveAgentRunAttribution({
    accountId: input.workspace.accountId,
    workspaceId: input.workspace.workspaceId,
    agentName: input.agentName,
  });
  if (!serviceAccountId) return;
  try {
    await db
      .update(projectSessions)
      .set({ createdBy: serviceAccountId })
      .where(eq(projectSessions.sessionId, input.sessionId));
  } catch (err) {
    console.warn('[triggers] failed to attribute fired session to agent service account', {
      sessionId: input.sessionId,
      agentName: input.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getGitTriggerRuntime(workspaceId: string, slug: string) {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(
      and(eq(projectTriggerRuntime.workspaceId, workspaceId), eq(projectTriggerRuntime.slug, slug)),
    )
    .limit(1);
  return row ?? null;
}

export async function markGitTriggerFired(
  workspaceId: string,
  slug: string,
  when: Date,
  status: 'fired' | 'queued' = 'fired',
) {
  await db
    .insert(projectTriggerRuntime)
    .values({
      workspaceId,
      slug,
      lastFiredAt: when,
      lastStatus: status,
      lastError: null,
      lastAttemptAt: when,
      updatedAt: when,
    })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.workspaceId, projectTriggerRuntime.slug],
      set: {
        lastFiredAt: when,
        lastStatus: status,
        lastError: null,
        lastAttemptAt: when,
        updatedAt: when,
      },
    });
}

/**
 * Record a failed attempt (fire error or parse error) WITHOUT advancing
 * `last_fired_at`, so the trigger is still due and retries next sweep — but the
 * reason is now visible in the triggers API/UI instead of vanishing into a log.
 */
export async function markGitTriggerAttemptFailed(
  workspaceId: string,
  slug: string,
  when: Date,
  error: string,
) {
  const lastError = error.slice(0, 1000);
  await db
    .insert(projectTriggerRuntime)
    .values({
      workspaceId,
      slug,
      lastStatus: 'failed',
      lastError,
      lastAttemptAt: when,
      updatedAt: when,
    })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.workspaceId, projectTriggerRuntime.slug],
      set: { lastStatus: 'failed', lastError, lastAttemptAt: when, updatedAt: when },
    });
}

/**
 * Find the canonical session to reuse for a `session_mode = "reuse"` trigger:
 * the most recent NON-failed session this trigger created. Sessions are matched
 * via the `trigger_slug` + `trigger_kind` we stamp into `project_sessions.metadata`
 * at fire time (no extra column / migration needed). Failed sessions are skipped
 * so a dead run is abandoned in favor of a freshly-created canonical session.
 */
export async function findReusableTriggerSession(
  workspaceId: string,
  slug: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.workspaceId, workspaceId),
        ne(projectSessions.status, 'failed'),
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${slug}`,
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
        // Same soft-delete guard as the keyed lookup above.
        sql`${projectSessions.metadata} ->> 'deletedAt' IS NULL`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The `session_mode = "keyed"` analogue of {@link findReusableTriggerSession}:
 * the most recent non-failed session this trigger created *for this key*. Uses
 * the same `project_sessions.metadata` stamping trick, so keyed routing needs
 * no extra column and no migration.
 *
 * The key is matched exactly and is caller-supplied data (a chat id, a customer
 * id) — it goes through a bound parameter, never string interpolation.
 */
export async function findKeyedTriggerSession(
  workspaceId: string,
  slug: string,
  sessionKey: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.workspaceId, workspaceId),
        ne(projectSessions.status, 'failed'),
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${slug}`,
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
        sql`${projectSessions.metadata} ->> 'trigger_session_key' = ${sessionKey}`,
        // deleteSession() is a SOFT delete: it stamps metadata.deletedAt and
        // leaves the row 'stopped'. Selecting one would bind this key to a
        // session that can never run again — and because a keyed trigger keeps
        // resolving to the same session, every later message for that chat
        // would be swallowed silently rather than starting a new one.
        sql`${projectSessions.metadata} ->> 'deletedAt' IS NULL`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Durable prompt hand-off into an EXISTING session (`session_mode` pinned /
 * reuse). The direct in-process continueSession() call this replaces was the
 * silent-loss hole: 'pending' (runtime never ready inside the deadline) was
 * TERMINAL on that path — no durable row, no retry, no error log, prompt gone,
 * session showing "queued" forever. Enqueue a durable continue_session command
 * instead: the scheduler's drain tick executes it with retry/backoff, and a
 * dead-letter ships a real error AND parks the session 'failed' (see
 * store.markCommandFailed) so the next fire self-heals via a fresh session.
 * The immediate drain kick keeps the happy path feeling instant.
 *
 * Only liveness is pre-checked here (mirrors continueSession's own guards) —
 * a missing/failed/deleted session must keep falling through to the create
 * path exactly like the old direct call's 'no-session'/'failed' outcomes.
 */
async function enqueueTriggerPrompt(input: {
  workspace: WorkspaceRow;
  sessionId: string;
  actor: string;
  text: string;
  source: 'cron' | 'webhook' | 'manual';
  triggerSlug: string;
  idempotencyKey?: string | null;
}): Promise<'queued' | 'no-session' | 'failed'> {
  const [session] = await db
    .select({ status: projectSessions.status, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  if (!session) return 'no-session';
  if (session.status === 'failed') return 'failed';
  const sessionMeta = (session.metadata ?? {}) as Record<string, unknown>;
  if (typeof sessionMeta.deletedAt === 'string') return 'no-session';

  await enqueueContinueSessionCommand({
    source: `trigger:${input.source}`,
    workspaceId: input.workspace.workspaceId,
    accountId: input.workspace.accountId,
    sessionId: input.sessionId,
    actorUserId: input.actor,
    text: input.text,
    triggerSlug: input.triggerSlug,
    // Same per-due-slot key the create path uses — a fire the sweep timed out
    // on but that actually enqueued isn't duplicated when the next tick retries.
    idempotencyKey: input.idempotencyKey ?? null,
  });
  // Fast path only — the scheduler's 60s drain tick is the delivery guarantee.
  drainSessionLifecycleQueue({ limit: 1 }).catch(() => {});
  return 'queued';
}

/**
 * Fire a git-backed trigger. Triggers are file-defined (kortix.yaml), so there
 * is no DB trigger/event row — the workspace_sessions row carries `trigger_slug`
 * in metadata so audits can still reconstruct the firing path.
 */

export async function fireGitTrigger(input: {
  spec: GitTriggerSpec;
  workspace: WorkspaceRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  source: 'cron' | 'webhook' | 'manual';
  idempotencyKey?: string | null;
  request?: RequestAuditContext;
}): Promise<{
  status: 'fired' | 'queued' | 'failed';
  sessionId?: string;
  commandId?: string;
  error?: string;
  reason?: string;
  deduped?: boolean;
}> {
  const { spec, workspace, payload, renderedPrompt, source } = input;
  // The session's owning identity (created_by / billing / audit). Automated runs
  // never impersonate a picked human — the agent's declared scope governs access.
  // See resolveTriggerActor().
  const actor = await resolveTriggerActor(workspace);
  if (!actor) {
    return { status: 'failed', error: 'No account owner available to own the session' };
  }

  // Session pinning — when a trigger opts into `session_mode = "pinned"`, always
  // re-prompt the EXACT session the user chose (`spec.pinnedSessionId`), not
  // "whatever this trigger last created" (that's `reuse`). If the pinned session
  // is gone/unresumable we degrade gracefully: fall through to the `reuse` block
  // (the trigger's own last session), then to a brand-new session.
  if (spec.sessionMode === 'pinned' && spec.pinnedSessionId) {
    const outcome = await enqueueTriggerPrompt({
      workspace,
      sessionId: spec.pinnedSessionId,
      actor,
      text: renderedPrompt,
      source,
      triggerSlug: spec.slug,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (outcome === 'queued') {
      return {
        status: 'queued',
        sessionId: spec.pinnedSessionId,
        reason: 'prompt queued for delivery',
      };
    }
    // outcome === 'no-session' | 'failed' → pinned session is gone/unusable;
    // fall through to the reuse/create fallback below.
  }

  // Session reuse — when a trigger opts into `session_mode = "reuse"`, re-prompt
  // the canonical session this trigger already created (resuming its sandbox +
  // opencode root) so ONE long-lived session accumulates context across fires,
  // instead of minting a brand-new session every time. If no reusable session
  // exists yet, or the last one is gone/failed, we fall through to createSession
  // below and that fresh session becomes the canonical one for next time. Also
  // the graceful-degradation path for a `pinned` trigger whose pin is dead.
  // Session keying — `session_mode = "keyed"` is `reuse` bucketed by a value
  // rendered from the payload, so one trigger drives one session PER chat /
  // customer / repo. A key that renders empty falls through to a fresh session
  // rather than blending every keyless delivery into a shared one.
  const sessionKey = renderSessionKey(spec, payload);
  if (sessionKey) {
    const keyed = await findKeyedTriggerSession(workspace.workspaceId, spec.slug, sessionKey);
    if (keyed) {
      const outcome = await enqueueTriggerPrompt({
        workspace,
        sessionId: keyed.sessionId,
        actor,
        text: renderedPrompt,
        source,
        triggerSlug: spec.slug,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      if (outcome === 'queued') {
        return {
          status: 'queued',
          sessionId: keyed.sessionId,
          reason: 'prompt queued for delivery',
        };
      }
      // Unusable session for this key → fall through and create a fresh one,
      // which becomes the canonical session for the key going forward.
    }
  }

  if (spec.sessionMode === 'reuse' || spec.sessionMode === 'pinned') {
    const reusable = await findReusableTriggerSession(workspace.workspaceId, spec.slug);
    if (reusable) {
      const outcome = await enqueueTriggerPrompt({
        workspace,
        sessionId: reusable.sessionId,
        actor,
        text: renderedPrompt,
        source,
        triggerSlug: spec.slug,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      if (outcome === 'queued') {
        // The prompt is durably queued (drain retries until delivered or
        // dead-letters loudly) — treat as a successful fire so the scheduler
        // records last_fired_at and doesn't immediately create a dupe.
        return {
          status: 'queued',
          sessionId: reusable.sessionId,
          reason: 'prompt queued for delivery',
        };
      }
      // outcome === 'no-session' | 'failed' → canonical session is unusable;
      // fall through to create a fresh one below.
    }
  }

  const sessionResult = await createSession({
    source: `trigger:${source}`,
    workspace,
    userId: actor,
    requestingPrincipalType: 'human',
    enforceAccountCap: false,
    // Trigger sessions are project automation, not the actor's personal chat —
    // make them project-visible so the whole team can find them.
    visibility: 'project',
    request: input.request,
    queuePolicy: 'on_backpressure',
    idempotencyKey: input.idempotencyKey ?? null,
    body: {
      agent_name: spec.agent,
      initial_prompt: renderedPrompt,
      // A trigger-level model pins this run's session to that model, taking
      // precedence over the agent/account/platform default chain. Omitted
      // (null) leaves resolution to that chain — see GitTriggerSpec.model.
      ...(spec.model ? { opencode_model: spec.model } : {}),
      metadata: {
        trigger_source: source,
        trigger_kind: 'git',
        trigger_slug: spec.slug,
        trigger_type: spec.type,
        // Stamped so findKeyedTriggerSession can route the NEXT delivery for
        // this key back into this session.
        ...(sessionKey ? { trigger_session_key: sessionKey } : {}),
      },
    },
    metadata: {
      trigger_source: source,
      trigger_kind: 'git',
      trigger_slug: spec.slug,
      trigger_type: spec.type,
      ...(sessionKey ? { trigger_session_key: sessionKey } : {}),
      payload_summary: summarizeTriggerPayload(payload),
    },
  });

  if (sessionResult.status === 'queued' || sessionResult.status === 'pending') {
    return {
      status: 'queued',
      commandId: sessionResult.commandId,
      sessionId: sessionResult.sessionId,
      reason: sessionResult.reason,
      deduped: sessionResult.deduped,
    };
  }
  if (sessionResult.error) {
    return {
      status: 'failed',
      error: String(sessionResult.error.body.error ?? 'Failed to create trigger session'),
    };
  }
  const firedSessionId = sessionResult.sessionId ?? sessionResult.row?.sessionId;
  // Re-attribute the run to the agent's own service account (see
  // attributeFiredTriggerSession's docblock). `row.agentName` is the RESOLVED
  // name `createWorkspaceSession` actually persisted (default-sentinel/
  // project-default fallbacks already applied) — using it here means this
  // never re-derives that resolution logic. Best-effort: this must not turn an
  // already-fired session into a failed trigger result.
  if (firedSessionId && sessionResult.row?.agentName) {
    await attributeFiredTriggerSession({
      workspace,
      sessionId: firedSessionId,
      agentName: sessionResult.row.agentName,
    }).catch(() => {});
  }
  return {
    status: 'fired',
    sessionId: firedSessionId,
    commandId: sessionResult.commandId,
    deduped: sessionResult.deduped,
  };
}

export function summarizeTriggerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Strip the rendered body from session metadata — sessions already get the
  // prompt as KORTIX_INITIAL_PROMPT, and we don't want huge payloads in
  // postgres jsonb.
  const { rendered_body: _r, ...rest } = payload as Record<string, unknown>;
  return rest;
}

export async function runGitTriggerSweep(
  now: Date,
  accumulator: {
    projects: number;
    workspaceFailures: number;
    scanned: number;
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  },
): Promise<void> {
  const claimedSlots = await claimDueScheduleSlots({
    now,
    limit: triggerScheduleClaimLimit(),
  });
  if (claimedSlots.length > 0) {
    const batchMaxClaimLagMs = Math.max(
      ...claimedSlots.map((slot) =>
        Math.max(0, now.getTime() - slot.execution.scheduledFor.getTime()),
      ),
    );
    schedulerHealth.lastClaimLagMs = batchMaxClaimLagMs;
    schedulerHealth.maxObservedClaimLagMs = Math.max(
      schedulerHealth.maxObservedClaimLagMs ?? 0,
      batchMaxClaimLagMs,
    );
  }
  accumulator.scanned += claimedSlots.length;
  accumulator.projects += new Set(claimedSlots.map((slot) => slot.execution.workspaceId)).size;
}

async function executeTriggerExecution(
  row: TriggerExecutionRow,
): Promise<'fired' | 'queued' | 'failed' | 'skipped'> {
  const [workspace] = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, row.workspaceId))
    .limit(1);
  if (!workspace || workspace.status !== 'active' || triggersPausedForWorkspace(workspace.metadata)) {
    const reason = !workspace
      ? 'workspace not found'
      : workspace.status !== 'active'
        ? 'workspace is not active'
        : 'workspace triggers are paused';
    await markTriggerExecutionSkipped({
      row,
      skippedAt: new Date(),
      reason,
    });
    return 'skipped';
  }

  const spec = row.spec as unknown as GitTriggerSpec;
  const payload = row.payload as Record<string, unknown>;
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);
  const idempotencyKey = `trigger:cron:${row.workspaceId}:${row.slug}:${row.scheduleRevision}:${row.scheduledFor.toISOString()}`;
  try {
    await markTriggerExecutionDispatched({ row, dispatchedAt: new Date() });
    const result = await withTimeout(
      fireGitTrigger({
        spec,
        workspace,
        payload,
        renderedPrompt,
        source: 'cron',
        idempotencyKey,
      }),
      triggerFireTimeoutMs(),
      `execute scheduled trigger ${row.executionId}`,
    );
    const completedAt = new Date();
    if (result.status === 'fired' || result.status === 'queued') {
      await Promise.all([
        markTriggerExecutionSucceeded({
          row,
          completedAt,
          sessionId: result.sessionId,
          commandId: result.commandId,
        }),
        markGitTriggerFired(
          row.workspaceId,
          row.slug,
          completedAt,
          result.status === 'queued' ? 'queued' : 'fired',
        ),
      ]);
      return result.status;
    }
    const error = result.error ?? result.reason ?? 'scheduled trigger execution failed';
    const state = await markTriggerExecutionFailed({ row, failedAt: completedAt, error });
    await markGitTriggerAttemptFailed(row.workspaceId, row.slug, completedAt, error);
    return state === 'queued' ? 'queued' : 'failed';
  } catch (error) {
    const failedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);
    const state = await markTriggerExecutionFailed({ row, failedAt, error: message });
    await markGitTriggerAttemptFailed(row.workspaceId, row.slug, failedAt, message).catch(() => {});
    return state === 'queued' ? 'queued' : 'failed';
  }
}

export async function drainTriggerExecutionQueue(
  now = new Date(),
): Promise<{ fired: number; queued: number; failed: number; skipped: number }> {
  if (triggerExecutionDrainRunning) {
    return { fired: 0, queued: 0, failed: 0, skipped: 0 };
  }
  triggerExecutionDrainRunning = true;
  schedulerHealth.lastExecutionDrainStartedAt = now.toISOString();
  try {
    const rows = await claimTriggerExecutions({
      now,
      workerId: `trigger-execution:${process.pid}:${now.getTime()}`,
      limit: triggerScheduleClaimLimit(),
    });
    const outcomes = await mapWithConcurrency(rows, triggerExecutionConcurrency(), (row) =>
      executeTriggerExecution(row),
    );
    const result = { fired: 0, queued: 0, failed: 0, skipped: 0 };
    for (const outcome of outcomes) result[outcome] += 1;
    schedulerHealth.lastExecutionResult = result;
    schedulerHealth.lastExecutionError = null;
    return result;
  } catch (error) {
    schedulerHealth.lastExecutionError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    schedulerHealth.lastExecutionDrainCompletedAt = new Date().toISOString();
    triggerExecutionDrainRunning = false;
  }
}

export function startWorkspaceTriggerScheduler(): void {
  if ((config as any).KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForWorkspaceTriggers.__kortixWorkspaceTriggerSchedulerTimer) {
    clearInterval(globalForWorkspaceTriggers.__kortixWorkspaceTriggerSchedulerTimer);
  }
  const tick = () => {
    // Watchdog: if we're the leader but the sweep has stalled (started and never
    // completed within the stale window), make it LOUD. A silent dead scheduler
    // is what turned a single hung fire into an ~18h fleet-wide outage.
    if (schedulerSweepIsStale(isLeader())) {
      console.error(
        '[workspace-triggers] SCHEDULER STALLED — leader but last sweep has not completed',
        {
          lastSweepStartedAt: schedulerHealth.lastSweepStartedAt,
          lastSweepCompletedAt: schedulerHealth.lastSweepCompletedAt,
        },
      );
    }

    drainSessionLifecycleQueue({ limit: 10 })
      .then((result) => {
        if (result.claimed || result.failed) {
          console.log('[session-lifecycle] queue drain completed', result);
        }
      })
      .catch((error) => {
        console.error('[session-lifecycle] queue drain failed:', error);
      });

    runWorkspaceTriggerSweep()
      .then(() => drainTriggerExecutionQueue())
      .then((result) => {
        if (result.fired || result.queued || result.failed || result.skipped) {
          console.log('[workspace-triggers] execution drain completed', result);
        }
      })
      .catch((error) => {
        console.error('[workspace-triggers] scheduler tick failed:', error);
      });

    // Connector reconcile backstop — slower cadence than the trigger sweep so
    // we don't re-read every manifest each tick. Catches out-of-band manifest
    // edits (raw git push / CLI) and heals any DB drift / retries error rows.
    if (Date.now() - lastConnectorSweepAt >= connectorSweepIntervalMs()) {
      lastConnectorSweepAt = Date.now();
      runWorkspaceConnectorSweep()
        .then(() => {
          if (initialCatalogBackfillIncomplete(schedulerHealth)) {
            // On a new scheduler release, drain the bounded catalog batches
            // continuously instead of waiting two minutes between each batch.
            // Once both cursors complete a full cycle with no pending rows, the
            // normal connector cadence resumes. Individual project failures
            // retry on that bounded cadence; a permanently inaccessible repo
            // must not force an unbounded full-fleet reconciliation loop.
            lastConnectorSweepAt = 0;
          }
        })
        .catch((error) => {
          lastConnectorSweepAt = 0;
          console.error('[workspace-connectors] sweep failed:', error);
        });
    }
  };
  tick();
  triggerSchedulerTimer = setInterval(tick, triggerSchedulerIntervalMs());
  globalForWorkspaceTriggers.__kortixWorkspaceTriggerSchedulerTimer = triggerSchedulerTimer;
}

export function stopWorkspaceTriggerScheduler(): void {
  if (triggerSchedulerTimer) {
    clearInterval(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  if (globalForWorkspaceTriggers.__kortixWorkspaceTriggerSchedulerTimer) {
    clearInterval(globalForWorkspaceTriggers.__kortixWorkspaceTriggerSchedulerTimer);
    globalForWorkspaceTriggers.__kortixWorkspaceTriggerSchedulerTimer = null;
  }
}

// GET /v1/projects

export function buildPublicWebhookUrl(workspaceId: string, slug: string): string {
  const root = deriveKortixApiRoot(config.KORTIX_URL);
  return `${root}/v1/webhooks/workspaces/${workspaceId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */

export async function loadTriggersForResponse(
  workspaceId: string,
  workspace: WorkspaceRow,
): Promise<TriggerList> {
  const gitWorkspace = await withWorkspaceGitAuth(workspace);
  let manifest: ParsedManifest | null = null;
  let loaded: LoadedTriggers;
  try {
    manifest = await readManifest(gitWorkspace);
    loaded = manifest ? extractTriggers(manifest) : { specs: [], errors: [] };
  } catch (error) {
    loaded = {
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: gitWorkspace.manifestPath || MANIFEST_FILENAME,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const { specs, errors } = loaded;
  if (manifest) {
    await reconcileWorkspaceTriggerRuntime(workspaceId, specs);
  }
  const runtimeRows =
    specs.length === 0
      ? []
      : await db
          .select()
          .from(projectTriggerRuntime)
          .where(eq(projectTriggerRuntime.workspaceId, workspaceId));
  const runtimeBySlug = new Map(runtimeRows.map((row) => [row.slug, row]));

  return {
    triggers: specs.map((spec) => ({
      slug: spec.slug,
      path: spec.path,
      name: spec.name,
      type: spec.type,
      agent: spec.agent,
      model: spec.model,
      enabled: spec.enabled,
      cron: spec.cron,
      run_at: spec.runAt,
      timezone: spec.timezone,
      secret_env: spec.secretEnv,
      prompt_template: spec.promptTemplate,
      session_mode: spec.sessionMode,
      session_id: spec.pinnedSessionId,
      session_key: spec.sessionKey,
      filter: spec.filter,
      last_fired_at: runtimeBySlug.get(spec.slug)?.lastFiredAt?.toISOString() ?? null,
      last_status: runtimeBySlug.get(spec.slug)?.lastStatus ?? null,
      last_error: runtimeBySlug.get(spec.slug)?.lastError ?? null,
      last_attempt_at: runtimeBySlug.get(spec.slug)?.lastAttemptAt?.toISOString() ?? null,
      webhook_url: spec.type === 'webhook' ? buildPublicWebhookUrl(workspaceId, spec.slug) : null,
    })),
    // Server-side activation state for this workspace's whole trigger set. When
    // true, the platform won't auto-run any of them (cron sweep skips, webhooks
    // ignored), regardless of each trigger's own `enabled`.
    triggers_paused: triggersPausedForWorkspace(workspace.metadata),
    errors,
  };
}

export interface TriggerDraft {
  slug: string;
  name: string;
  type: 'cron' | 'webhook';
  agent: string;
  /** Wire-form model (`provider/model`) or null for "Default" (resolve at fire time). */
  model: string | null;
  enabled: boolean;
  promptTemplate: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  secretEnv: string | null;
  sessionMode: GitTriggerSessionMode;
  /** For sessionMode === 'pinned' only: the exact session id to loop. */
  pinnedSessionId: string | null;
  /** For sessionMode === 'keyed' only: the template deriving one session per key. */
  sessionKey: string | null;
  /** Payload paths that must match for a delivery to fire. Null when unfiltered. */
  filter: Record<string, string> | null;
}

export function parseTriggerDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): TriggerDraft | { error: string } {
  const rawSlug = normalizeString((body as any).slug);
  const name = normalizeString((body as any).name);
  if (!name) return { error: 'name is required' };

  const slug = opts.existingSlug ?? rawSlug ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const type =
    (body as any).type === 'webhook' ? 'webhook' : (body as any).type === 'cron' ? 'cron' : null;
  if (!type) return { error: 'type must be "cron" or "webhook"' };

  const promptTemplate = normalizeString(
    (body as any).prompt_template ?? (body as any).promptTemplate,
  );
  if (!promptTemplate) return { error: 'prompt_template is required' };

  const agent = normalizeString((body as any).agent ?? (body as any).agent_name) ?? 'default';
  // null/empty model = "Default" — leave it to the resolution chain at fire time.
  const model = normalizeString((body as any).model) ?? null;
  const enabled = normalizeBoolean((body as any).enabled) ?? true;

  const sessionModeRaw = normalizeString((body as any).session_mode ?? (body as any).sessionMode);
  if (
    sessionModeRaw &&
    !(GIT_TRIGGER_SESSION_MODES as readonly string[]).includes(sessionModeRaw)
  ) {
    return {
      error: `session_mode must be one of ${GIT_TRIGGER_SESSION_MODES.map((m) => `"${m}"`).join(', ')}`,
    };
  }
  // Declaring a `session_key` IS the opt-in to keyed sessions — requiring both
  // it and `session_mode: keyed` was redundant. An explicit mode still wins, so
  // `session_mode: fresh` + a stray key stays fresh (and nulls the key below).
  const sessionKeyRaw = normalizeString((body as any).session_key ?? (body as any).sessionKey);

  const sessionMode: GitTriggerSessionMode = sessionModeRaw
    ? (sessionModeRaw as GitTriggerSessionMode)
    : sessionKeyRaw
      ? 'keyed'
      : 'fresh';
  const pinnedSessionIdRaw = normalizeString((body as any).session_id ?? (body as any).sessionId);
  if (sessionMode === 'pinned' && !pinnedSessionIdRaw) {
    return { error: 'session_mode "pinned" requires a session_id to pin the trigger to' };
  }
  const pinnedSessionId: string | null =
    sessionMode === 'pinned' ? (pinnedSessionIdRaw ?? null) : null;

  // An EXPLICIT keyed mode with no key is still an error — nothing to bucket by.
  if (sessionMode === 'keyed' && !sessionKeyRaw) {
    return {
      error:
        'session_mode "keyed" requires a session_key template (e.g. "{{ body.data.chat_jid }}")',
    };
  }
  const sessionKey: string | null = sessionMode === 'keyed' ? (sessionKeyRaw ?? null) : null;

  const filterRaw = (body as any).filter;
  let filter: Record<string, string> | null = null;
  if (filterRaw !== undefined && filterRaw !== null) {
    if (!isPlainObject(filterRaw)) {
      return { error: 'filter must be an object mapping payload paths to expected values' };
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(filterRaw)) {
      const trimmed = key.trim();
      if (!trimmed) return { error: 'filter keys must be non-empty payload paths' };
      if (value === null || typeof value === 'object') {
        return { error: `filter.${trimmed} must be a string, number, or boolean` };
      }
      entries[trimmed] = String(value);
    }
    if (Object.keys(entries).length > 0) filter = entries;
  }

  if (type === 'cron') {
    const timezone = normalizeString((body as any).timezone) ?? 'UTC';
    const timezoneError = validateTriggerTimezone(timezone);
    if (timezoneError) return { error: timezoneError };
    // One-off ("run once") schedules carry `run_at` instead of `cron`.
    const runAtRaw = normalizeString((body as any).run_at ?? (body as any).runAt);
    if (runAtRaw) {
      const parsed = Date.parse(runAtRaw);
      if (Number.isNaN(parsed)) {
        return { error: `run_at must be an ISO-8601 datetime (got "${runAtRaw}")` };
      }
      return {
        slug,
        name,
        type: 'cron',
        agent,
        model,
        enabled,
        promptTemplate,
        cron: null,
        runAt: new Date(parsed).toISOString(),
        timezone,
        secretEnv: null,
        sessionMode,
        pinnedSessionId,
        sessionKey,
        filter,
      };
    }
    const cron = normalizeString((body as any).cron ?? (body as any).schedule);
    if (!cron)
      return { error: 'cron triggers must declare a `cron` expression or a one-off `run_at`' };
    const cronError = validateTriggerCron(cron, timezone);
    if (cronError) return { error: cronError };
    return {
      slug,
      name,
      type: 'cron',
      agent,
      model,
      enabled,
      promptTemplate,
      cron,
      runAt: null,
      timezone,
      secretEnv: null,
      sessionMode,
      pinnedSessionId,
      sessionKey,
      filter,
    };
  }

  const secretEnv = normalizeString((body as any).secret_env ?? (body as any).secretEnv);
  if (!secretEnv) return { error: 'webhook triggers must declare `secret_env`' };
  if (!/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
    return { error: `secret_env must look like a project_secrets name (got "${secretEnv}")` };
  }
  return {
    slug,
    name,
    type: 'webhook',
    agent,
    model,
    enabled,
    promptTemplate,
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv,
    sessionMode,
    pinnedSessionId,
    sessionKey,
    filter,
  };
}

/** Convert an existing spec back to body shape so we can splat it into a
 * PATCH merge before re-parsing. */

export function specToBody(spec: GitTriggerSpec): Record<string, unknown> {
  return {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
    model: spec.model,
    enabled: spec.enabled,
    prompt_template: spec.promptTemplate,
    cron: spec.cron,
    // Carry the one-off instant too, or a PATCH that touches anything else on a
    // `run_at` trigger would drop its schedule and fail re-validation ("cron
    // triggers must declare a `cron` expression or a one-off `run_at`").
    run_at: spec.runAt,
    timezone: spec.timezone,
    secret_env: spec.secretEnv,
    session_mode: spec.sessionMode,
    session_id: spec.pinnedSessionId,
    session_key: spec.sessionKey,
    filter: spec.filter,
  };
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'trigger'
  );
}

export function draftToSpec(
  draft: TriggerDraft,
  manifestPath: string = MANIFEST_FILENAME,
): GitTriggerSpec {
  return {
    slug: draft.slug,
    // Use the ACTUAL manifest path so a YAML workspace's trigger spec reports
    // `kortix.yaml#triggers.<slug>`, not a hardcoded `kortix.toml#…`.
    path: `${manifestPath}#triggers.${draft.slug}`,
    name: draft.name,
    type: draft.type,
    agent: draft.agent,
    model: draft.model,
    enabled: draft.enabled,
    promptTemplate: draft.promptTemplate,
    cron: draft.cron,
    runAt: draft.runAt,
    timezone: draft.timezone,
    secretEnv: draft.secretEnv,
    sessionMode: draft.sessionMode,
    pinnedSessionId: draft.pinnedSessionId,
    sessionKey: draft.sessionKey,
    filter: draft.filter,
  };
}

/**
 * Read the workspace's manifest. If the manifest doesn't exist yet (brand-new
 * repo), synthesize a minimal valid one so the first POST /triggers can
 * scaffold it on save.
 *
 * MUST be kortix_version 2, not KNOWN_SCHEMA_VERSION (which deliberately
 * stays pinned at 1 — see its own doc comment in ../triggers.ts). Every
 * project created through POST /projects/provision (seeded or not) is
 * stamped `metadata.require_declared_agents: true` and reads/writes
 * through the v2-only agent-config API (`applyAgentBlockV2`/
 * `applyDefaultAgentV2` in ./agent-config-v2.ts hard-refuse a v1
 * manifest). A blank project (no `seed_starter`, so no kortix.yaml ever
 * got pushed) synthesizing v1 here meant every agent-config write 400'd
 * with "upgrade to kortix_version 2" before it could ever commit a real
 * manifest — a self-inflicted catch-22 that left the workspace permanently
 * un-declarable (AGENT_NOT_DECLARED on every session-create) short of a
 * force-pushed kortix.yaml or a full re-provision with `seed_starter:true`.
 *
 * Delegates the actual synthesis to `synthesizeBlankManifest` (../triggers.ts)
 * — the SAME shape `loadWorkspaceAgents` (../agents.ts) synthesizes on the
 * session-create read path, so a blank workspace's declared-agent check passes
 * with zero writes needed on EITHER path, not just this edit one (see that
 * function's doc comment for why the two must stay in sync).
 */
type ManifestWorkspace = WorkspaceRow & {
  gitAuthToken?: string | null;
  gitAuthHeaders?: Record<string, string>;
};

function hasResolvedGitAuth(workspace: ManifestWorkspace): workspace is WorkspaceRow & {
  gitAuthToken: string | null;
  gitAuthHeaders?: Record<string, string>;
} {
  return 'gitAuthToken' in workspace || 'gitAuthHeaders' in workspace;
}

export async function loadManifestForEdit(workspace: ManifestWorkspace): Promise<ParsedManifest> {
  const gitWorkspace = hasResolvedGitAuth(workspace) ? workspace : await withWorkspaceGitAuth(workspace);
  const existing = await readManifest(gitWorkspace);
  if (existing) return existing;
  return synthesizeBlankManifest({ name: workspace.name, manifestPath: workspace.manifestPath });
}

/** Insert or replace a trigger by slug inside the manifest's triggers array. */

export function upsertTriggerInManifest(
  manifest: ParsedManifest,
  spec: GitTriggerSpec,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const idx = current.findIndex(
    (entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug,
  );
  const entry = triggerSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/** Remove a trigger by slug from the manifest's triggers array. */

export function removeTriggerFromManifest(manifest: ParsedManifest, slug: string): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const next = current.filter((entry) => !(typeof entry?.slug === 'string' && entry.slug === slug));
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/**
 * Commit a single file to the workspace's default branch — the generic engine
 * behind `commitManifest` (kortix.yaml/toml) and the agent-config route's
 * `.md` behavior-file writes. One file, one commit per call.
 */
export async function commitRepoFile(
  workspace: ManifestWorkspace,
  path: string,
  content: string,
  message: string,
  expectedFileRevision?: string | null,
  expectedCandidatePaths?: readonly string[],
): Promise<{ ok: true } | { error: string; status: number }> {
  const branch = workspace.defaultBranch;

  // GitHub repos: commit through the Contents API (App / PAT auth) — the
  // lightweight single-file path that doesn't need a full clone.
  const repo = parseGitHubRepoUrl(workspace.repoUrl);
  if (repo && expectedFileRevision === undefined) {
    let auth: GitHubAuthContext | undefined;
    if (hasResolvedGitAuth(workspace)) {
      auth = workspace.gitAuthToken
        ? { token: workspace.gitAuthToken, source: 'project_credential' }
        : undefined;
    } else {
      try {
        auth = (await resolveWorkspaceGitAuth(workspace)).auth ?? undefined;
      } catch (err) {
        return {
          error: `GitHub auth unavailable: ${(err as Error).message || String(err)}`,
          status: 502,
        };
      }
    }
    try {
      const existingSha = await getFileSha({
        owner: repo.owner,
        repo: repo.repo,
        path,
        branch,
        auth,
      });
      await commitFile({
        owner: repo.owner,
        repo: repo.repo,
        path,
        content,
        message,
        branch,
        existingSha: existingSha ?? undefined,
        auth,
      });
    } catch (err) {
      return {
        error: `Failed to commit ${path}: ${(err as Error).message || String(err)}`,
        status: 502,
      };
    }
    invalidateWorkspaceMirror(workspace.workspaceId);
    return { ok: true };
  }

  // Any other host (GitLab, generic HTTPS remote): commit via the git CLI.
  // The old code bailed here with "Workspace repo URL is
  // not a GitHub URL", which broke every connector and trigger manifest edit
  // on managed/self-hosted projects. Mirrors createRemoteSessionBranch's
  // GitHub-fast-path / git-CLI-fallback split.
  let gitWorkspace: WorkspaceRow & {
    gitAuthToken: string | null;
    gitAuthHeaders?: Record<string, string>;
  };
  if (hasResolvedGitAuth(workspace)) {
    gitWorkspace = {
      ...workspace,
      gitAuthToken: workspace.gitAuthToken ?? null,
    };
  } else {
    try {
      gitWorkspace = await withWorkspaceGitAuth(workspace);
    } catch (err) {
      return {
        error: `Git auth unavailable: ${(err as Error).message || String(err)}`,
        status: 502,
      };
    }
  }
  if (!gitWorkspace.gitAuthToken) {
    return { error: 'No git credentials available to write to the workspace repo', status: 502 };
  }

  try {
    await commitFileToBranch(gitWorkspace, {
      path,
      content,
      message,
      branch,
      authorName: 'Kortix',
      authorEmail: 'noreply@kortix.ai',
      expectedFileRevision:
        expectedFileRevision === undefined
          ? undefined
          : { path, sha: expectedFileRevision, candidatePaths: expectedCandidatePaths },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'GitFileRevisionConflictError') {
      return { error: err.message, status: 409 };
    }
    return {
      error: `Failed to commit ${path}: ${(err as Error).message || String(err)}`,
      status: 502,
    };
  }

  invalidateWorkspaceMirror(workspace.workspaceId);
  return { ok: true };
}

/**
 * Commit a new revision of the workspace manifest (kortix.yaml, or kortix.toml
 * for a legacy v1 project) to the workspace's default branch. All trigger CRUD
 * funnels through this — one file, one commit per edit.
 */

export async function commitManifest(
  workspace: ManifestWorkspace,
  manifest: ParsedManifest,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const content = serializeManifest(manifest);
  // Write back to the SAME file we read (kortix.yaml or kortix.toml, or a custom
  // path) in its own format — never a hardcoded name, or a yaml workspace's edits
  // would silently land in a second kortix.toml the runtime doesn't read.
  const manifestFile = manifest.path || workspace.manifestPath || MANIFEST_FILENAME;
  return commitRepoFile(
    workspace,
    manifestFile,
    content,
    message,
    manifest.revision,
    manifest.candidatePaths,
  );
}

// POST /v1/projects/:workspaceId/triggers
//
// Creates a new trigger file in the workspace repo at
// `.opencode/triggers/<slug>.md`. The slug is derived from the body's `slug`
// (or `name`) and validated for URL safety. Body shape:
//   { slug?, name, type: 'cron'|'webhook', agent?, enabled?,
//     prompt_template, cron?, timezone?, secret_env? }
