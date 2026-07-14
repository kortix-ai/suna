/**
 * Provider-agnostic sandbox reaper + state/billing reconciler.
 *
 * ONE RULE for running boxes: ask the box itself. Each pass probes the box's
 * own opencode session status (sandbox-busy-probe.ts):
 *
 *   busy/retry → alive. Disarm the idle countdown, stamp lastTurnAt.
 *   idle       → the first observation ARMS `metadata.idleObservedAt`; the
 *                stop fires only once the box has stayed OBSERVABLY idle for
 *                the full TTL. The TTL counts from real idleness — never from
 *                a heuristic like "last LLM call", which can predate the turn
 *                end by a whole tool run (the 2026-06-24 mid-session kills).
 *   unknown    → unreachable / legacy box. Fall back to the activity clock
 *                (lastTurnAt | row creation | last LLM usage_event + TTL) so a
 *                wedged daemon can't hold compute billing open forever.
 *
 * Trigger-fired boxes (metadata.source 'trigger:*') confirm idle on a shorter
 * TTL — nobody is waiting on a webhook/cron box.
 *
 * Passive traffic (an open tab streaming events, /v1/p proxy hits, repeated
 * /start polls) is deliberately NEVER treated as activity — trusting it is
 * what once kept idle boxes alive for days (verified live 2026-06-21: 1,597
 * phantom-active compute rows). The provider's own auto-stop timer survives
 * only as the orphan backstop (providerAutoStopBackstopMinutes): its "no
 * inbound requests" signal is blind to local tool runs, so it sits well above
 * the reaper's TTL and matters only when this API is dead.
 *
 * Provider webhooks are the fast path that closes billing the instant a box
 * stops; this reaper is the deterministic backstop that runs even if an event
 * is dropped — together they make "idle for the TTL → stopped, and never
 * billed while stopped" an invariant rather than a best-effort.
 */

import { and, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getProvider, type ProviderName, type SandboxStatus } from '../platform/providers';
import { invalidateProviderCache } from '../sandbox-proxy';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { probeSandboxBusy } from './sandbox-busy-probe';
import { ACTIVE_SESSION_STATUSES } from './lib/session-status';
import { config } from '../config';
import { hasActiveExecutionLease } from './execution-lease';
import { preserveEstablishedRuntime } from './runtime-identity';

export const REAP_BATCH_SIZE = 100;
const REAP_CONCURRENCY = 6;
const DEFAULT_AUTOSTOP_MINUTES = 15;
const DEFAULT_TRIGGER_AUTOSTOP_MINUTES = 5;

/** The single knob for "how long with no real turn before we stop a box". */
export function autoStopTtlMs(): number {
  const min = Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || DEFAULT_AUTOSTOP_MINUTES);
  return min * 60_000;
}

/** Shorter idle window for trigger-fired boxes — no human is waiting on them,
 *  so every idle minute past turn end is pure billed dead time. */
export function triggerAutoStopTtlMs(): number {
  const min = Math.max(1, config.KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES || DEFAULT_TRIGGER_AUTOSTOP_MINUTES);
  return min * 60_000;
}

/** Sandbox rows carry the session's invocation source in `metadata.source`
 *  (stamped at provisioning). 'trigger:*' boxes are unattended; anything else
 *  (ui/slack/cli/missing) is treated as interactive — the safe direction. */
export function isTriggerSession(metadata: Record<string, unknown> | null): boolean {
  const source = metadata?.source;
  return typeof source === 'string' && source.startsWith('trigger:');
}

/** When the reaper first OBSERVED the box idle (probe-confirmed). Null when
 *  never observed / cleared by a busy observation or an explicit resume. */
