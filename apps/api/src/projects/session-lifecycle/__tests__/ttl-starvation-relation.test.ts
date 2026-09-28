// F3 — the no-blind-repost guarantee documented on `executeQueuedContinue`
// (queued-continue.ts) depends on one cross-module relation:
//
//   DEDUPE_TTL_MS (sandbox-proxy/prompt-dedupe.ts) >=
//   UNDELIVERED_PROMPT_STARVATION_MS (session-lifecycle/undelivered-prompts.ts)
//
// A row the starvation reconciler sweeps and re-drains (re-POSTing the SAME
// body through `postPrompt`) is only safe to re-post blind if its ORIGINAL
// delivery attempt's dedupe claim is still held in `prompt-dedupe.ts`'s
// cache — otherwise the re-post is un-deduped and can double-deliver.
//
// Before F3 both constants were independently hardcoded `10 * 60_000`, so
// the relation held only because two file comments happened to agree — an
// edit to either number alone would silently reopen the blind-repost window
// with nothing to catch it. `undelivered-prompts.ts`'s
// `UNDELIVERED_PROMPT_STARVATION_MS` now imports and derives directly from
// `DEDUPE_TTL_MS` (see that file), so this is a real import-graph dependency,
// not prose. This test pins the relation itself: any edit that breaks it,
// including a re-hardcode of either side, fails here.
import { describe, expect, mock, test } from 'bun:test';

// `undelivered-prompts.ts` imports `./drain`, whose own import graph
// eagerly validates process env (`../../config`) — unrelated to the relation
// this file pins. Same mocking approach as `undelivered-prompts.test.ts`:
// stand in for `./drain` before importing the real module under test, so
// only the TTL/starvation constants get exercised for real.
mock.module('../drain', () => ({
  drainSessionLifecycleQueue: async () => ({ claimed: 0, succeeded: 0, failed: 0, queued: 0 }),
}));

const { DEDUPE_TTL_MS } = await import('../../../sandbox-proxy/prompt-dedupe');
const { UNDELIVERED_PROMPT_STARVATION_MS } = await import('../undelivered-prompts');

describe('F3 — DEDUPE_TTL_MS >= UNDELIVERED_PROMPT_STARVATION_MS', () => {
  test('the starvation reconciler never sweeps a row whose dedupe claim can have already expired', () => {
    expect(DEDUPE_TTL_MS).toBeGreaterThanOrEqual(UNDELIVERED_PROMPT_STARVATION_MS);
  });
});
