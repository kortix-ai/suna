/**
 * BOUNDED SANDBOX LIFETIME — the two queries shadow mode reads.
 *
 * Split from the pass itself so the pass reads as a decision and each query's
 * contract is stated once, next to the SQL — the same shape `reaping/` uses.
 *
 * NOTE ON THE KILL QUERY: it is the EXACT query enforcement will run. Shadow
 * mode that measures a different set than the one that will act is worse than
 * no shadow mode, because it produces confidence rather than evidence.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export interface DeadlineCandidate {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  projectId: string;
  provider: string;
  externalId: string;
  status: string;
  activeSince: Date;
  deadlineAt: Date;
  overdueMs: number;
  ageHours: number;
  /** metadata.source — 154 trigger:cron vs 41 ui in prod. NOT sessions.origin,
   *  which disagrees badly (26 schedule vs 170 user) and would misclassify. */
  source: string | null;
  harness: string | null;
  transport: string | null;
  /** 'live' | 'backfilled', stamped by the backfill migration. */
  cohort: string | null;
  /** Null means NEVER — which for a BYOK box is normal, not evidence of death. */
  lastUsageAgeMs: number | null;
  lastAcpRelayAgeMs: number | null;
  perAccountRank: number;
}

/**
 * THE KILL QUERY.
 *
 * No probe. No lease. No `unknown` branch. No two-phase countdown. An expired
 * deadline is not an INFERENCE about idleness — it is arithmetic — so the
 * "never act on uncertainty" rule that governs the probe-based reaper does not
 * apply. That rule exists to stop us GUESSING a box is idle.
 *
 * `provisioning` is a candidate because a row parked there WITH an external_id
 * is invisible to every existing killer: the reaper filters status='active',
 * staleProvisioningReason bails on exactly that shape, and
 * reconcileStuckActiveSessions only touches project_sessions. A VM is running,
 * billing may be paused, and nothing sees it. POST /sessions/:id/restart
 * produces that shape and can park there if an API instance rolls mid-poll.
 *
 * The per-account rank is not cosmetic. `ORDER BY deadline_at ASC` alone, over
 * a population where ONE account holds 117 of 187 boxes with the oldest ages,
 * returns that account's fleet exhaustively before any other's — 117 sandboxes
 * inside ~25 minutes, which defeats the pacing entirely.
 */
export async function selectExpiredDeadlineCandidates(opts: {
  perAccountCap: number;
  limit: number;
}): Promise<DeadlineCandidate[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH candidates AS (
      SELECT s.sandbox_id, s.session_id, s.account_id, s.project_id, s.provider,
             s.external_id, s.status, s.active_since, s.deadline_at, s.metadata,
             ps.metadata AS session_metadata,
             ROW_NUMBER() OVER (PARTITION BY s.account_id ORDER BY s.deadline_at ASC)
               AS per_account_rank
        FROM kortix.session_sandboxes s
        LEFT JOIN kortix.project_sessions ps ON ps.session_id = s.session_id
       WHERE s.status IN ('active', 'provisioning')
         AND s.external_id IS NOT NULL
         AND s.deadline_at <= now()
    )
    SELECT c.*,
           EXTRACT(EPOCH FROM (now() - c.deadline_at)) * 1000 AS overdue_ms,
           EXTRACT(EPOCH FROM (now() - c.active_since)) / 3600 AS age_hours,
           (SELECT EXTRACT(EPOCH FROM (now() - max(u.created_at))) * 1000
              FROM kortix.usage_events u
             WHERE u.session_id = c.session_id
               AND u.created_at > now() - interval '30 days') AS last_usage_age_ms,
           (SELECT EXTRACT(EPOCH FROM (now() - max(e.created_at))) * 1000
              FROM kortix.acp_session_envelopes e
             WHERE e.session_id = c.session_id
               AND e.created_at > now() - interval '30 days') AS last_acp_relay_age_ms
      FROM candidates c
     WHERE c.per_account_rank <= ${opts.perAccountCap}
     ORDER BY c.deadline_at ASC
     LIMIT ${opts.limit}
  `);
  return [...rows].map(toCandidate);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toCandidate(row: Record<string, unknown>): DeadlineCandidate {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const sessionMetadata = (row.session_metadata ?? {}) as Record<string, unknown>;
  return {
    sandboxId: String(row.sandbox_id),
    sessionId: String(row.session_id),
    accountId: String(row.account_id),
    projectId: String(row.project_id),
    provider: String(row.provider),
    externalId: String(row.external_id),
    status: String(row.status),
    activeSince: new Date(String(row.active_since)),
    deadlineAt: new Date(String(row.deadline_at)),
    overdueMs: num(row.overdue_ms) ?? 0,
    ageHours: num(row.age_hours) ?? 0,
    source: str(metadata.source),
    harness: str(sessionMetadata.runtime_harness),
    transport: str(sessionMetadata.runtime_transport),
    cohort: str(metadata.deadlineCohort),
    lastUsageAgeMs: num(row.last_usage_age_ms),
    lastAcpRelayAgeMs: num(row.last_acp_relay_age_ms),
    perAccountRank: num(row.per_account_rank) ?? 0,
  };
}

export interface DivergentStop {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: string;
  deadlineAt: Date;
  remainingMs: number;
  stoppedAt: Date;
  source: string | null;
  cohort: string | null;
}

/**
 * THE OTHER HALF OF THE COMPARISON, and the one a naive shadow implementation
 * omits: boxes the OLD model just stopped whose deadline is still in the
 * FUTURE.
 *
 * A shadow report that only counts "the new model would kill more" answers
 * whether the new rules are aggressive enough. It says nothing about whether
 * they are TOO LENIENT — and this design deletes the probe, the lease, the idle
 * countdown and the hard-stop ceiling, so every one of those is a killer the
 * new model gives up. If this count is persistently non-zero, the deadline
 * model is leaving boxes running that the old one stopped, and that must be
 * understood before enforcement, not after.
 *
 * Keyed on `idleQuiescedAt`, which `applyStoppedState` stamps for every
 * quiesced stop (reaper idle stop, provider-confirmed reconcile, webhook).
 */
export async function selectDivergentOldModelStops(sinceMs: number): Promise<DivergentStop[]> {
  const seconds = Math.round(sinceMs / 1000);
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT s.sandbox_id, s.session_id, s.account_id, s.provider, s.deadline_at, s.metadata,
           (s.metadata->>'idleQuiescedAt')::timestamptz AS stopped_at,
           EXTRACT(EPOCH FROM (s.deadline_at - now())) * 1000 AS remaining_ms
      FROM kortix.session_sandboxes s
     WHERE s.status = 'stopped'
       AND s.metadata->>'idleQuiescedAt' IS NOT NULL
       AND (s.metadata->>'idleQuiescedAt')::timestamptz > now() - make_interval(secs => ${seconds})
       AND s.deadline_at > now()
     ORDER BY stopped_at DESC
     LIMIT 200
  `);
  return [...rows].map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      sandboxId: String(row.sandbox_id),
      sessionId: String(row.session_id),
      accountId: String(row.account_id),
      provider: String(row.provider),
      deadlineAt: new Date(String(row.deadline_at)),
      remainingMs: num(row.remaining_ms) ?? 0,
      stoppedAt: new Date(String(row.stopped_at)),
      source: str(metadata.source),
      cohort: str(metadata.deadlineCohort),
    };
  });
}
