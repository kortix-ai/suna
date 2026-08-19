/**
 * Per-session ingest-rate ceiling for sandbox-reported OpenCode audit events.
 *
 * WHY THIS EXISTS
 * ---------------
 * `kortix.audit_events` carries 14 indexes (packages/db/src/schema/kortix.ts:2688-2741)
 * and is written on essentially every request. The sandbox relay forwards EVERY
 * OpenCode SSE event 1:1 with no type filter
 * (apps/kortix-sandbox-agent-server/src/opencode-events.ts:223 ->
 * opencode-audit-relay.ts), and it stamps a fresh `randomUUID()` per emission,
 * so the `idx_audit_events_source_phase` unique index only ever catches a
 * transport retry — never a genuine repeat delta. Nothing bounded the write
 * rate.
 *
 * During release-gate run 32151213430 (attempt 8) ONE session emitted ~1725
 * `opencode.message.part.delta` rows per minute. The resulting index-maintenance
 * lock contention took the staging API down, and the edge worker laundered the
 * 5xx into a generic `MAINTENANCE_MODE` 503 — so the log said "maintenance"
 * while the real cause was a single runaway turn (see the 2026-08-18/19
 * learnings entries).
 *
 * WHAT THIS DOES
 * --------------
 * Counts every event ingested for a session inside a fixed window. Once the
 * window is over the ceiling it stops PERSISTING the one high-volume class —
 * per-token stream deltas — for the rest of that window, and emits exactly one
 * `session.event_rate_limited` row naming the counts. Lifecycle, tool,
 * permission, question, error, auth and billing events are NEVER dropped: they
 * are low-volume and each one is forensically load-bearing. A dropped delta
 * costs nothing that the surrounding `.updated` and lifecycle events do not
 * already imply.
 *
 * DESIGN NOTES
 * ------------
 * - The counter is a FIXED (tumbling) window, not a true sliding one. A sliding
 *   window has to retain a timestamp per event, which means the guard's own
 *   memory grows with exactly the load it exists to contain. A tumbling window
 *   is O(1) state per session. The cost is that a burst straddling a boundary
 *   can pass up to 2x the ceiling in 60s; that is still far under the runaway
 *   rate, and the next window re-engages immediately.
 * - In-memory and per process. No new table, no extra DB round-trip on the hot
 *   path — a guard that writes to the database to decide whether to write to the
 *   database would deepen the exact contention it is here to relieve. With N API
 *   tasks the effective ceiling is N x the configured value; the default is set
 *   low enough that this still bounds the runaway well below the observed rate.
 * - This module never throws and never awaits. The caller treats a failure as
 *   "persist everything", because a guard bug must not cost an audit write.
 */

import type { auditEvents } from '@kortix/db';
import { createHash } from 'node:crypto';

type AuditInsert = typeof auditEvents.$inferInsert;

/** Action written when a session trips the ceiling. One row per hot window. */
export const SESSION_EVENT_RATE_LIMITED_ACTION = 'session.event_rate_limited';

/** Own ledger so the notice can never collide with a relayed OpenCode event. */
export const RATE_GUARD_SOURCE_LEDGER = 'kortix_audit_rate_guard';

/** The single event class this guard is allowed to drop. */
export const SUPPRESSED_ACTION_CLASS = 'opencode.message.part.delta';

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Width of one counting window. */
export function auditRateWindowMs(): number {
  return positiveEnvInt('KORTIX_AUDIT_SESSION_WINDOW_MS', 60_000);
}

/**
 * Events per session per window before delta suppression engages.
 *
 * Chosen from the real distribution measured the night of the incident: healthy
 * streaming turns produced 119-257 delta events/min, while the runaway session
 * sustained 1725/min. 900 sits ~3.5x above the busiest healthy session observed
 * and just over half the runaway rate — high enough that no normal turn can
 * reach it even allowing for several concurrent streams on one session, low
 * enough that a runaway is cut off inside its first window.
 */
