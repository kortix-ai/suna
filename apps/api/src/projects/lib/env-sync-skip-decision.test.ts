// The pure "should this prompt's env sync push synchronously, skip, or skip
// AND kick a detached background refresh" decision — see the module header on
// `env-sync-skip-decision.ts` for the incident this replaces (2026-09-27 dev
// benchmark: a 2-replica API meant the in-process-only memo missed on roughly
// half of every session's turns, so `syncSandboxEnvForPrompt` re-pushed and
// re-respawned almost every prompt instead of only the first).
import { describe, expect, test } from 'bun:test';
import { decideEnvSyncAction } from './env-sync-skip-decision';

const NOW = 1_000_000;
const STALE_MS = 10 * 60_000;

describe('decideEnvSyncAction', () => {
  test('no memory and no persisted state (first prompt of a session) pushes synchronously', () => {
    const decision = decideEnvSyncAction({
      signature: 'sig-a',
      memory: null,
      persisted: null,
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision.action).toBe('push');
  });

  test('a matching in-process memo skips without touching the durable store', () => {
    const decision = decideEnvSyncAction({
      signature: 'sig-a',
      memory: { signature: 'sig-a', pushedAtMs: NOW - 1_000 },
      persisted: null, // must not matter — memory alone is enough to skip
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision).toEqual({ action: 'skip', scheduleBackgroundRefresh: false, appliedAtMs: NOW - 1_000 });
  });

  test('a stale in-process memo still skips synchronously but asks for a background refresh', () => {
    const pushedAtMs = NOW - STALE_MS - 1;
    const decision = decideEnvSyncAction({
      signature: 'sig-a',
      memory: { signature: 'sig-a', pushedAtMs },
      persisted: null,
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision).toEqual({ action: 'skip', scheduleBackgroundRefresh: true, appliedAtMs: pushedAtMs });
  });

  test('a memo mismatch (a real change happened) pushes synchronously even if persisted matches something else', () => {
    const decision = decideEnvSyncAction({
      signature: 'sig-b',
      memory: { signature: 'sig-a', pushedAtMs: NOW - 1_000 },
      persisted: { signature: 'sig-a', appliedAtMs: NOW - 1_000 },
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision.action).toBe('push');
  });

  // The cross-replica case this whole module exists for: THIS process has no
  // memory of the sandbox (a fresh replica, or one that never served this
  // session before), but another replica already applied the identical
  // signature and recorded it durably.
  test('no in-process memory but a matching durable record (a DIFFERENT replica already applied it) skips', () => {
    const decision = decideEnvSyncAction({
      signature: 'sig-a',
      memory: null,
      persisted: { signature: 'sig-a', appliedAtMs: NOW - 5_000 },
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision).toEqual({ action: 'skip', scheduleBackgroundRefresh: false, appliedAtMs: NOW - 5_000 });
  });

  test('a stale durable record still skips synchronously but asks for a background refresh', () => {
    const appliedAtMs = NOW - STALE_MS - 1;
    const decision = decideEnvSyncAction({
      signature: 'sig-a',
      memory: null,
      persisted: { signature: 'sig-a', appliedAtMs },
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision).toEqual({ action: 'skip', scheduleBackgroundRefresh: true, appliedAtMs });
  });

  test('a durable record for a DIFFERENT signature (a real change another replica has not seen) pushes synchronously', () => {
    const decision = decideEnvSyncAction({
      signature: 'sig-b',
      memory: null,
      persisted: { signature: 'sig-a', appliedAtMs: NOW - 1_000 },
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision.action).toBe('push');
  });

  test('exactly at the staleness boundary counts as stale (>=), not fresh', () => {
    const appliedAtMs = NOW - STALE_MS;
    const decision = decideEnvSyncAction({
      signature: 'sig-a',
      memory: null,
      persisted: { signature: 'sig-a', appliedAtMs },
      nowMs: NOW,
      backgroundRefreshStaleMs: STALE_MS,
    });
    expect(decision).toEqual({ action: 'skip', scheduleBackgroundRefresh: true, appliedAtMs });
  });
});
