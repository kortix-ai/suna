import { describe, expect, test } from 'bun:test';

import {
  refetchKortixSessionMirrors,
  releaseMessageRehydrate,
  reserveMessageRehydrate,
  resyncReadIsUrgent,
  resolveClientEvictionUrl,
  shouldSkipStatusFill,
  WIRE_STATUS_FILL_FRESHNESS_MS,
} from './helpers';
import { qk } from '../query-keys';

/**
 * WHICH slots the reconnect status snapshot may repair.
 *
 * The old guard was binary: any wire-origin slot blocked the fill forever, on
 * the theory that "the stream owns this value". True for a LIVE stream — and
 * exactly backwards for a dead one: the reconnect that runs this fill happens
 * BECAUSE the stream died, and the wire idle frame it left behind is what the
 * fill needs to correct. Prod, 2026-08-26 (essentia): a turn sitting inside
 * one long tool call moves no transcript, so the hydrate-movement evidence is
 * silent, and the frozen wire-idle slot kept vetoing the open `/turn` row for
 * the whole run.
 *
 * The rule: a wire frame owns its slot only while a live stream could
 * plausibly have delivered it — `WIRE_STATUS_FILL_FRESHNESS_MS`, equal to the
 * projection's own stream bound. Past that, the frame is a dead stream's last
 * word and the REST snapshot may overwrite it.
 */
describe('shouldSkipStatusFill', () => {
  const nowMs = 1_000_000;

  test('an empty slot always fills', () => {
    expect(shouldSkipStatusFill({ hasSlot: false, origin: undefined, stampedAtMs: undefined, nowMs })).toBe(false);
  });

  test('a local (fabricated) slot always fills — fabrications must be correctable', () => {
    expect(
      shouldSkipStatusFill({ hasSlot: true, origin: 'local', stampedAtMs: nowMs - 1, nowMs }),
    ).toBe(false);
  });

  test('a FRESH wire frame owns its slot — the live stream is the authority', () => {
    expect(
      shouldSkipStatusFill({ hasSlot: true, origin: 'wire', stampedAtMs: nowMs - 1_000, nowMs }),
    ).toBe(true);
    expect(
      shouldSkipStatusFill({
        hasSlot: true,
        origin: 'wire',
        stampedAtMs: nowMs - WIRE_STATUS_FILL_FRESHNESS_MS,
        nowMs,
      }),
    ).toBe(true);
  });

  test('a STALE wire frame no longer blocks the fill — a dead stream owns nothing', () => {
    expect(
      shouldSkipStatusFill({
        hasSlot: true,
        origin: 'wire',
        stampedAtMs: nowMs - WIRE_STATUS_FILL_FRESHNESS_MS - 1,
        nowMs,
      }),
    ).toBe(false);
  });

  test('a wire slot with no stamp is treated as fresh (conservative)', () => {
    expect(
      shouldSkipStatusFill({ hasSlot: true, origin: 'wire', stampedAtMs: undefined, nowMs }),
    ).toBe(true);
  });

  test('absent origin means wire — matching the store default', () => {
    expect(
      shouldSkipStatusFill({ hasSlot: true, origin: undefined, stampedAtMs: nowMs - 1_000, nowMs }),
    ).toBe(true);
  });
});

function fakeQueryClient() {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      refetchQueries: (input: unknown) => {
        calls.push(input);
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof refetchKortixSessionMirrors>[0],
  };
}

