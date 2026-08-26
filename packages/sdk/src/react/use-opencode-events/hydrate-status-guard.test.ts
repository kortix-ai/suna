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
  test('the fill decision routes through shouldSkipStatusFill with the slot stamp', () => {
    // The WHICH-slots rule (fresh wire owns; stale wire and local do not) is
    // unit-tested on the pure `shouldSkipStatusFill` in `helpers.test.ts` —
    // this pin only asserts hydrateCore actually consults it, with the
    // store's own arrival stamp rather than a component-minted one.
    const block = hydrateStatusBlock();
    expect(block).toContain('shouldSkipStatusFill({');
    expect(block).toContain('origin: slotState.sessionStatusOrigin[sessionID]');
    expect(block).toContain('stampedAtMs: slotState.sessionStatusAt[sessionID]');
  });

  test('the skip precedes the write, so a stale reading cannot land first', () => {
    const block = hydrateStatusBlock();
    const guard = block.indexOf('shouldSkipStatusFill({');
    const write = block.indexOf('applySyncEvent(');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  test('the snapshot write is marked synthetic, so it lands with local origin', () => {
    // A snapshot is a reading ABOUT the runtime taken at issue time, not the
    // runtime speaking on the wire. Unmarked, its write would mint a
    // wire-origin frame that `projectWorking` lets contradict an open turn.
    const block = hydrateStatusBlock();
    expect(block).toContain('synthetic: true');
  });

  test('the enumeration repair still runs — absence is not a per-session reading', () => {
    expect(SOURCE).toContain('reconcileMissingBusySessions.current(statuses)');
  });
});
