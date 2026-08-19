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
import { DEDUPE_TTL_MS } from '../../sandbox-proxy/prompt-dedupe';
import { drainSessionLifecycleQueue } from './engine';

// F3: derived from `prompt-dedupe.ts`'s `DEDUPE_TTL_MS`, not independently
// hardcoded. The no-blind-repost guarantee documented on
// `executeQueuedContinue` (engine.ts) requires this starvation window to
// never exceed the dedupe cache's TTL — a starved row swept and re-drained
// AFTER its delivery claim already expired would re-POST blind, with no
// cache entry left to catch the duplicate. Importing the same constant makes
// that relation hold structurally instead of by two files' comments staying
// in sync by hand.
// Exported (constant only — see F3) so the relation to `DEDUPE_TTL_MS` can be
// pinned directly in a test instead of only exercised indirectly through
// `reconcileUndeliveredPrompts`'s computed sweep cutoff.
export const UNDELIVERED_PROMPT_STARVATION_MS = DEDUPE_TTL_MS;
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
