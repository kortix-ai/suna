import { describe, expect, test } from 'bun:test';

import { showsGeneratingIndicator } from './working-indicator';
import type { WorkingProjection } from './working';

const idle: WorkingProjection = {
  state: 'idle',
  source: 'server',
  turnId: null,
  since: 0,
  serverOpenTurnToken: null,
};

const workingFrom = (source: WorkingProjection['source']): WorkingProjection => ({
  state: 'working',
  source,
  turnId: 'msg-1',
  since: 1_000,
  serverOpenTurnToken: 'tok-1',
});

/**
 * "Gathering thoughts…" means the agent is generating. Only the RUNTIME can
 * report that, over the stream. A `GET .../turn` poll reports something else —
 * that a row is open in the control plane's ledger — and rows are closed by a
 * separate relay, so one routinely outlives its turn.
 *
 * Observed on pi.kortix.com 2026-08-29: nine ledger rows across four sessions,
 * every one still `active`, the oldest 67 minutes after its answer was written.
 * Every affected session painted the shimmer over a finished transcript with
 * the composer stuck on Stop.
 */
describe('showsGeneratingIndicator', () => {
  test('idle never shows it, whatever the source', () => {
    for (const source of ['server', 'stream', 'optimistic'] as const) {
      expect(showsGeneratingIndicator({ projection: { ...idle, source } })).toBe(false);
    }
  });

  test('THE RULE: a server poll NEVER paints the shimmer', () => {
    // Unconditional. The previous version let this through once the stream had
    // "corroborated" — but control frames carry the same ledger rows, so a
    // stale row corroborated itself and the shimmer came straight back.
    expect(showsGeneratingIndicator({ projection: workingFrom('server') })).toBe(false);
  });

  test('the live stream does paint it — that is the runtime generating', () => {
    expect(showsGeneratingIndicator({ projection: workingFrom('stream') })).toBe(true);
  });

  test('this tab own send paints it, so pressing send is not a dead click', () => {
    // The receipt covers the milliseconds between the click and the first SSE
    // frame. Without it there is a visible gap with no feedback at all.
    expect(showsGeneratingIndicator({ projection: workingFrom('optimistic') })).toBe(true);
  });

  test('an unrecognized source is silent, not assumed live', () => {
    // Allowlist, not denylist: a future observer must be opted IN by someone
    // deciding it means the runtime is generating.
    expect(
      showsGeneratingIndicator({
        projection: { state: 'working', source: 'poll-v2' as WorkingProjection['source'] },
      }),
    ).toBe(false);
  });
});
