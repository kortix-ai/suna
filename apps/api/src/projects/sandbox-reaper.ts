/**
 * Provider-agnostic sandbox reaper + state/billing reconciler.
 *
 * THE problem this fixes (verified live 2026-06-21): session sandboxes stayed
 * running for hours/days after work finished, and the compute meter kept billing
 * them — 1,597 phantom-active compute rows across 23 accounts.
 *
 * Root cause was twofold:
 *   1. Daytona's provider-side auto-stop ("stop after N min of no REQUEST to the
 *      box") never fired because passive traffic — an open tab streaming opencode
 *      events, repeated /start, the server-side opencode-pin hit — touched each
 *      box < auto-stop apart. So "15 min idle" never elapsed.
 *   2. Kortix's own idle GC keyed off `session_sandboxes.last_used_at`, which is
 *      bumped ONLY by /v1/p proxy traffic — a partial signal that real turn/
 *      session traffic never touches — and its stops didn't stick (auto-wake).
 *
 * The fix is to stop trusting "any request" as activity. We define MEANINGFUL
 * activity = a real turn (a prompt / Slack message / agent run), stamped as
 * `metadata.lastTurnAt` at the turn boundary, and we make the PROVIDER's real
 * state (getStatus) the source of truth. A box with no meaningful activity for
 * the TTL is stopped regardless of how much passive traffic it sees, and billing
 * is closed the moment the provider reports it is no longer running.
 *
 * Webhooks (see channels/providers webhook ingress) are the fast path that
 * closes billing the instant a box stops; this reaper is the deterministic
 * backstop that runs even if an event is dropped — together they make
 * "15 min of no real activity → stopped, and never billed while stopped" an
 * invariant rather than a best-effort.
 */

import { and, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getProvider, type ProviderName, type SandboxStatus } from '../platform/providers';
import { invalidateProviderCache } from '../sandbox-proxy';
import { pauseComputeSession, endComputeSession } from '../billing/services/compute-metering';
import { ACTIVE_SESSION_STATUSES } from './lib/session-status';
import { config } from '../config';

export const REAP_BATCH_SIZE = 100;
const REAP_CONCURRENCY = 6;
const DEFAULT_AUTOSTOP_MINUTES = 15;

/** The single knob for "how long with no real turn before we stop a box". */
export function autoStopTtlMs(): number {
  const min = Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || DEFAULT_AUTOSTOP_MINUTES);
  return min * 60_000;
}

export type ReapAction = 'none' | 'stop-idle' | 'reconcile-stopped' | 'reconcile-removed';

export interface ReapDecision {
  action: ReapAction;
  /** Platinum stop→resume is broken (CH resume-freeze) → the next open must
   *  REPROVISION a fresh box rather than start() the stopped one. */
  reprovisionOnResume: boolean;
  reason: string;
}

/**
 * Pure, deterministic decision from the provider's REAL state + meaningful idle.
 * Kept side-effect-free so it is exhaustively unit-tested (the money + UX
 * correctness lives here).
 */
export function decideReap(input: {
  providerStatus: SandboxStatus;
  meaningfulIdleMs: number;
  hasActiveTurn: boolean;
  ttlMs: number;
  provider: ProviderName;
}): ReapDecision {
  const { providerStatus, meaningfulIdleMs, hasActiveTurn, ttlMs, provider } = input;

  // NEVER act on uncertainty. getStatus() returns 'unknown' on a transient
  // provider error or a transitional state (starting/resuming/migrating);
  // stopping or reconciling on that could kill a healthy box or fight a wake.
  if (providerStatus === 'unknown') {
    return { action: 'none', reprovisionOnResume: false, reason: 'provider-unknown' };
  }
  // The external box is gone — finalize billing and mark our row so the next
  // open reprovisions instead of trying to resume a box that no longer exists.
  if (providerStatus === 'removed') {
    return { action: 'reconcile-removed', reprovisionOnResume: true, reason: 'provider-removed' };
  }
  // Provider already stopped/archived it (its own auto-stop, an admin, or a
  // webhook we missed) but our row still says active — reconcile + close billing.
  if (providerStatus === 'stopped') {
    return { action: 'reconcile-stopped', reprovisionOnResume: false, reason: 'provider-stopped' };
  }

  // providerStatus === 'running'
  // A turn in flight (long agent run / streaming) is meaningful even if the last
  // stamped lastTurnAt is older than the TTL — never reap an in-progress turn.
  if (hasActiveTurn) {
    return { action: 'none', reprovisionOnResume: false, reason: 'active-turn' };
  }
  if (meaningfulIdleMs > ttlMs) {
    return { action: 'stop-idle', reprovisionOnResume: provider === 'platinum', reason: 'meaningful-idle' };
  }
  return { action: 'none', reprovisionOnResume: false, reason: 'within-ttl' };
}

