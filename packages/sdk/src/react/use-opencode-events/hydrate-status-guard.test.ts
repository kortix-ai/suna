import { describe, expect, test } from 'bun:test';

/**
 * `hydrateCore`'s `client.session.status()` snapshot describes the moment its
 * request was ISSUED and carries no timestamp of its own. Written back
 * unconditionally, a `busy` that was true on the way out overwrote an `idle`
 * frame that arrived while it was in flight — and because the object identity
 * changed, the store restamped that stale reading as the freshest observation
 * there is. Stop and the turn shimmer came back on a finished turn.
 *
 * The guard is one line, so this pins it in the source rather than standing up
 * the whole event-stream harness: hydration may FILL a gap, never overwrite a
 * value the live stream already put there.
 */
const SOURCE = await Bun.file(new URL('./index.ts', import.meta.url).pathname).text();

function hydrateStatusBlock(): string {
  const start = SOURCE.indexOf('client.session\n        .status()');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('reconcileMissingBusySessions.current(statuses)', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('hydrateCore session-status snapshot', () => {
  test('skips any session the live stream has already answered for', () => {
    const block = hydrateStatusBlock();
    expect(block).toContain('if (useSyncStore.getState().sessionStatus[sessionID]) continue;');
  });

  test('the skip precedes the write, so a stale reading cannot land first', () => {
    const block = hydrateStatusBlock();
    const guard = block.indexOf('sessionStatus[sessionID]) continue');
    const write = block.indexOf('applySyncEvent(');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  test('the enumeration repair still runs — absence is not a per-session reading', () => {
    expect(SOURCE).toContain('reconcileMissingBusySessions.current(statuses)');
  });
});
