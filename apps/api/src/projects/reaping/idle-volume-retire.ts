/**
 * Stateless sandboxes: a session whose /workspace is a Platinum volume
 * (platform/services/workspace-volume.ts) does not keep a stopped box. Once its
 * box has been stopped (`metadata.stoppedAt`) longer than
 * KORTIX_SANDBOX_IDLE_DELETE_MINUTES, the row is retired and the box removed.
 * The next open claims the retired row (`claimRetiredSandboxRow`) and boots a
 * fresh box on the same volume; the conversation comes back from the session
 * log, which every volume session restores (projects/lib/session-sandbox-env-build.ts).
 *
 * A stop writes the volume's final commit (Platinum commits a mount when its
 * box stops), but that commit can fail: on 2026-10-27 a Platinum stop could
 * not save a mount too large to index. So a box goes only when Platinum's
 * volume health is `ok` (`workspaceVolumeHoldReason`). Otherwise the box
 * stays, the row is stamped `idleDeleteHeldAt` with the reason, and the lane
 * asks again after HOLD_RECHECK_MINUTES.
 *
 * Order: the row is retired first, in one guarded statement (still stopped,
 * same box, no wake in flight), so an open that races this lane either wakes
 * the old box before the retire or finds the retired row after it. The box is
 * removed right after. An open never claims a retired row whose box is not
 * confirmed removed: it removes the box itself first (`idleRetiredBoxRemoved`),
 * so two boxes never mount the volume and no stopped box outlives its row. A
 * removal that fails is retried by the next pass and by the next open.
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { config } from '../../config';
import { logger } from '../../lib/logger';
import { getProvider } from '../../platform/providers';
import { RETIRED_EXTERNAL_ID_KEY } from '../../platform/services/retired-sandbox-row';
import { WORKSPACE_VOLUME_SESSION_KEY, workspaceVolumeHoldReason } from '../../platform/services/workspace-volume';
import { db } from '../../shared/db';
import { transitionSandbox } from '../session-lifecycle/status-transitions';
import { PROVIDER_REMOVED_KEY } from './archived-box-removal';

/** Sandbox metadata: when this lane retired the row. */
export const IDLE_RETIRED_AT_KEY = 'idleRetiredAt';
/** Sandbox metadata: when this lane last kept the box because its volume was not `ok`, and why. */
const IDLE_DELETE_HELD_AT_KEY = 'idleDeleteHeldAt';
const IDLE_DELETE_HELD_REASON_KEY = 'idleDeleteHeldReason';

const BATCH = 50;
/** A held box is checked again after this long, so held rows never fill the batch. */
const HOLD_RECHECK_MINUTES = 60;