/**
 * Last MEANINGFUL activity for a sandbox row. Driven by `metadata.lastTurnAt`
 * (stamped at every turn boundary — the only thing that should keep a box alive)
 * with a fallback to row creation so a never-used box still ages out after the
 * grace TTL. Deliberately does NOT consider `last_used_at` (proxy traffic) or
 * any passive signal.
 */
export function lastMeaningfulAt(row: {
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}): Date {
  const stamped = row.metadata && typeof row.metadata.lastTurnAt === 'string'
    ? new Date(row.metadata.lastTurnAt as string)
    : null;
  if (stamped && !Number.isNaN(stamped.getTime())) {
    return stamped.getTime() >= row.createdAt.getTime() ? stamped : row.createdAt;
  }
  return row.createdAt;
}

function isLifecycleTransitionInProgress(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('state change in progress') || msg.includes('transition in progress');
}

function isAlreadyNotRunning(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('not started') ||
    msg.includes('not running') ||
    msg.includes('already stopped') ||
    msg.includes('not found')
  );
}

/** Merge keys into a jsonb metadata column without clobbering siblings. */
function mergeMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * The metadata patch written when the reaper stops a box. `quiesce` marks an
 * idle-stop so passive traffic can't resurrect it (only an explicit open / new
 * turn clears it); `reprovision` flags that the next open must REPROVISION
 * rather than resume (Platinum's broken stop→resume). Pure so it is unit-tested.
 */
export function buildIdleStopMetadata(opts: { quiesce: boolean; reprovision: boolean; nowIso: string }): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (opts.quiesce) {
    meta.idleQuiesced = true;
    meta.idleQuiescedAt = opts.nowIso;
  }
  if (opts.reprovision) meta.needsReprovision = true;
  return meta;
}