describe('refetchKortixSessionMirrors', () => {
  // Pre-migration this refetched a BARE, id-less flat `project-sessions`
  // array prefix, which matched every mounted project's sessions list.
  // `qk.project.scope(id)` requires an id up front, so there is no key that
  // means "sessions, any project" without also reaching every OTHER
  // project-scoped family for every project. Scoping to the route's project
  // (what the SSE connection is actually about) is the correct reach — see
  // the function's doc comment in `helpers.ts`.
  test('refetches the LIST family for the given project only', () => {
    const { client, calls } = fakeQueryClient();
    refetchKortixSessionMirrors(client, 'proj_1');
    // The title/tree MIRROR is what this event is about, so the reach is the
    // list family — not the whole `sessionsScope` prefix, which also covers
    // `sessionTurn` and `sessionPrompts` (see `query-keys.ts`). Every
    // `session.created` and every title-changing `session.updated` used to
    // re-issue `/turn` and `/prompts` with it.
    expect(calls).toEqual([
      { queryKey: [...qk.project.sessionsScope('proj_1'), 'list'], type: 'active' },
    ]);
    const touched = JSON.stringify(calls);
    expect(touched).not.toContain('"turn"');
    expect(touched).not.toContain('"prompts"');
  });

  test('does nothing outside a project route (projectId null)', () => {
    const { client, calls } = fakeQueryClient();
    refetchKortixSessionMirrors(client, null);
    expect(calls).toEqual([]);
  });

  // A different project's sessions prefix must never be touched by an event
  // about THIS project — the whole reason this isn't the old bare "any
  // project" prefix.
  test('never reaches a different project\'s sessions prefix', () => {
    const { client, calls } = fakeQueryClient();
    refetchKortixSessionMirrors(client, 'proj_1');
    const [call] = calls as Array<{ queryKey: readonly unknown[] }>;
    expect(call.queryKey).not.toEqual(qk.project.sessionsScope('proj_2'));
  });
});

// T8 defect 2 — `resetClient()` used to wipe the WHOLE per-URL
// opencode client cache (`clientsByUrl.clear()`) on every runtime switch,
// which forced every OTHER concurrently-open session's client to be
// recreated just because THIS session's runtime switched (`clientsByUrl` is
// explicitly keyed per url so several session sandboxes can stay connected
// at once — see `core/runtime/client.ts`'s doc comment on that cache).
// `resolveClientEvictionUrl` is the pure decision `useOpenCodeEventStream`'s
// effect now drives its `dropClientForUrl` call from: WHICH single url (if
// any) should be evicted, never "all of them".
describe('resolveClientEvictionUrl', () => {
  test('first mount: evicts the CURRENT url (about to be used), not a previous one', () => {
    // No "previous" url exists for a fresh mount — but a stale/broken client
    // for the url about to be used may still be cached from a provider that
    // unmounted without cleanly closing (navigate away, then back to the
    // same session).
    expect(
      resolveClientEvictionUrl({
        isFirstMount: true,
        isServerSwitch: false,
        didServerUrlChange: false,
        previousServerUrl: null,
        activeServerUrl: 'https://api.example/p/ext-1/8000',
      }),
    ).toBe('https://api.example/p/ext-1/8000');
  });

  test('first mount with no active url yet: nothing to evict', () => {
    expect(
      resolveClientEvictionUrl({
        isFirstMount: true,
        isServerSwitch: false,
        didServerUrlChange: false,
        previousServerUrl: null,
        activeServerUrl: null,
      }),
    ).toBeNull();
  });

  test('server switch: evicts ONLY the previous (replaced) url, never the new one', () => {
    expect(
      resolveClientEvictionUrl({
        isFirstMount: false,
        isServerSwitch: true,
        didServerUrlChange: true,
        previousServerUrl: 'https://api.example/p/ext-old/8000',
        activeServerUrl: 'https://api.example/p/ext-new/8000',
      }),
    ).toBe('https://api.example/p/ext-old/8000');
  });

  test('url-only change on the same logical server: evicts the previous url', () => {
    expect(
      resolveClientEvictionUrl({
        isFirstMount: false,
        isServerSwitch: false,
        didServerUrlChange: true,
        previousServerUrl: 'https://api.example/p/ext-1/8000-old-proxy',
        activeServerUrl: 'https://api.example/p/ext-1/8000-new-proxy',
      }),
    ).toBe('https://api.example/p/ext-1/8000-old-proxy');
  });

  test('neither a switch nor a url change: nothing to evict (caches, other sessions untouched)', () => {
    expect(
      resolveClientEvictionUrl({
        isFirstMount: false,
        isServerSwitch: false,
        didServerUrlChange: false,
        previousServerUrl: 'https://api.example/p/ext-1/8000',
        activeServerUrl: 'https://api.example/p/ext-1/8000',
      }),
    ).toBeNull();
  });
});