export function idleObservedAtOf(metadata: Record<string, unknown> | null): Date | null {
  const raw = metadata?.idleObservedAt;
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type IdleConfirmAction = 'arm' | 'wait' | 'stop';

/**
 * The idle TTL counts from OBSERVED idleness, not from the last LLM call —
 * the last usage_event can predate the real turn end by however long the
 * final tool run takes, and stopping "TTL after last LLM call" could kill a
 * box seconds after its turn actually finished. So the first probe-confirmed
 * idle observation only ARMS the timer; the stop fires once the box has
 * stayed observably idle for the full TTL, and any busy observation disarms.
 * Pure so the money semantics are exhaustively unit-tested.
 */
export function decideIdleConfirm(input: {
  idleObservedAt: Date | null;
  now: Date;
  ttlMs: number;
}): IdleConfirmAction {
  const { idleObservedAt, now, ttlMs } = input;
  if (!idleObservedAt || idleObservedAt.getTime() > now.getTime()) return 'arm';
  return now.getTime() - idleObservedAt.getTime() >= ttlMs ? 'stop' : 'wait';
}

export type ReconcileAction = 'none' | 'reconcile-stopped' | 'reconcile-removed';

/**
 * Pure reconcile decision for a box the provider says is NOT running.
 * (Running boxes take the probe path: busy → alive, observed idle for the
 * TTL → stop.) 'unknown' is a transient provider error or a transitional
 * state (starting/resuming/migrating) — NEVER act on uncertainty; acting
 * could kill a healthy box or fight a wake.
 */
export function decideReconcile(providerStatus: SandboxStatus): ReconcileAction {
  // The provider currently reports the external box gone. Preserve its identity
  // and stop billing; a later explicit open may retry that same sandbox.
  if (providerStatus === 'removed') return 'reconcile-removed';
  // Provider already stopped/archived it (its own auto-stop, an admin, or a
  // webhook we missed) but our row still says active — reconcile + close billing.
  if (providerStatus === 'stopped') return 'reconcile-stopped';
  return 'none';
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

export function isAlreadyNotRunning(err: unknown): boolean {
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
 * turn clears it). Stopping never authorizes replacing a data-bearing runtime.
 */
export function buildIdleStopMetadata(opts: { quiesce: boolean; nowIso: string }): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (opts.quiesce) {
    meta.idleQuiesced = true;
    meta.idleQuiescedAt = opts.nowIso;
  }
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

async function reconcileRowToStopped(row: ReapCandidate, now: Date, quiesce: boolean): Promise<void> {
  // Close billing FIRST (computes the wall-clock delta against the still-active
  // metering row), then flip status, so the final window is billed correctly.
  await pauseComputeSession(row.sandboxId).catch((err) =>
    console.warn(`[reaper] pauseComputeSession failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err),
  );
  const meta = buildIdleStopMetadata({ quiesce, nowIso: now.toISOString() });
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
  busyVetoed: number;   // idle-by-clock but the box itself reported a running turn
  idleArmed: number;    // first probe-confirmed idle observation — TTL countdown started
  errors: number;
}

type RunningBoxOutcome = 'stopped' | 'busyVetoed' | 'idleArmed' | 'skipped' | 'errors';

/**
 * The rule for one running box: busy → alive; observed idle for the TTL →
 * shut down; unreachable → activity-clock fallback so a wedged daemon still
 * stops. `fallbackLastMeaningful` is null when this pass's usage lookup
 * failed — then an unreachable box cannot be judged at all and is skipped
 * (never act on uncertainty).
 */
async function reapRunningBox(
  row: ReapCandidate,
  opts: { now: Date; ttlMs: number; fallbackLastMeaningful: Date | null },
): Promise<RunningBoxOutcome> {
  const { now, ttlMs, fallbackLastMeaningful } = opts;
  const busyState = await probeSandboxBusy({ sandboxId: row.sandboxId, externalId: row.externalId });

  if (busyState === 'busy') {
    // A running process — disarm the countdown, stamp the activity.
    await db
      .update(sessionSandboxes)
      .set({ updatedAt: now, metadata: mergeMetadata({ lastTurnAt: now.toISOString(), idleObservedAt: null }) })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    return 'busyVetoed';
  }

  if (busyState === 'idle') {
    const confirm = decideIdleConfirm({ idleObservedAt: idleObservedAtOf(row.metadata), now, ttlMs });
    if (confirm === 'arm') {
      await db
        .update(sessionSandboxes)
        .set({ updatedAt: now, metadata: mergeMetadata({ idleObservedAt: now.toISOString() }) })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
      return 'idleArmed';
    }
    if (confirm === 'wait') return 'skipped';
    // 'stop' — observed idle for the full TTL → fall through to the stop.
  } else {
    // 'unknown' — box unreachable / legacy image: activity-clock fallback.
    if (!fallbackLastMeaningful) return 'skipped';
    if (now.getTime() - fallbackLastMeaningful.getTime() <= ttlMs) return 'skipped';
  }

  try {
    await getProvider(row.provider).stop(row.externalId);
  } catch (err) {
    if (isLifecycleTransitionInProgress(err)) return 'skipped';
    if (!isAlreadyNotRunning(err)) {
      console.error(`[reaper] provider.stop failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`);
      return 'errors';
    }
    // Already stopped/gone on the provider side is success — reconcile.
  }
  await reconcileRowToStopped(row, now, /* quiesce */ true);
  return 'stopped';
}

/**
 * One reaper pass over active session sandboxes. For each:
 *   - ask the provider its REAL state,
 *   - reconcile our row + close billing if it is not running,
 *   - otherwise apply the running-box rule (probe → busy alive / idle countdown).
 * Bounded concurrency so a batch of provider round-trips doesn't serialize.
 */
export async function reapAndReconcileSandboxes(now = new Date()): Promise<ReapResult> {
  const ttlMs = autoStopTtlMs();
  const triggerTtlMs = triggerAutoStopTtlMs();

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

  const result: ReapResult = { candidates: rows.length, stopped: 0, reconciled: 0, billingClosed: 0, skipped: 0, busyVetoed: 0, idleArmed: 0, errors: 0 };
  if (rows.length === 0) return result;

  // Batched fallback signal: last LLM call per session (indexed usage_events).
  // Only consulted for boxes the probe can't reach; null = the lookup itself
  // failed this pass, and unreachable boxes are then skipped (fail safe).
  const lastUsageBySession = await loadLastUsageBySession(rows.map((r) => r.sessionId));

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const providerStatus: SandboxStatus = await getProvider(row.provider).getStatus(row.externalId);

        if (providerStatus === 'running') {
          if (hasActiveExecutionLease(row.metadata, now)) {
            result.busyVetoed += 1;
            continue;
          }
          let fallbackLastMeaningful: Date | null = null;
          if (lastUsageBySession !== null) {
            const base = lastMeaningfulAt(row);
            const usage = lastUsageBySession.get(row.sessionId);
            fallbackLastMeaningful = usage && usage.getTime() > base.getTime() ? usage : base;
          }
          const outcome = await reapRunningBox(row, {
            now,
            ttlMs: isTriggerSession(row.metadata) ? triggerTtlMs : ttlMs,
            fallbackLastMeaningful,
          });
          result[outcome] += 1;
          if (outcome === 'stopped') result.billingClosed += 1;
          continue;
        }

        // ── Not running: reconcile our row to the provider's real state.
        switch (decideReconcile(providerStatus)) {
          case 'none':
            result.skipped += 1;
            break;
          case 'reconcile-stopped':
            // Quiesce even a provider-confirmed stop: a Daytona native auto-stop
            // (or a webhook/reaper stop) must NOT be resurrected by passive /v1/p
            // traffic (markSandboxUsed heals unflagged stopped rows). It comes
            // back only on an explicit open / real turn, which clears the flag.
            await reconcileRowToStopped(row, now, /* quiesce */ true);
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'reconcile-removed':
            // A provider 404 can be a transient archive/restore observation.
            // Preserve the established identity; never turn this signal into a
            // fresh, empty sandbox for the same session.
            await preserveEstablishedRuntime(row, 'provider_reported_removed', now);
            invalidateProviderCache(row.externalId);
            result.reconciled += 1;
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
 *   - NO `active` session_sandboxes row (a live box is the provider reaper's
 *     job) — UNLESS `metadata.deletedAt` is set. A session the user deleted
 *     is tombstoned regardless of what its sandbox row says; this is the
 *     backstop for the provision-finish race (a provisioning attempt that
 *     resurrected a deleted session to 'running' before the row-level guard
 *     landed, or any other path that leaves a deleted session pointing at a
 *     live box) — it must not hide behind the active-sandbox exclusion,
 *   - NO in-flight turn (unfinalized chat_turn_stream), and
 *   - NO LLM usage within the TTL window.
 * For each it settles + closes any lingering billing window (DB-only) and flips
 * the session to `stopped` — resumable in place without changing identity.
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
        or(
          sql`not exists (select 1 from ${sessionSandboxes} sb where sb.session_id = ${projectSessions.sessionId} and sb.status = 'active')`,
          sql`(${projectSessions.metadata}->>'deletedAt') is not null`,
        ),
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
    .set({ status: 'stopped', updatedAt: now, metadata: mergeMetadata(buildIdleStopMetadata({ quiesce: true, nowIso: now.toISOString() })) })
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  await db.update(projectSessions).set({ status: 'stopped', updatedAt: now }).where(eq(projectSessions.sessionId, row.sessionId));
  invalidateProviderCache(externalId);
  return true;
}

/**
 * The provider reports the box destroyed/deleted/lost — finalize billing and
 * preserve the original mapping. Keyed by external id; idempotent. Shared by
 * webhook ingress + reaper.
 */
export async function reconcileSandboxRemovedByExternalId(externalId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
      status: sessionSandboxes.status,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  if (!row.externalId) return false;
  await preserveEstablishedRuntime(row, 'provider_webhook_removed', now);
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
//    prod/dev/local) — each provider adapter owns that filter.
//  - keepSet = every box the DB considers live (active/provisioning) OR touched
//    within ORPHAN_KEEP_RECENT_MS, so an in-flight session is never stopped.
//  - Age grace: a box younger than ORPHAN_BOX_GRACE_MS (or whose createdAt we
//    can't read) is skipped — covers the window between provider-create and the
//    DB row landing.
//  - STOP only, never delete; bounded per
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
  const boxes: Array<{
    provider: ProviderName;
    externalId: string;
    createdAt: Date | null;
  }> = [];
  for (const providerName of config.ALLOWED_SANDBOX_PROVIDERS) {
    try {
      const provider = getProvider(providerName);
      if (!provider.listManagedRunningSandboxes) continue;
      const listed = await provider.listManagedRunningSandboxes();
      boxes.push(...listed.map((box) => ({ provider: providerName, ...box })));
    } catch (err) {
      // One provider control-plane outage must not suppress orphan cleanup on
      // the other configured providers.
      console.warn(
        `[reaper] ${providerName} orphan-box list failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (boxes.length === 0) return zero;

  // keepSet: never stop a box the DB considers live or touched recently.
  const keepRows = await db
    .select({ provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId })
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
  const keep = new Set(
    keepRows
      .filter((row): row is typeof row & { externalId: string } => !!row.externalId)
      .map((row) => `${row.provider}:${row.externalId}`),
  );

  const cutoff = now.getTime() - ORPHAN_BOX_GRACE_MS;
  const orphans = boxes.filter(
    (box) =>
      !keep.has(`${box.provider}:${box.externalId}`) &&
      box.createdAt != null &&
      box.createdAt.getTime() <= cutoff,
  );

  let stopped = 0;
  let errors = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < orphans.length && stopped + errors < ORPHAN_REAP_MAX_PER_PASS) {
      const box = orphans[cursor++];
      try {
        await getProvider(box.provider).stop(box.externalId);
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