interface ReapCandidate {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: ProviderName;
  externalId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

async function reconcileRowToStopped(row: ReapCandidate, now: Date, quiesce: boolean, reprovision: boolean): Promise<void> {
  // Close billing FIRST (computes the wall-clock delta against the still-active
  // metering row), then flip status, so the final window is billed correctly.
  await pauseComputeSession(row.sandboxId).catch((err) =>
    console.warn(`[reaper] pauseComputeSession failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err),
  );
  const meta = buildIdleStopMetadata({ quiesce, reprovision, nowIso: now.toISOString() });
  await db
    .update(sessionSandboxes)
    .set({
      status: 'stopped',
      updatedAt: now,
      ...(Object.keys(meta).length ? { metadata: mergeMetadata(meta) } : {}),
    })
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  await db
    .update(projectSessions)
    .set({ status: 'stopped', updatedAt: now })
    .where(eq(projectSessions.sessionId, row.sessionId));
  invalidateProviderCache(row.externalId);
}

export interface ReapResult {
  candidates: number;
  stopped: number;      // we issued a provider.stop() for an idle box
  reconciled: number;   // provider already not-running; we synced our row
  billingClosed: number;
  skipped: number;
  errors: number;
}

/**
 * One reaper pass over active session sandboxes. For each:
 *   - ask the provider its REAL state,
 *   - reconcile our row + close billing if it is not running,
 *   - stop it (and close billing) if it has had no meaningful activity for the TTL.
 * Bounded concurrency so a batch of provider round-trips doesn't serialize.
 */
export async function reapAndReconcileSandboxes(now = new Date()): Promise<ReapResult> {
  const ttlMs = autoStopTtlMs();

  const rows = (await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
      createdAt: sessionSandboxes.createdAt,
    })
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.status, 'active'),
      isNotNull(sessionSandboxes.externalId),
    ))
    .limit(REAP_BATCH_SIZE)) as ReapCandidate[];

  const result: ReapResult = { candidates: rows.length, stopped: 0, reconciled: 0, billingClosed: 0, skipped: 0, errors: 0 };
  if (rows.length === 0) return result;

  const sessionIds = rows.map((r) => r.sessionId);
  // The real activity signals, batched (both lookups are indexed):
  //  - last LLM call per session (the truest "a real turn happened" signal,
  //    covering web / Slack / trigger uniformly — the gateway stamps session_id
  //    on usage_events), and
  //  - which sessions have a turn IN FLIGHT (unfinalized stream) — never reap those.
  const [usageResult, activeTurnResult] = await Promise.all([
    loadLastUsageBySession(sessionIds),
    loadActiveTurnSessions(sessionIds),
  ]);
  // FAIL-SAFE: a null result means the lookup itself FAILED (DB/transient). We
  // then cannot prove a box is idle, so we must NOT stop it on uncertain data —
  // same "never act on uncertainty" rule the provider-status path follows.
  // Provider-confirmed stopped/removed reconciliation still proceeds below.
  const activitySignalReliable = usageResult !== null && activeTurnResult !== null;
  const lastUsageBySession = usageResult ?? new Map<string, Date>();
  const activeTurnSessions = activeTurnResult ?? new Set<string>();

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const provider = getProvider(row.provider);
        const providerStatus: SandboxStatus = await provider.getStatus(row.externalId);
        // Meaningful = latest of (stamped lastTurnAt | row creation) and the last
        // LLM call for the session. Passive traffic (proxy/opencode/presence) is
        // deliberately NOT considered.
        const base = lastMeaningfulAt(row);
        const usage = lastUsageBySession.get(row.sessionId);
        const lastMeaningful = usage && usage.getTime() > base.getTime() ? usage : base;
        const meaningfulIdleMs = now.getTime() - lastMeaningful.getTime();
        const decision = decideReap({
          providerStatus,
          meaningfulIdleMs,
          // When the activity signal is unreliable this cycle, treat the box as
          // if a turn is in flight so a running box is never stopped on uncertain
          // data (provider-confirmed stopped/removed still reconciles).
          hasActiveTurn: !activitySignalReliable || activeTurnSessions.has(row.sessionId),
          ttlMs,
          provider: row.provider,
        });

        switch (decision.action) {
          case 'none':
            result.skipped += 1;
            break;
          case 'reconcile-stopped':
            // Quiesce even a provider-confirmed stop: a Daytona native auto-stop
            // (or a webhook/reaper stop) must NOT be resurrected by passive /v1/p
            // traffic (markSandboxUsed heals unflagged stopped rows). It comes
            // back only on an explicit open / real turn, which clears the flag.
            await reconcileRowToStopped(row, now, /* quiesce */ true, false);
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'reconcile-removed':
            await endComputeSession(row.sandboxId).catch((err) =>
              console.warn(`[reaper] endComputeSession failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err),
            );
            // Status MUST be 'stopped' (not 'archived'): openSession only honors
            // `needsReprovision` in its `row.status === 'stopped'` branch. An
            // 'archived' row would fall through to a terminal 'stopped' result and
            // NEVER reprovision — stranding the session. 'stopped' + the marker
            // makes the next open reprovision a fresh box.
            await db
              .update(sessionSandboxes)
              .set({ status: 'stopped', updatedAt: now, metadata: mergeMetadata({ needsReprovision: true }) })
              .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
            await db
              .update(projectSessions)
              .set({ status: 'stopped', updatedAt: now })
              .where(eq(projectSessions.sessionId, row.sessionId));
            invalidateProviderCache(row.externalId);
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'stop-idle':
            try {
              await provider.stop(row.externalId);
            } catch (err) {
              if (isLifecycleTransitionInProgress(err)) {
                result.skipped += 1;
                break;
              }
              if (!isAlreadyNotRunning(err)) {
                result.errors += 1;
                console.error(
                  `[reaper] provider.stop failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`,
                );
                break;
              }
              // Already stopped/gone on the provider side is success — reconcile
              // our row + close billing.
            }
            await reconcileRowToStopped(row, now, /* quiesce */ true, decision.reprovisionOnResume);
            result.stopped += 1;
            result.billingClosed += 1;
            break;
        }
      } catch (err) {
        result.errors += 1;
        console.error(`[reaper] failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, rows.length) }, worker));
  return result;
}

/**
 * Last LLM-usage timestamp per session (the indexed `usage_events.session_id`).
 * Returns `null` on a lookup FAILURE so the caller can fail safe (never stop a
 * box when we can't determine its activity). An empty map = looked up fine, no
 * usage found.
 */
async function loadLastUsageBySession(sessionIds: string[]): Promise<Map<string, Date> | null> {
  const out = new Map<string, Date>();
  if (sessionIds.length === 0) return out;
  try {
    const { usageEvents } = await import('@kortix/db');
    const rows = await db
      .select({ sessionId: usageEvents.sessionId, last: sql<string>`max(${usageEvents.createdAt})` })
      .from(usageEvents)
      .where(inArray(usageEvents.sessionId, sessionIds))
      .groupBy(usageEvents.sessionId);
    for (const r of rows) {
      if (r.sessionId && r.last) {
        const d = new Date(r.last);
        if (!Number.isNaN(d.getTime())) out.set(r.sessionId, d);
      }
    }
    return out;
  } catch (err) {
    console.warn('[reaper] usage-activity lookup failed — failing safe (no stops this cycle):', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Session ids that currently have an unfinalized turn stream (a turn in flight).
 * Returns `null` on a lookup FAILURE so the caller fails safe (never reap when
 * we can't tell if a turn is running). Empty set = looked up fine, none active.
 */
async function loadActiveTurnSessions(sessionIds: string[]): Promise<Set<string> | null> {
  if (sessionIds.length === 0) return new Set();
  try {
    const { chatTurnStreams } = await import('@kortix/db');
    const rows = await db
      .select({ sessionId: chatTurnStreams.sessionId })
      .from(chatTurnStreams)
      .where(and(inArray(chatTurnStreams.sessionId, sessionIds), eq(chatTurnStreams.finalized, false)));
    return new Set(rows.map((r) => r.sessionId));
  } catch (err) {
    console.warn('[reaper] active-turn lookup failed — failing safe (no stops this cycle):', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Billing safety net: an `active` compute session whose box is NOT actually
 * running is over-billing. The reaper pass above closes billing for boxes it
 * sees, but a compute row can outlive its session_sandbox row (deleted/migrated)
 * or be left active after the box was reconciled stopped elsewhere. This pass
 * resolves every still-open metering row against the PROVIDER's real state and
 * closes any that are not running. Deterministic; idempotent.
 */
export async function reconcileOrphanComputeSessions(): Promise<{ checked: number; closed: number; errors: number }> {
  const { sandboxComputeSessions } = await import('@kortix/db');
  // Join the metering row to its sandbox to recover provider + externalId.
  const rows = await db
    .select({
      computeId: sandboxComputeSessions.id,
      sandboxId: sandboxComputeSessions.sandboxId,
      sbStatus: sessionSandboxes.status,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
    })
    .from(sandboxComputeSessions)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sandboxId, sandboxComputeSessions.sandboxId))
    .where(eq(sandboxComputeSessions.state, 'active'))
    .limit(REAP_BATCH_SIZE);

  let closed = 0;
  let errors = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        // No sandbox row, or no external id → the box can't be billed; close it.
        if (!row.externalId || !row.provider) {
          await pauseComputeSession(row.sandboxId);
          closed += 1;
          continue;
        }
        // The reaper pass already closes billing for boxes whose row is still
        // active; here we only need to catch rows whose box is NOT running.
        const status = await getProvider(row.provider as ProviderName).getStatus(row.externalId);
        if (status === 'stopped' || status === 'removed') {
          await pauseComputeSession(row.sandboxId);
          closed += 1;
        }
      } catch (err) {
        errors += 1;
        console.warn(`[reaper] orphan-compute reconcile failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, rows.length) }, worker));
  return { checked: rows.length, closed, errors };
}

