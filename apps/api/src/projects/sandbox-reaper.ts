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

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getProvider, type ProviderName, type SandboxStatus } from '../platform/providers';
import { invalidateProviderCache } from '../sandbox-proxy';
import { pauseComputeSession, endComputeSession } from '../billing/services/compute-metering';
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
      // Unclaimed warm-pool spares manage their own lifecycle.
      sql`${sessionSandboxes.poolState} IS NULL`,
    ))
    .limit(REAP_BATCH_SIZE)) as ReapCandidate[];

  const result: ReapResult = { candidates: rows.length, stopped: 0, reconciled: 0, billingClosed: 0, skipped: 0, errors: 0 };
  if (rows.length === 0) return result;

  const sessionIds = rows.map((r) => r.sessionId);
  // The real activity signals, batched (both lookups are indexed):
  //  - last LLM call per session (the truest "a real turn happened" signal,
  //    covering web / Slack / trigger uniformly), and
  //  - which sessions have a turn IN FLIGHT (unfinalized stream) — never reap those.
  const [lastUsageBySession, activeTurnSessions] = await Promise.all([
    loadLastUsageBySession(sessionIds),
    loadActiveTurnSessions(sessionIds),
  ]);

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        // Local Docker containers are --rm; stopping discards them. Skip (as before).
        if (row.provider === 'local_docker') {
          result.skipped += 1;
          continue;
        }
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
          hasActiveTurn: activeTurnSessions.has(row.sessionId),
          ttlMs,
          provider: row.provider,
        });

        switch (decision.action) {
          case 'none':
            result.skipped += 1;
            break;
          case 'reconcile-stopped':
            await reconcileRowToStopped(row, now, false, false);
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'reconcile-removed':
            await endComputeSession(row.sandboxId).catch((err) =>
              console.warn(`[reaper] endComputeSession failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err),
            );
            await db
              .update(sessionSandboxes)
              .set({ status: 'archived', updatedAt: now, metadata: mergeMetadata({ needsReprovision: true }) })
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

/** Last LLM-usage timestamp per session (the indexed `usage_events.session_id`). */
async function loadLastUsageBySession(sessionIds: string[]): Promise<Map<string, Date>> {
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
  } catch {
    // Best-effort — never let the activity lookup block the reaper.
  }
  return out;
}

/** Session ids that currently have an unfinalized turn stream (a turn in flight). */
async function loadActiveTurnSessions(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  try {
    const { chatTurnStreams } = await import('@kortix/db');
    const rows = await db
      .select({ sessionId: chatTurnStreams.sessionId })
      .from(chatTurnStreams)
      .where(and(inArray(chatTurnStreams.sessionId, sessionIds), eq(chatTurnStreams.finalized, false)));
    return new Set(rows.map((r) => r.sessionId));
  } catch {
    // Best-effort safety signal — never let it block the reaper.
    return new Set();
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
        if (row.provider === 'local_docker') continue;
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