export function auditRateCeiling(): number {
  return positiveEnvInt('KORTIX_AUDIT_SESSION_EVENT_CEILING', 900);
}

/**
 * Consecutive hot windows before the session is flagged in
 * `session_sandboxes.metadata` for operator/reaper attention. Three windows is
 * three full minutes of sustained over-ceiling traffic — well past any burst a
 * legitimate turn produces.
 */
export function auditRateHotWindowsBeforeFlag(): number {
  return positiveEnvInt('KORTIX_AUDIT_SESSION_HOT_WINDOWS', 3);
}

/** Hard bound on tracked sessions, so the guard's own state cannot grow without limit. */
export function auditRateMaxTrackedSessions(): number {
  return positiveEnvInt('KORTIX_AUDIT_RATE_GUARD_MAX_SESSIONS', 20_000);
}

/**
 * True only for per-token stream deltas.
 *
 * Deliberately an exact match rather than a prefix over
 * `opencode.message.part.*`: `canonicalOpenCodeAction`
 * (shared/opencode-audit-ingestion.ts:215-229) also produces
 * `opencode.message.part.<type>.updated` and `opencode.tool.updated` from
 * `message.part.updated`, and those carry state transitions worth keeping.
 * Widening this predicate widens what an incident can erase, so it stays
 * pinned to the class that was actually measured runaway.
 */
export function isSuppressibleStreamDelta(action: string | null | undefined): boolean {
  if (!action) return false;
  return action === SUPPRESSED_ACTION_CLASS || action.startsWith(`${SUPPRESSED_ACTION_CLASS}.`);
}

interface SessionWindow {
  windowStartMs: number;
  /** Events observed this window, including ones this guard dropped. */
  observed: number;
  suppressed: number;
  /** Whether this window has already crossed the ceiling. */
  hot: boolean;
  consecutiveHotWindows: number;
  lastSeenMs: number;
}

const windows = new Map<string, SessionWindow>();