const STUCK_SESSION_BATCH = 200;

/**
 * Reconcile project_sessions stuck in an ACTIVE status that have no genuinely-
 * running box behind them. THE leak that wedged Slack ("I'm queued behind other
 * project work") and 429'd new sessions: a session counts against the account's
 * concurrent-session cap while its status is in ACTIVE_SESSION_STATUSES, but the
 * provider reaper (reapAndReconcileSandboxes) only ever visits sessions whose
 * `session_sandboxes` row is still `active`. A session left `running` /
 * `provisioning` / `queued` / `branching` after its box was stopped or removed
 * — a missed stop webhook, a getStatus throttled to 'unknown', a continueSession
 * that flipped stopped→running then failed to deliver, or a create that never
 * got a box — is STRUCTURALLY INVISIBLE to that pass and so eats a cap slot
 * forever. Such sessions accreted to 200+ on a single account and blocked it.
 *
 * This pass closes that gap from the session side. It is DB-ONLY (no provider
 * round-trip), so it is immune to the Daytona throttling that starves the box
 * reaper, and it acts ONLY on sessions that are provably idle:
 *   - status ∈ ACTIVE_SESSION_STATUSES and untouched for longer than the auto-
 *     stop TTL (so a healthy in-flight provision/branch is never touched),
 *   - NO `active` session_sandboxes row (a live box is the provider reaper's job),
 *   - NO in-flight turn (unfinalized chat_turn_stream), and
 *   - NO LLM usage within the TTL window.
 * For each it settles + closes any lingering billing window (DB-only) and flips
 * the session to `stopped` — resumable: the next open reprovisions a fresh box.
 * Idempotent; the status guard on UPDATE avoids racing a concurrent real open.
 */
