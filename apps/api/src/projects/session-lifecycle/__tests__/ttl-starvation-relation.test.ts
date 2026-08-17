// F3 — the no-blind-repost guarantee documented on `executeQueuedContinue`
// (engine.ts) depends on one cross-module relation:
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
// not prose. This test pins the relation itself, so a regression — e.g.
// someone re-hardcoding one side back to a bare number — fails here.
import { describe, expect, mock, test } from 'bun:test';

// `undelivered-prompts.ts` imports `./engine`, whose own import graph
// eagerly validates process env (`../../config`) — unrelated to the relation
// this file pins. Same mocking approach as `undelivered-prompts.test.ts`:
// stand in for `./engine` before importing the real module under test, so
// only the TTL/starvation constants get exercised for real.
mock.module('../engine', () => ({
  drainSessionLifecycleQueue: async () => ({ claimed: 0, succeeded: 0, failed: 0, queued: 0 }),
}));

const { DEDUPE_TTL_MS } = await import('../../../sandbox-proxy/prompt-dedupe');
const { UNDELIVERED_PROMPT_STARVATION_MS } = await import('../undelivered-prompts');

describe('F3 — DEDUPE_TTL_MS >= UNDELIVERED_PROMPT_STARVATION_MS', () => {
  test('the starvation reconciler never sweeps a row whose dedupe claim can have already expired', () => {
    expect(DEDUPE_TTL_MS).toBeGreaterThanOrEqual(UNDELIVERED_PROMPT_STARVATION_MS);
  });

  test('the starvation window is DERIVED from the dedupe TTL, not merely equal by coincidence', () => {
    // Value equality alone doesn't prove derivation (two independent
    // hardcodes that happen to match would pass it too). This is the same
    // shape the pre-F3 code was already in. What actually matters is that
    // `undelivered-prompts.ts` imports `DEDUPE_TTL_MS` — asserted here via
    // strict identity, which two independently-defined `10 * 60_000`
    // literals would also satisfy for primitives, so the real guarantee is
    // the import itself (see the file, and the module-graph check below).
    expect(UNDELIVERED_PROMPT_STARVATION_MS).toBe(DEDUPE_TTL_MS);
  });

  test('undelivered-prompts.ts source actually imports DEDUPE_TTL_MS (not a second hardcode)', async () => {
    const src = await Bun.file(
      new URL('../undelivered-prompts.ts', import.meta.url).pathname,
    ).text();
    expect(src).toContain("import { DEDUPE_TTL_MS } from '../../sandbox-proxy/prompt-dedupe'");
    expect(src).toContain('UNDELIVERED_PROMPT_STARVATION_MS = DEDUPE_TTL_MS');
    // The old independent hardcode must be gone, not merely shadowed.
    expect(src).not.toContain('10 * 60_000');
  });
});
