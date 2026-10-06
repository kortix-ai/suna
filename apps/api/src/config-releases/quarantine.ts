/**
 * Quarantine across the project.
 *
 * Two tables:
 * - `kortix.config_release_failures`: a daemon reported `failed_release_id`.
 *   One row per `(project, release, session)`.
 * - `kortix.config_releases`: every release the descriptor route assigned to
 *   a daemon, with `proven_at` set the first time a daemon reports it proven.
 *   The fallback needs the release's source commit and variant to rebuild the
 *   descriptor, and only the API knows those: health reports the release ID
 *   alone. So proofs live on the assignment row, not in a table of their own.
 *
 * Rule: after failures from `PROJECT_QUARANTINE_SESSIONS` distinct sessions,
 * the project stops assigning that release and assigns the newest release of
 * the same variant that any session proved. Quarantine is per release ID, so
 * a base commit that produces a new release ID is assignable again.
 */

import { configReleaseFailures, configReleases, projectSessions } from '@kortix/db';
import { META_AGENT_NAME } from '@kortix/shared';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { bumpBounded } from '../shared/ttl-memo';
import type { DaemonConfigReport } from '../projects/lib/session-config-release';
import { noteRunningRelease } from './running-release';
import { isUuid } from '../shared/validate';

/** Distinct failing sessions that quarantine a release in a project. Spec open decision 2. */
export const PROJECT_QUARANTINE_SESSIONS = 2;

const HEX64 = /^[0-9a-f]{64}$/;

interface ProvenRelease {
  releaseId: string;
  sourceCommit: string;
}

export interface ConfigReleaseLedger {
  /** A release the descriptor route assigned. Idempotent. */
  recordAssigned(input: { projectId: string; releaseId: string; variant: string; sourceCommit: string }): Promise<void>;
  /** A daemon proved a release. Sets `proven_at` once. */
  recordProof(input: { projectId: string; releaseId: string; sessionId: string }): Promise<void>;
  /** A daemon reported a release as failed. Idempotent per session. */
  recordFailure(input: { projectId: string; releaseId: string; sessionId: string; reason: string | null }): Promise<void>;
  /** Of `releaseIds`, the ones that failed in `threshold` or more distinct sessions. */
  quarantined(projectId: string, releaseIds: string[], threshold: number): Promise<Set<string>>;
  /** The newest proven release of `variant`, skipping quarantined ones. */
  lastProven(projectId: string, variant: string, threshold: number): Promise<ProvenRelease | null>;
}

/**
 * A failure the meta coordinator reported does not count. Until 2026-10-02 its
 * box was assigned the `project` release, which it cannot load (the meta image
 * has no `bun`), and two such sessions quarantined a release that every other
 * session of the project loads. Those rows stay in the table.
 */
export const notFromMetaSession = sql`not exists (
  select 1 from ${projectSessions}
  where ${projectSessions.sessionId} = ${qualifiedColumn(configReleaseFailures.sessionId)}::text
    and ${projectSessions.agentName} = ${META_AGENT_NAME}
)`;

