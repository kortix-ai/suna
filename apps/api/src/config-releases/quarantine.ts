/**
 * Quarantine across the project (docs/specs/config-releases.md, "Quarantine
 * across the project").
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

import { configReleaseFailures, configReleases } from '@kortix/db';
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import type { DaemonConfigReport } from '../projects/lib/session-config-release';

/** Distinct failing sessions that quarantine a release in a project. Spec open decision 2. */
export const PROJECT_QUARANTINE_SESSIONS = 2;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProvenRelease {
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
      .where(and(eq(configReleaseFailures.projectId, projectId), inArray(configReleaseFailures.releaseId, releaseIds)))
      .groupBy(configReleaseFailures.releaseId)
      .having(sql`count(distinct ${configReleaseFailures.sessionId}) >= ${threshold}`);
    return new Set(rows.map((row) => row.releaseId));
  },
  async lastProven(projectId, variant, threshold) {
    const quarantinedIds = db
      .select({ releaseId: configReleaseFailures.releaseId })
      .from(configReleaseFailures)
      .where(eq(configReleaseFailures.projectId, projectId))
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

/** An in-memory ledger for tests. Same semantics as the DB one. */
export class MemoryConfigReleaseLedger implements ConfigReleaseLedger {
  assigned: Array<{ projectId: string; releaseId: string; variant: string; sourceCommit: string; order: number; provenAt: number | null }> = [];
  failures: Array<{ projectId: string; releaseId: string; sessionId: string; reason: string | null }> = [];
  private clock = 0;

  async recordAssigned(input: { projectId: string; releaseId: string; variant: string; sourceCommit: string }) {
    const exists = this.assigned.some(
      (row) => row.projectId === input.projectId && row.releaseId === input.releaseId && row.variant === input.variant,
    );
    if (!exists) this.assigned.push({ ...input, order: ++this.clock, provenAt: null });
  }
  async recordProof(input: { projectId: string; releaseId: string; sessionId: string }) {
    for (const row of this.assigned) {
      if (row.projectId === input.projectId && row.releaseId === input.releaseId && row.provenAt === null) {
        row.provenAt = ++this.clock;
      }
    }
  }
  async recordFailure(input: { projectId: string; releaseId: string; sessionId: string; reason: string | null }) {
    const exists = this.failures.some(
      (row) => row.projectId === input.projectId && row.releaseId === input.releaseId && row.sessionId === input.sessionId,
    );
    if (!exists) this.failures.push(input);
  }
  private failingSessions(projectId: string, releaseId: string): number {
    return new Set(
      this.failures.filter((row) => row.projectId === projectId && row.releaseId === releaseId).map((row) => row.sessionId),
    ).size;
  }
  async quarantined(projectId: string, releaseIds: string[], threshold: number) {
    return new Set(releaseIds.filter((id) => this.failingSessions(projectId, id) >= threshold));
  }
  async lastProven(projectId: string, variant: string, threshold: number) {
    const rows = this.assigned
      .filter(
        (row) =>
          row.projectId === projectId &&
          row.variant === variant &&
          row.provenAt !== null &&
          this.failingSessions(projectId, row.releaseId) < threshold,
      )
      .sort((a, b) => b.order - a.order);
    return rows[0] ? { releaseId: rows[0].releaseId, sourceCommit: rows[0].sourceCommit } : null;
  }
}

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
  recent.delete(key);
  recent.set(key, now);
  while (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value as string);
  return true;
}

export function __clearQuarantineMemoForTests(): void {
  recent.clear();
}

/**
 * Record what a daemon reported: `failed_release_id` as a failure, and a
 * proven release as a proof. A proof counts only when the box served that
 * release (source `release` or `image-default`); in `workspace` source the
 * session's own files ran, which proves nothing about the release.
 *
 * Never throws: every caller is a read or a reload that must not fail on
 * bookkeeping.
 */
export async function recordDaemonConfigReport(
  input: { projectId: string; sessionId: string; report: DaemonConfigReport | null },
  ledger: ConfigReleaseLedger = dbConfigReleaseLedger,
): Promise<void> {
  const { projectId, sessionId, report } = input;
  if (!report || !UUID.test(projectId) || !UUID.test(sessionId)) return;
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
      report.source !== 'workspace' &&
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
