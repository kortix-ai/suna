import { describe, expect, test } from 'bun:test';
import {
  OPTIMISTIC_COMPACTION_MAX_MS,
  SERVER_COMPACTION_REVALIDATE_MS,
  compactionExpiryAtMs,
  projectCompacting,
  serverCompactionRevalidateAtMs,
} from './compaction';

const T0 = Date.parse('2026-08-18T10:00:00.000Z');

describe('projectCompacting', () => {
  test('the server flag decides, with no local stamp at all', () => {
    // `Session.time.compacting` is the runtime's own record that a compaction
    // is open. Nothing in this repo read it before — the composer was pinned
    // by a client-only boolean instead — so a compaction started by a second
    // device, a trigger, or a `/compact` this tab never issued was invisible.
    expect(
      projectCompacting({
        optimisticAtMs: null,
        serverCompactingAtMs: T0,
        nowMs: T0 + 10 * OPTIMISTIC_COMPACTION_MAX_MS,
      }),
    ).toBe(true);
  });

  test('the server flag outlives the local cap — it is an observation, not a guess', () => {
    expect(
      projectCompacting({
        optimisticAtMs: T0,
        serverCompactingAtMs: T0,
        nowMs: T0 + OPTIMISTIC_COMPACTION_MAX_MS + 1,
      }),
    ).toBe(true);
  });

  test('the optimistic stamp alone answers inside the cap', () => {
    // `/compact` is accepted locally long before the runtime writes the row,
    // and the composer has to hold from the click, not from the round trip.
    expect(
      projectCompacting({
        optimisticAtMs: T0,
        serverCompactingAtMs: null,
        nowMs: T0 + OPTIMISTIC_COMPACTION_MAX_MS - 1,
      }),
    ).toBe(true);
  });

  test('a lost session.compacted frame stops pinning the composer past the cap', () => {
    // THE failure this module exists for. `stopCompaction` runs only from the
    // `session.compacted` SSE frame; miss it (a backgrounded tab, a stream
    // reconnect) and the client-only boolean held the composer forever.
    expect(
      projectCompacting({
        optimisticAtMs: T0,
        serverCompactingAtMs: null,
        nowMs: T0 + OPTIMISTIC_COMPACTION_MAX_MS,
      }),
    ).toBe(false);
  });

  test('nothing observed is not compacting', () => {
    expect(
      projectCompacting({ optimisticAtMs: null, serverCompactingAtMs: null, nowMs: T0 }),
    ).toBe(false);
  });
});

describe('compactionExpiryAtMs', () => {
  test('names the instant the optimistic stamp stops deciding', () => {
    // The cap only applies if somebody asks again at that instant — the same
    // defect `workingExpiryAtMs` exists for. Nothing else re-renders when a
    // compaction quietly outlives its stamp.
    expect(
      compactionExpiryAtMs({ optimisticAtMs: T0, serverCompactingAtMs: null, nowMs: T0 }),
    ).toBe(T0 + OPTIMISTIC_COMPACTION_MAX_MS);
  });

  test('a deadline already past is not re-armed', () => {
    expect(
      compactionExpiryAtMs({
        optimisticAtMs: T0,
        serverCompactingAtMs: null,
        nowMs: T0 + OPTIMISTIC_COMPACTION_MAX_MS,
      }),
    ).toBeNull();
  });

  test('the server flag arms no PURE-PROJECTION re-render timer — it does not change on its own', () => {
    // `compactionExpiryAtMs` only answers "when does the PURE PROJECTION flip
    // by itself" — rule 1 stays `true` for as long as `serverCompactingAtMs`
    // is observed, so there is nothing here to re-render for. That is NOT the
    // same as "nothing ever forces a re-check" — see
    // `serverCompactionRevalidateAtMs`, below, which is the real repair path
    // for a lost `session.compacted` frame.
    expect(
      compactionExpiryAtMs({ optimisticAtMs: null, serverCompactingAtMs: T0, nowMs: T0 }),
    ).toBeNull();
  });

  test('nothing pending, nothing to re-arm', () => {
    expect(
      compactionExpiryAtMs({ optimisticAtMs: null, serverCompactingAtMs: null, nowMs: T0 }),
    ).toBeNull();
  });
});

describe('serverCompactionRevalidateAtMs', () => {
  test('names the instant a server-observed flag needs a live re-check', () => {
    expect(
      serverCompactionRevalidateAtMs({ optimisticAtMs: null, serverCompactingAtMs: T0, nowMs: T0 }),
    ).toBe(T0 + SERVER_COMPACTION_REVALIDATE_MS);
  });

  test('an overdue deadline is returned, not swallowed — a late check still fires', () => {
    // Unlike `compactionExpiryAtMs`, this is anchored to `serverCompactingAtMs`
    // (when the flag was FIRST observed), not to `nowMs` — a session mounted
    // long after compaction started, or a revalidation cycle that kept
    // re-arming because the server kept confirming `compacting: true`, can
    // already be past its deadline the moment this is read. The caller must
    // still fire the re-check rather than skip it.
    expect(
      serverCompactionRevalidateAtMs({
        optimisticAtMs: null,
        serverCompactingAtMs: T0,
        nowMs: T0 + 10 * SERVER_COMPACTION_REVALIDATE_MS,
      }),
    ).toBe(T0 + SERVER_COMPACTION_REVALIDATE_MS);
  });

  test('no server flag observed — nothing to revalidate', () => {
    expect(
      serverCompactionRevalidateAtMs({ optimisticAtMs: T0, serverCompactingAtMs: null, nowMs: T0 }),
    ).toBeNull();
  });
});