export const dbConfigReleaseLedger: ConfigReleaseLedger = {
  async recordAssigned(input) {
    await db
      .insert(configReleases)
      .values({
        projectId: input.projectId,
        releaseId: input.releaseId,
        variant: input.variant,
        sourceCommit: input.sourceCommit,
      })
      .onConflictDoNothing();
  },
  async recordProof(input) {
    await db
      .update(configReleases)
      .set({ provenAt: new Date(), provenSessionId: input.sessionId })
      .where(
        and(
          eq(configReleases.projectId, input.projectId),
          eq(configReleases.releaseId, input.releaseId),
          isNull(configReleases.provenAt),
        ),
      );
  },
  async recordFailure(input) {
    await db
      .insert(configReleaseFailures)
      .values({
        projectId: input.projectId,
        releaseId: input.releaseId,
        sessionId: input.sessionId,
        reason: input.reason?.slice(0, 2_000) ?? null,
      })
      .onConflictDoNothing();
  },
  async quarantined(projectId, releaseIds, threshold) {
    if (releaseIds.length === 0) return new Set();
    const rows = await db
      .select({ releaseId: configReleaseFailures.releaseId })
      .from(configReleaseFailures)
      .where(
        and(
          eq(configReleaseFailures.projectId, projectId),
          inArray(configReleaseFailures.releaseId, releaseIds),
          notFromMetaSession,
        ),
      )
      .groupBy(configReleaseFailures.releaseId)
      .having(sql`count(distinct ${configReleaseFailures.sessionId}) >= ${threshold}`);
    return new Set(rows.map((row) => row.releaseId));
  },
  async lastProven(projectId, variant, threshold) {
    const quarantinedIds = db
      .select({ releaseId: configReleaseFailures.releaseId })
      .from(configReleaseFailures)
      .where(and(eq(configReleaseFailures.projectId, projectId), notFromMetaSession))
      .groupBy(configReleaseFailures.releaseId)
      .having(sql`count(distinct ${configReleaseFailures.sessionId}) >= ${threshold}`);
    const [row] = await db
      .select({ releaseId: configReleases.releaseId, sourceCommit: configReleases.sourceCommit })
      .from(configReleases)
      .where(
        and(
          eq(configReleases.projectId, projectId),
          eq(configReleases.variant, variant),
          isNotNull(configReleases.provenAt),
          notInArray(configReleases.releaseId, quarantinedIds),
        ),
      )
      .orderBy(desc(configReleases.createdAt))
      .limit(1);
    return row ?? null;
  },
};

/**
 * Suppresses repeated writes of the same fact. `GET /config` is polled; a
 * failure or a proof reported on every poll is written once per 10 minutes
 * per API process. The writes are idempotent, so a second process writing
 * the same fact is harmless.
 */
const RECENT_TTL_MS = 10 * 60_000;
const MAX_RECENT = 10_000;
const recent = new Map<string, number>();

function firstTimeRecently(key: string, now = Date.now()): boolean {
  const at = recent.get(key);
  if (at !== undefined && now - at < RECENT_TTL_MS) return false;
  bumpBounded(recent, key, now, MAX_RECENT);
  return true;
}

export function __clearQuarantineMemoForTests(): void {
  recent.clear();
}

/**
 * Record what a daemon reported: `failed_release_id` as a failure, and a
 * proven release as a proof. A proof needs a running release ID: a box that
 * fell to the image default reports none, and proves nothing.
 *
 * Never throws: every caller is a read or a reload that must not fail on
 * bookkeeping.
 */
export async function recordDaemonConfigReport(
  input: { projectId: string; sessionId: string; report: DaemonConfigReport | null },
  ledger: ConfigReleaseLedger = dbConfigReleaseLedger,
): Promise<void> {
  const { projectId, sessionId, report } = input;
  if (!report || !isUuid(projectId) || !isUuid(sessionId)) return;
  // The ONE place a daemon's own report reaches the API — a health read, a
  // reload, or a convergence answer. The turn-start gate reads this to decide
  // whether a prompt must wait for a convergence (turn-start-convergence.ts).
  noteRunningRelease(sessionId, report.release_id);
  try {
    const failed = report.failed_release_id;
    if (failed && HEX64.test(failed) && firstTimeRecently(`f\0${projectId}\0${failed}\0${sessionId}`)) {
      await ledger.recordFailure({ projectId, releaseId: failed, sessionId, reason: report.fallback_reason });
    }
    const proven = report.release_id;
    if (
      report.proven &&
      proven &&
      HEX64.test(proven) &&
      proven !== failed &&
      firstTimeRecently(`p\0${projectId}\0${proven}`)
    ) {
      await ledger.recordProof({ projectId, releaseId: proven, sessionId });
    }
  } catch (error) {
    logger.warn('[config-releases] recording a daemon config report failed', {
      project_id: projectId,
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