/**
 * The transcript re-read a stream resync asks for, per session.
 *
 * Two bounds, chosen per read by `resyncReadIsUrgent`:
 * - URGENT (the dropped subscription carried content and the session is
 *   running): only a floor below the stream's 5 s floor. The old 30 s cooldown
 *   and in-flight lock swallowed the resync of a second reconnect of a
 *   flapping busy stream, so the frames that reconnect lost were never
 *   re-read. The session sync controller chains an `sse-gap` read that arrives
 *   during another read into one follow-up read.
 * - OTHERWISE (a gap-only resync, or a session that is not running): the
 *   30 s cooldown and no new read while this path's read is in flight. A
 *   flapping stream otherwise re-read every held transcript back to back.
 */
describe('reserveMessageRehydrate', () => {
  test('an urgent read bypasses the 30 s cooldown and the in-flight lock but respects the floor', () => {
    const sessionId = 'ses_resync_floor';
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 100_000 })).toBe(true);
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 103_999 })).toBe(false);
    // The first read is still in flight: never released.
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 104_000 })).toBe(true);
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 112_000 })).toBe(true);
  });

  /**
   * The stream stamps its 5 s floor before any subscriber runs. `hydrateCore`
   * reserves after its own setup and after earlier subscribers, so its first
   * reservation lands a few ms late. The stream's next resync can come exactly
   * 5 s after its stamp, and that resync must still re-read the transcript.
   */
  test('an urgent reservation 2 ms late still leaves the stream resync 5 s later its read', () => {
    const sessionId = 'ses_resync_late_reservation';
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 400_002 })).toBe(true);
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 405_000 })).toBe(true);
  });

  test('a non-urgent read waits for the in-flight read, then for 30 s from its reservation', () => {
    const sessionId = 'ses_resync_cooldown';
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 500_000 })).toBe(true);
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 540_000 })).toBe(false);
    releaseMessageRehydrate(sessionId);
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 540_000 })).toBe(true);
    releaseMessageRehydrate(sessionId);
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 569_999 })).toBe(false);
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 570_000 })).toBe(true);
  });

  test('a non-urgent read waits for an urgent read still in flight', () => {
    const sessionId = 'ses_resync_mixed';
    expect(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: 600_000 })).toBe(true);
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 700_000 })).toBe(false);
    releaseMessageRehydrate(sessionId);
    expect(reserveMessageRehydrate(sessionId, { urgent: false, nowMs: 700_000 })).toBe(true);
  });

  test('guard: each session has its own floor', () => {
    expect(reserveMessageRehydrate('ses_floor_a', { urgent: true, nowMs: 200_000 })).toBe(true);
    expect(reserveMessageRehydrate('ses_floor_b', { urgent: true, nowMs: 200_001 })).toBe(true);
  });

  test('guard: an empty session id reserves nothing', () => {
    expect(reserveMessageRehydrate('', { urgent: true, nowMs: 300_000 })).toBe(false);
    expect(reserveMessageRehydrate('', { urgent: false, nowMs: 300_000 })).toBe(false);
  });
});

describe('resyncReadIsUrgent', () => {
  test('lost content of a running session is urgent', () => {
    expect(resyncReadIsUrgent({ contentLost: true, status: { type: 'busy' } })).toBe(true);
    expect(
      resyncReadIsUrgent({
        contentLost: true,
        status: { type: 'retry', attempt: 1, message: 'overloaded', next: 0 },
      }),
    ).toBe(true);
  });

  test('a session that is not running, or a gap-only resync, is not urgent', () => {
    expect(resyncReadIsUrgent({ contentLost: true, status: { type: 'idle' } })).toBe(false);
    expect(resyncReadIsUrgent({ contentLost: true, status: undefined })).toBe(false);
    expect(resyncReadIsUrgent({ contentLost: false, status: { type: 'busy' } })).toBe(false);
  });
});
