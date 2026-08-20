/**
 * Durable marker for a session whose audit-event ingest rate stays over the
 * ceiling for several consecutive windows.
 *
 * The rate guard itself (shared/opencode-audit-rate-guard.ts) is per-process and
 * in-memory, which is right for the hot path but invisible the moment the task
 * restarts. This writes the condition into `session_sandboxes.metadata` so it
 * survives a restart, is queryable during an incident, and gives the 5-minute
 * project-maintenance sweep (projects/maintenance.ts:214 `runProjectMaintenance`)
 * a signal it can act on later.
 *
 * DELIBERATELY A FLAG, NOT AN ACTION. This does not stop, park, or shorten the
 * deadline of the session. Suppressing the delta class already removes the
 * database pressure that caused the incident; automatically killing a live user
 * session on a volume heuristic is a much larger product decision with its own
 * failure mode (a legitimate long streaming turn being parked mid-flight) and
 * belongs in its own change. The marker is what a future reaper rule — or a
 * human — reads.
 */

import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../shared/db';
import { mergeMetadata } from '../reaping/sandbox-state-sync';

/** Metadata key the marker is written under. */
export const AUDIT_RATE_LIMIT_METADATA_KEY = 'auditEventRateLimit';

export interface AuditRateFlagInput {
  accountId: string;
  projectId: string;
  sessionId: string;
  consecutiveHotWindows: number;
  now?: Date;
}

/**
 * Best-effort. Never throws and never rejects: the caller invokes this without
 * awaiting, from the audit ingest hot path.
 */
export async function flagSessionAuditRateLimited(input: AuditRateFlagInput): Promise<void> {
  const at = input.now ?? new Date();
  try {
    await db
      .update(sessionSandboxes)
      // `updatedAt` is deliberately NOT touched. Sandbox lifecycle and idle
      // detection read that column; a marker write must not look like session
      // activity.
      .set({
        metadata: mergeMetadata({
          [AUDIT_RATE_LIMIT_METADATA_KEY]: {
            consecutiveHotWindows: input.consecutiveHotWindows,
            at: at.toISOString(),
          },
        }),
      })
      .where(
        and(
          eq(sessionSandboxes.accountId, input.accountId),
          eq(sessionSandboxes.projectId, input.projectId),
          eq(sessionSandboxes.sessionId, input.sessionId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ),
      );
  } catch {
    // Swallow: a marker that fails to write must not surface as a 500 on an
    // audit ingest request, and must not turn an unhandled rejection loose.
  }
}

/** Reads the marker off a metadata blob. Returns null when absent or malformed. */
export function readAuditRateLimitFlag(
  metadata: Record<string, unknown> | null | undefined,
): { consecutiveHotWindows: number; at: string } | null {
  const raw = metadata?.[AUDIT_RATE_LIMIT_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const hot = record.consecutiveHotWindows;
  const at = record.at;
  if (typeof hot !== 'number' || !Number.isFinite(hot) || typeof at !== 'string') return null;
  return { consecutiveHotWindows: hot, at };
}
