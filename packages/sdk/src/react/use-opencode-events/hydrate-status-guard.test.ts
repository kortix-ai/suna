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
  test('skips any session a WIRE frame has already answered for', () => {
    // Only the runtime's own frame owns the slot. A `'local'` value is the
    // tab's fabrication (the missing-busy sweep, a synthetic abort), and
    // letting it block this fill made a wrong fabrication self-sustaining: a
    // sweep that idled a running session could never be corrected by the very
    // snapshot that now says `busy`.
    const block = hydrateStatusBlock();
    expect(block).toContain('slotState.sessionStatus[sessionID] &&');
    expect(block).toContain("slotState.sessionStatusOrigin[sessionID] !== 'local'");
  });

  test('the skip precedes the write, so a stale reading cannot land first', () => {
    const block = hydrateStatusBlock();
    const guard = block.indexOf("sessionStatusOrigin[sessionID] !== 'local'");
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
