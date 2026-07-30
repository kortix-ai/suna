/**
 * Prompt-delivery backstop: session_lifecycle_commands normally drain on the
 * scheduler's 60s tick (startProjectTriggerScheduler). A command still `queued`
 * TEN MINUTES past its available_at means that drain is starved — leader dead,
 * scheduler disabled, or the tick wedged — and every prompt behind it (trigger
 * fires, approval resumes) is sitting undelivered while its session shows
 * "queued — agent picking up" forever. This pass executes those stale rows
 * through the SAME claim/retry/dead-letter machinery the drain uses
 * (claimDueLifecycleCommands re-checks status='queued' in the claim UPDATE, so
 * racing a recovered scheduler is safe), and ships a real error so a dead
 * scheduler pages instead of silently eating prompts. Bounded batch; no-op in
 * steady state.
 *
 * It lives beside the queue it drains rather than in the sandbox reaper: it has
 * nothing to do with sandboxes or billing, and the only reason it ever sat there
 * was the cron schedule it shares. Being here also means the engine can be a
 * plain static import — as the reaper it needed a dynamic one purely to dodge
 * the resulting cycle.
 */

import { logger } from '../../lib/logger';
import { drainSessionLifecycleQueue } from './engine';

const UNDELIVERED_PROMPT_STARVATION_MS = 10 * 60_000;
const UNDELIVERED_PROMPT_BATCH = 25;

export async function reconcileUndeliveredPrompts(
  now = new Date(),
): Promise<{ claimed: number; succeeded: number; failed: number; queued: number }> {
  const result = await drainSessionLifecycleQueue({
    workerId: `undelivered-prompt-reconciler:${process.pid}`,
    limit: UNDELIVERED_PROMPT_BATCH,
    availableBefore: new Date(now.getTime() - UNDELIVERED_PROMPT_STARVATION_MS),
  });
  if (result.claimed > 0) {
    logger.error(
      '[reaper] queued lifecycle commands starved past the drain window — scheduler dead or disabled?',
      {
        claimed: result.claimed,
        succeeded: result.succeeded,
        failed: result.failed,
        requeued: result.queued,
        starvation_ms: UNDELIVERED_PROMPT_STARVATION_MS,
      },
    );
  }
  return result;
}
