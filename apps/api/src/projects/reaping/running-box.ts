/**
 * The rule for ONE running box, isolated from the pass that feeds it rows.
 */

import { eq } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { getProvider } from '../../platform/providers';
import { probeSandboxBusy } from '../sandbox-busy-probe';
import type { ReapCandidate } from './box-queries';
import {
  decideIdleConfirm,
  idleObservedAtOf,
  isAlreadyNotRunning,
  isLifecycleTransitionInProgress,
} from './policy';
import { applyStoppedState, mergeMetadata } from './sandbox-state-sync';

export type RunningBoxOutcome = 'stopped' | 'busyVetoed' | 'idleArmed' | 'skipped' | 'errors';

/**
 * busy → alive; observed idle for the TTL → shut down; unreachable →
 * activity-clock fallback so a wedged daemon still stops.
 * `fallbackLastMeaningful` is null when this pass's usage lookup failed — then
 * an unreachable box cannot be judged at all and is skipped (never act on
 * uncertainty).
 *
 * `bypassBusyProbe` skips the busy check entirely and goes straight to the
 * stop. Set for exactly two cases: the orphan-account sweep (the account that
 * owns the box no longer exists, so there is no customer whose in-flight turn a
 * busy-probe veto would be protecting), and the ABSOLUTE ceiling
 * (`decideHardStop`) — a box with no proven activity for the ceiling is not in
 * use, and letting its own daemon veto that forever is the 24/7 bug itself.
 */
export async function reapRunningBox(
  row: ReapCandidate,
  opts: { now: Date; ttlMs: number; fallbackLastMeaningful: Date | null; bypassBusyProbe?: boolean },
): Promise<RunningBoxOutcome> {
  const { now, ttlMs, fallbackLastMeaningful, bypassBusyProbe } = opts;

  if (!bypassBusyProbe) {
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
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId: row.externalId,
    quiesce: true,
    now,
  });
  return 'stopped';
}