export async function reconcileStuckActiveSessions(
  now = new Date(),
): Promise<{ candidates: number; reconciled: number; billingClosed: number; errors: number }> {
  const cutoff = new Date(now.getTime() - autoStopTtlMs());
  const { chatTurnStreams, usageEvents } = await import('@kortix/db');

  const candidates = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
        lt(projectSessions.updatedAt, cutoff),
        sql`not exists (select 1 from ${sessionSandboxes} sb where sb.session_id = ${projectSessions.sessionId} and sb.status = 'active')`,
        sql`not exists (select 1 from ${chatTurnStreams} t where t.session_id = ${projectSessions.sessionId} and t.finalized = false)`,
        sql`not exists (select 1 from ${usageEvents} u where u.session_id = ${projectSessions.sessionId} and u.created_at > ${cutoff.toISOString()})`,
      ),
    )
    .limit(STUCK_SESSION_BATCH);

  const result = { candidates: candidates.length, reconciled: 0, billingClosed: 0, errors: 0 };
  if (candidates.length === 0) return result;

  for (const c of candidates) {
    try {
      // Close any lingering billing window for the session's (non-active) box(es).
      // pauseComputeSession is DB-only + idempotent (no-op when no row is open).
      const sbs = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sessionId, c.sessionId));
      for (const sb of sbs) {
        await pauseComputeSession(sb.sandboxId).catch((err) =>
          console.warn(`[reaper] stuck-session pauseComputeSession failed for ${sb.sandboxId}:`, err instanceof Error ? err.message : err),
        );
        result.billingClosed += 1;
      }
      // Re-check the status in the UPDATE predicate so we never clobber a session
      // a real open transitioned out from under us between SELECT and UPDATE.
      const updated = await db
        .update(projectSessions)
        .set({ status: 'stopped', updatedAt: now })
        .where(and(
          eq(projectSessions.sessionId, c.sessionId),
          inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
        ))
        .returning({ sessionId: projectSessions.sessionId });
      if (updated.length) result.reconciled += 1;
    } catch (err) {
      result.errors += 1;
      console.warn('[reaper] stuck-session reconcile failed:', { sessionId: c.sessionId, error: err instanceof Error ? err.message : err });
    }
  }
  return result;
}