export async function retireIdleVolumeBoxes(
  now = new Date(),
): Promise<{ retired: number; removed: number; failed: number; held: number }> {
  const out = { retired: 0, removed: 0, failed: 0, held: 0 };
  const minutes = config.KORTIX_SANDBOX_IDLE_DELETE_MINUTES;
  if (minutes < 0) return out;
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const recheck = new Date(now.getTime() - HOLD_RECHECK_MINUTES * 60_000);

  // Earlier passes' removals that failed. Any status: the session may have been deleted since.
  const pending = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(and(isNull(sessionSandboxes.externalId), unremovedIdleRetire))
    .limit(BATCH);
  for (const row of pending) {
    const externalId = (row.metadata as Record<string, unknown>)[RETIRED_EXTERNAL_ID_KEY];
    if (typeof externalId !== 'string' || !externalId) continue;
    if (await removeRetiredBox(row.sandboxId, externalId, now)) out.removed++;
    else out.failed++;
  }

  const idle = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      sessionId: projectSessions.sessionId,
      sessionMetadata: projectSessions.metadata,
    })
    .from(sessionSandboxes)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .where(
      and(
        eq(sessionSandboxes.status, 'stopped'),
        eq(sessionSandboxes.provider, 'platinum'),
        isNotNull(sessionSandboxes.externalId),
        // The stop's own time (applyStoppedState), not the deadline: a manual Stop leaves the deadline ahead.
        sql`(${sessionSandboxes.metadata} ->> 'stoppedAt')::timestamptz < ${cutoff.toISOString()}::timestamptz`,
        sql`${projectSessions.metadata} ? ${WORKSPACE_VOLUME_SESSION_KEY}::text`,
        sql`${projectSessions.metadata} ->> 'deletedAt' is null`,
        // A lost box is the recovery flow's (recover-lost-session.ts).
        sql`coalesce(${sessionSandboxes.metadata} ->> 'runtimeIdentityState', '') <> 'unavailable'`,
        sql`${sessionSandboxes.metadata} ->> 'runtimeWakeId' is null`,
        sql`coalesce((${sessionSandboxes.metadata} ->> ${IDLE_DELETE_HELD_AT_KEY}::text)::timestamptz, '-infinity'::timestamptz) < ${recheck.toISOString()}::timestamptz`,
      ),
    )
    .limit(BATCH);

  for (const row of idle) {
    const externalId = row.externalId!;
    const hold = await workspaceVolumeHoldReason(row.sessionId, row.sessionMetadata);
    if (hold) {
      out.held++;
      await holdIdleBox(row.sandboxId, externalId, hold, now);
      continue;
    }
    const retired = await transitionSandbox('retireIdle', row.sandboxId, {
      at: now,
      // The identity guard admits a null external id only with the marker naming the old one.
      columns: { externalId: null },
      metadata: { merge: { [RETIRED_EXTERNAL_ID_KEY]: externalId, [IDLE_RETIRED_AT_KEY]: now.toISOString() } },
      guard: and(eq(sessionSandboxes.externalId, externalId), sql`${sessionSandboxes.metadata} ->> 'runtimeWakeId' is null`),
    }).catch((error) => {
      logger.warn(`[idle-volume-retire] retire of ${row.sandboxId} failed`, { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!retired) continue;
    out.retired++;
    if (await removeRetiredBox(row.sandboxId, externalId, now)) out.removed++;
    else out.failed++;
  }

  if (out.retired || out.removed || out.failed || out.held) logger.info('[idle-volume-retire] pass', out);
  return out;
}

/** Keep the box and stamp the row, so the next check waits HOLD_RECHECK_MINUTES. Never throws. */
async function holdIdleBox(sandboxId: string, externalId: string, reason: string, now: Date): Promise<void> {
  logger.warn(`[idle-volume-retire] kept the box of ${sandboxId}: its volume may hold unsaved writes`, { sandboxId, externalId, reason });
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || jsonb_build_object(${IDLE_DELETE_HELD_AT_KEY}::text, ${now.toISOString()}::text, ${IDLE_DELETE_HELD_REASON_KEY}::text, ${reason}::text)`,
    })
    .where(and(eq(sessionSandboxes.sandboxId, sandboxId), eq(sessionSandboxes.externalId, externalId)))
    .catch((error) => {
      logger.warn(`[idle-volume-retire] hold stamp of ${sandboxId} failed`, { error: error instanceof Error ? error.message : String(error) });
    });
}

const unremovedIdleRetire = sql`(${sessionSandboxes.metadata} ? ${IDLE_RETIRED_AT_KEY}::text and not (${sessionSandboxes.metadata} ? ${PROVIDER_REMOVED_KEY}::text))`;

/** Remove the box a retired row gave up and stamp the row. A box already gone counts as removed. Never throws. */
async function removeRetiredBox(sandboxId: string, externalId: string, now: Date): Promise<boolean> {
  try {
    const provider = getProvider('platinum');
    await provider.remove(externalId).catch(async (removeError) => {
      if ((await provider.getStatus(externalId).catch(() => 'unknown' as const)) !== 'removed') throw removeError;
    });
    // Only the retired row: a wake may already have replaced it with a fresh one.
    await db
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || jsonb_build_object(${PROVIDER_REMOVED_KEY}::text, ${now.toISOString()}::text)`,
      })
      .where(and(eq(sessionSandboxes.sandboxId, sandboxId), isNull(sessionSandboxes.externalId), unremovedIdleRetire));
    return true;
  } catch (error) {
    logger.warn(`[idle-volume-retire] remove of ${externalId} failed`, { sandboxId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * True when a retired row's box is gone, so a fresh box may mount the volume:
 * the row is not an idle retire, its removal is confirmed, or it is removed now.
 */
export async function idleRetiredBoxRemoved(row: { sandboxId: string; metadata: unknown }): Promise<boolean> {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (metadata[IDLE_RETIRED_AT_KEY] == null || metadata[PROVIDER_REMOVED_KEY] != null) return true;
  const externalId = metadata[RETIRED_EXTERNAL_ID_KEY];
  return typeof externalId === 'string' && !!externalId && (await removeRetiredBox(row.sandboxId, externalId, new Date()));
}