function evictIfNeeded(now: number, windowMs: number): void {
  const max = auditRateMaxTrackedSessions();
  if (windows.size < max) return;

  const staleBefore = now - windowMs * 5;
  for (const [key, state] of windows) {
    if (state.lastSeenMs < staleBefore) windows.delete(key);
  }
  if (windows.size < max) return;

  // Still full: drop the least recently seen half. Losing a counter fails OPEN
  // (that session simply starts a fresh window), which is the safe direction.
  const byAge = [...windows.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
  const drop = windows.size - Math.floor(max / 2);
  for (let i = 0; i < drop && i < byAge.length; i += 1) windows.delete(byAge[i][0]);
}

function windowFor(sessionId: string, now: number, windowMs: number): SessionWindow {
  const existing = windows.get(sessionId);
  if (!existing) {
    evictIfNeeded(now, windowMs);
    const fresh: SessionWindow = {
      windowStartMs: now,
      observed: 0,
      suppressed: 0,
      hot: false,
      consecutiveHotWindows: 0,
      lastSeenMs: now,
    };
    windows.set(sessionId, fresh);
    return fresh;
  }

  const elapsed = now - existing.windowStartMs;
  if (elapsed >= windowMs) {
    // The streak counts CONSECUTIVE hot windows. It breaks when the window that
    // just closed never tripped, and also when more than one window has elapsed
    // — the windows in between saw no traffic at all, so they were not hot.
    if (!existing.hot || elapsed >= windowMs * 2) existing.consecutiveHotWindows = 0;
    existing.windowStartMs = now;
    existing.observed = 0;
    existing.suppressed = 0;
    existing.hot = false;
  }
  existing.lastSeenMs = now;
  return existing;
}

function rateLimitedNotice(args: {
  accountId: string;
  projectId: string;
  sessionId: string;
  now: number;
  windowStartMs: number;
  windowMs: number;
  ceiling: number;
  observed: number;
  consecutiveHotWindows: number;
}): AuditInsert {
  // Deterministic per (session, window): if the batch that tripped the ceiling
  // is retried by the relay, the unique index collapses it to the one row.
  const sourceRecordId = createHash('sha256')
    .update(`${args.sessionId}:${args.windowStartMs}`)
    .digest('hex');

  return {
    accountId: args.accountId,
    projectId: args.projectId,
    sessionId: args.sessionId,
    actorType: 'system',
    source: 'kortix',
    authoritativeSource: 'system',
    outcome: 'denied',
    action: SESSION_EVENT_RATE_LIMITED_ACTION,
    phase: 'completed',
    resourceType: 'session',
    resourceId: args.sessionId,
    correlationId: args.sessionId,
    sourceLedger: RATE_GUARD_SOURCE_LEDGER,
    sourceRecordId,
    sourceRevision: 'window',
    delegationDepth: 0,
    metadata: {
      event_type: SESSION_EVENT_RATE_LIMITED_ACTION,
      window_ms: args.windowMs,
      window_started_at: new Date(args.windowStartMs).toISOString(),
      ceiling: args.ceiling,
      observed_events: args.observed,
      consecutive_hot_windows: args.consecutiveHotWindows,
      suppressed_action_class: SUPPRESSED_ACTION_CLASS,
    },
    occurredAt: new Date(args.now),
  };
}

export interface RateGuardInput {
  accountId: string;
  projectId: string;
  sessionId: string;
  /** Parsed rows for this batch, in order. */
  values: AuditInsert[];
  /** Injectable clock. Tests pass this; the route does not. */
  now?: number;
}

export interface RateGuardDecision {
  /** Rows to persist. Includes the notice row when this batch tripped the ceiling. */
  values: AuditInsert[];
  /** Delta rows dropped from THIS batch. */
  suppressed: number;
  /** Whether the session's current window is over the ceiling. */
  limited: boolean;
  /** Consecutive over-ceiling windows for this session right now. */
  consecutiveHotWindows: number;
  /** The session has been hot long enough to deserve a durable marker. */
  flagForReaper: boolean;
}

/**
 * Apply the per-session ceiling to one parsed batch.
 *
 * Pure apart from the module-level counter map: no I/O, no awaits, no throws.
 */
export function applyOpenCodeAuditRateLimit(input: RateGuardInput): RateGuardDecision {
  const now = input.now ?? Date.now();
  const windowMs = auditRateWindowMs();
  const ceiling = auditRateCeiling();
  const state = windowFor(input.sessionId, now, windowMs);

  const kept: AuditInsert[] = [];
  let suppressed = 0;
  let trippedInThisBatch = false;

  for (const value of input.values) {
    // Count every event, including dropped ones: the measured quantity is the
    // session's ingest RATE. Counting only what we persist would pin the
    // counter at the ceiling and hide how far over the session really is.
    state.observed += 1;
    const overCeiling = state.observed > ceiling;

    if (overCeiling && !state.hot) {
      state.hot = true;
      state.consecutiveHotWindows += 1;
      trippedInThisBatch = true;
    }

    if (overCeiling && isSuppressibleStreamDelta(value.action)) {
      state.suppressed += 1;
      suppressed += 1;
      continue;
    }

    kept.push(value);
  }

  if (trippedInThisBatch) {
    kept.push(
      rateLimitedNotice({
        accountId: input.accountId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        now,
        windowStartMs: state.windowStartMs,
        windowMs,
        ceiling,
        observed: state.observed,
        consecutiveHotWindows: state.consecutiveHotWindows,
      }),
    );
  }

  return {
    values: kept,
    suppressed,
    limited: state.hot,
    consecutiveHotWindows: state.consecutiveHotWindows,
    flagForReaper: state.hot && state.consecutiveHotWindows >= auditRateHotWindowsBeforeFlag(),
  };
}

/** Test-only: drop all counters so cases cannot leak state into each other. */
export function __resetAuditRateGuardForTest(): void {
  windows.clear();
}

/** Test-only: how many sessions the guard currently tracks. */
export function __trackedSessionCountForTest(): number {
  return windows.size;
}