/**
 * Close billing + reconcile a sandbox the PROVIDER reports stopped/archived,
 * keyed by external id. The deterministic billing-close path shared by the
 * provider webhook ingress (fast path) and the reaper sweep (backstop).
 * Idempotent: a row already stopped/archived is a no-op. Returns true if it
 * transitioned a live row.
 */
export async function reconcileSandboxStoppedByExternalId(externalId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  if (row.status === 'stopped' || row.status === 'archived') return false;
  await pauseComputeSession(row.sandboxId).catch((err) =>
    console.warn(`[reaper] pauseComputeSession failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err),
  );
  // Quiesce: a provider-confirmed stop must stay stopped — passive /v1/p traffic
  // (markSandboxUsed heal / wakeSandbox) must not resurrect it. Cleared on an
  // explicit open / real turn.
  await db
    .update(sessionSandboxes)
    .set({ status: 'stopped', updatedAt: now, metadata: mergeMetadata(buildIdleStopMetadata({ quiesce: true, reprovision: false, nowIso: now.toISOString() })) })
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  await db.update(projectSessions).set({ status: 'stopped', updatedAt: now }).where(eq(projectSessions.sessionId, row.sessionId));
  invalidateProviderCache(externalId);
  return true;
}

/**
 * The provider reports the box destroyed/deleted/lost — finalize billing and
 * flag the row so the next open reprovisions a fresh box. Keyed by external id;
 * idempotent. Shared by webhook ingress + reaper.
 */
export async function reconcileSandboxRemovedByExternalId(externalId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(`[reaper] endComputeSession failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err),
  );
  // 'stopped' (not 'archived') + needsReprovision so openSession's stopped-branch
  // reprovisions a fresh box on the next open (an archived row would strand it).
  await db
    .update(sessionSandboxes)
    .set({ status: 'stopped', updatedAt: now, metadata: mergeMetadata({ needsReprovision: true }) })
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  await db.update(projectSessions).set({ status: 'stopped', updatedAt: now }).where(eq(projectSessions.sessionId, row.sessionId));
  invalidateProviderCache(externalId);
  return true;
}

/**
 * Invariant monitor (surfaced on /health + alerting): how many `active` compute
 * sessions have a sandbox that is NOT `active`. In steady state this is 0; a
 * non-zero, growing value means billing is leaking and must page. Cheap, DB-only.
 */
export async function countBillingInvariantViolations(): Promise<number> {
  const { sandboxComputeSessions } = await import('@kortix/db');
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sandboxComputeSessions)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sandboxId, sandboxComputeSessions.sandboxId))
    .where(and(
      eq(sandboxComputeSessions.state, 'active'),
      sql`(${sessionSandboxes.status} IS NULL OR ${sessionSandboxes.status} <> 'active')`,
    ));
  return Number(row?.n ?? 0);
}

