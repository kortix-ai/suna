/**
 * Stopping ONE box, isolated from the pass that decides which boxes to stop.
 *
 * This file used to be `running-box.ts` and it used to make the decision too:
 * probe the box's own opencode daemon, treat 'busy' as a veto, arm an idle
 * countdown in metadata, and fall back to an activity clock the box itself
 * stamped. All of that is gone. A wedged daemon answers 'busy' forever, so the
 * veto was unbounded and the countdown never once armed in production. The
 * decision now lives in one comparison in box-reaper.ts (`deadline_at <= now`)
 * and this module only carries it out.
 */

import { getProvider } from '../../platform/providers';
import { type ReapCandidate, reloadDeadlineAt } from './box-queries';
import { isAlreadyNotRunning, isLifecycleTransitionInProgress } from './policy';
import { applyStoppedState } from './sandbox-state-sync';

export type StopBoxOutcome = 'stopped' | 'skipped' | 'errors';

/** The only fields a stop needs. Narrower than ReapCandidate so a request-path
 *  caller (the run-cap park below) can hand over the row it already has. */
export type StoppableBox = Pick<
  ReapCandidate,
  'sandboxId' | 'sessionId' | 'externalId' | 'provider'
>;

export async function stopExpiredBox(row: StoppableBox, now: Date): Promise<StopBoxOutcome> {
  // LAST-MOMENT RE-CHECK. `row.deadlineAt` came from the batch snapshot, taken
  // BEFORE this row's multi-second `getStatus` round-trip. A prompt (or a human
  // clicking the preview, or a gateway LLM call) that landed inside that window
  // has already extended the box, and stopping it here would kill live work the
  // control plane had just agreed to keep. Compare against a FRESH clock too —
  // the pass's `now` is as stale as its snapshot.
  const deadlineAt = await reloadDeadlineAt(row.sandboxId);
  if (!deadlineAt || deadlineAt.getTime() > Date.now()) return 'skipped';

  try {
    await getProvider(row.provider).stop(row.externalId);
  } catch (err) {
    if (isLifecycleTransitionInProgress(err)) return 'skipped';
    if (!isAlreadyNotRunning(err)) {
      console.error(
        `[reaper] provider.stop failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`,
      );
      return 'errors';
    }
    // Already stopped/gone on the provider side is success — reconcile.
  }
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId: row.externalId,
    now,
  });
  return 'stopped';
}

/**
 * Park a box that has burned its ENTIRE 24-hour stretch, from the request path
 * that just refused its prompt.
 *
 * Without this the refusal is only correct, not useful: the box sits at the cap
 * with an expired deadline until the next maintenance pass (5 minutes), and every
 * retry in between is refused for the same reason. Parking it here means the very
 * next prompt finds a stopped row, auto-resumes it, and the DB trigger anchors a
 * fresh stretch — which is the recovery the cap was always documented to have.
 *
 * Best-effort by construction: if it fails, the reaper does exactly this within
 * one pass. `stopExpiredBox` re-reads the deadline first, so this cannot park a
 * box whose grant a concurrent turn has meanwhile revived.
 */
export async function parkBoxAtRunCap(row: StoppableBox): Promise<void> {
  const outcome = await stopExpiredBox(row, new Date()).catch((err) => {
    console.warn(
      `[deadline] run-cap park failed for sandbox ${row.sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
    return 'errors' as StopBoxOutcome;
  });
  if (outcome === 'stopped') {
    console.log(`[deadline] parked sandbox ${row.sandboxId} at its 24h run cap`);
  }
}
