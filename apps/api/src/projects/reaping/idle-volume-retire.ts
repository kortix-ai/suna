/**
 * Stateless sandboxes, step 2: a session whose /workspace is a Platinum volume
 * (platform/services/workspace-volume.ts) does not keep a stopped box. Once its
 * box has been stopped past KORTIX_SANDBOX_IDLE_DELETE_MINUTES, the row is
 * retired and the box removed. The next open claims the retired row
 * (`claimRetiredSandboxRow`) and boots a fresh box on the same volume; the
 * conversation comes back from the session log, which is on for every volume
 * session (projects/lib/session-sandbox-env-build.ts).
 *
 * A stop already wrote the volume's final commit (Platinum commits a mount
 * before it parks it), so removing a stopped box loses no file.
 *
 * Order: the row is retired first, in one guarded statement (still stopped,
 * same box, no wake in flight), so an open that races this lane either wakes
 * the old box before the claim or finds the retired row after it. The box is
 * removed after. A remove that fails is retried on the next pass from the
 * retired row; a wake that claims the row first leaves the old box to the
 * orphan-box reaper.
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { config } from '../../config';
import { logger } from '../../lib/logger';
import { getProvider } from '../../platform/providers';
import { RETIRED_EXTERNAL_ID_KEY } from '../../platform/services/retired-sandbox-row';
import { WORKSPACE_VOLUME_SESSION_KEY } from '../../platform/services/workspace-volume';
import { db } from '../../shared/db';
import { transitionSandbox } from '../session-lifecycle/status-transitions';
import { PROVIDER_REMOVED_KEY } from './archived-box-removal';

/** Sandbox metadata: when this lane retired the row. */
export const IDLE_RETIRED_AT_KEY = 'idleRetiredAt';

const BATCH = 50;

export async function retireIdleVolumeBoxes(now = new Date()): Promise<{ retired: number; removed: number; failed: number }> {
  const minutes = config.KORTIX_SANDBOX_IDLE_DELETE_MINUTES;
  const out = { retired: 0, removed: 0, failed: 0 };
  if (minutes < 0) return out;
  const cutoff = new Date(now.getTime() - minutes * 60_000);

  const idle = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .where(
      and(
        eq(sessionSandboxes.status, 'stopped'),
        eq(sessionSandboxes.provider, 'platinum'),
        isNotNull(sessionSandboxes.externalId),
        lt(sessionSandboxes.deadlineAt, cutoff),
        sql`${projectSessions.metadata} ? ${WORKSPACE_VOLUME_SESSION_KEY}::text`,
        sql`${projectSessions.metadata} ->> 'deletedAt' is null`,
        sql`coalesce(${sessionSandboxes.metadata} ->> 'runtimeIdentityState', '') <> 'unavailable'`,
        sql`${sessionSandboxes.metadata} ->> 'runtimeWakeId' is null`,
      ),
    )
    .limit(BATCH);

  for (const row of idle) {
    const externalId = row.externalId!;
    const retired = await transitionSandbox('retireIdle', row.sandboxId, {
      at: now,
      // The identity guard admits a null external id only with the marker naming the old one.
      columns: { externalId: null },
      metadata: { merge: { [RETIRED_EXTERNAL_ID_KEY]: externalId, [IDLE_RETIRED_AT_KEY]: now.toISOString() } },
      guard: and(
        eq(sessionSandboxes.externalId, externalId),
        sql`${sessionSandboxes.metadata} ->> 'runtimeWakeId' is null`,
      ),
    }).catch((error) => {
      logger.warn(`[idle-volume-retire] retire of ${row.sandboxId} failed`, { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!retired) continue;
    out.retired++;
  }

  // Remove every retired box whose removal is not confirmed yet, this pass's and earlier ones'.
  const pending = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.status, 'stopped'),
        isNull(sessionSandboxes.externalId),
        sql`${sessionSandboxes.metadata} ? ${IDLE_RETIRED_AT_KEY}::text`,
        sql`not (${sessionSandboxes.metadata} ? ${PROVIDER_REMOVED_KEY}::text)`,
      ),
    )
    .limit(BATCH);
  for (const row of pending) {
    const externalId = String((row.metadata as Record<string, unknown>)[RETIRED_EXTERNAL_ID_KEY] ?? '');
    if (!externalId) continue;
    try {
      const provider = getProvider('platinum');
      await provider.remove(externalId).catch(async (removeError) => {
        if ((await provider.getStatus(externalId).catch(() => 'unknown' as const)) !== 'removed') throw removeError;
      });
      await db
        .update(sessionSandboxes)
        .set({
          metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || jsonb_build_object(${PROVIDER_REMOVED_KEY}::text, ${now.toISOString()}::text)`,
        })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
      out.removed++;
    } catch (error) {
      out.failed++;
      logger.warn(`[idle-volume-retire] remove of ${externalId} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (out.retired || out.removed || out.failed) logger.info('[idle-volume-retire] pass', out);
  return out;
}