// ── Orphan provider-box reaper ───────────────────────────────────────────────
//
// The passes above are DB-driven: they reconcile boxes that HAVE a
// session_sandboxes row. A box that loses its row (migration, a dropped create,
// a pre-clamp leftover) — or a persistent (autoStop=0) box nothing else reaps —
// keeps running on the provider forever, invisible to the DB sweep, burning
// compute (the leak observed 2026-06-21: ~85 running boxes the DB didn't track).
// This pass closes the gap from the OTHER side: it lists the boxes THIS
// environment owns on the provider and stops any with no live DB row.
//
// Safety:
//  - Scoped to this env via provider labels (the org is shared across
//    prod/dev/local) — see DaytonaProvider.listManagedRunningSandboxes.
//  - keepSet = every box the DB considers live (active/provisioning) OR touched
//    within ORPHAN_KEEP_RECENT_MS, so an in-flight session is never stopped.
//  - Age grace: a box younger than ORPHAN_BOX_GRACE_MS (or whose createdAt we
//    can't read) is skipped — covers the window between provider-create and the
//    DB row landing.
//  - STOP only, never delete (Daytona auto-archives stopped boxes); bounded per
//    pass; failures are logged and the sweep continues.
const ORPHAN_KEEP_RECENT_MS = 15 * 60_000; // don't stop a just-touched box
const ORPHAN_BOX_GRACE_MS = 60 * 60_000; // a box must be this old to qualify
const ORPHAN_REAP_MAX_PER_PASS = 50; // bound provider stop() calls per pass

export interface OrphanReapResult {
  listed: number;
  orphans: number;
  stopped: number;
  errors: number;
}

export async function reapOrphanProviderBoxes(now = new Date()): Promise<OrphanReapResult> {
  const zero: OrphanReapResult = { listed: 0, orphans: 0, stopped: 0, errors: 0 };
  if (process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED === 'false') return zero;
  // Daytona is the only org-shared provider that leaks this way; Platinum is
  // reconciled on its own path.
  if (!config.DAYTONA_API_KEY) return zero;
  let listManaged: (() => Promise<Array<{ externalId: string; createdAt: Date | null }>>) | undefined;
  try {
    const provider = getProvider('daytona');
    listManaged = provider.listManagedRunningSandboxes?.bind(provider);
  } catch {
    return zero;
  }
  if (!listManaged) return zero;

  let boxes: Array<{ externalId: string; createdAt: Date | null }>;
  try {
    boxes = await listManaged();
  } catch (err) {
    console.warn('[reaper] orphan-box list failed:', err instanceof Error ? err.message : err);
    return zero;
  }
  if (boxes.length === 0) return zero;

  // keepSet: never stop a box the DB considers live or touched recently.
  const keepRows = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(
      and(
        isNotNull(sessionSandboxes.externalId),
        or(
          inArray(sessionSandboxes.status, ['active', 'provisioning']),
          gt(sessionSandboxes.updatedAt, new Date(now.getTime() - ORPHAN_KEEP_RECENT_MS)),
        ),
      ),
    );
  const keep = new Set(keepRows.map((r) => r.externalId).filter((x): x is string => !!x));

  const cutoff = now.getTime() - ORPHAN_BOX_GRACE_MS;
  const orphans = boxes.filter(
    (b) => !keep.has(b.externalId) && b.createdAt != null && b.createdAt.getTime() <= cutoff,
  );

  let stopped = 0;
  let errors = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < orphans.length && stopped + errors < ORPHAN_REAP_MAX_PER_PASS) {
      const box = orphans[cursor++];
      try {
        await getProvider('daytona').stop(box.externalId);
        // Reconcile any DB row (state drift) + close billing; no-op when there's none.
        await reconcileSandboxStoppedByExternalId(box.externalId, now).catch(() => {});
        stopped += 1;
      } catch (err) {
        errors += 1;
        if (errors <= 5) {
          console.warn(
            `[reaper] orphan-box stop failed for ${box.externalId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, orphans.length) }, worker));
  if (stopped || errors) {
    console.log('[reaper] orphan-box sweep', { listed: boxes.length, orphans: orphans.length, stopped, errors });
  }
  return { listed: boxes.length, orphans: orphans.length, stopped, errors };
}
