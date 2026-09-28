import { describe, expect, test } from 'bun:test';

import { QueryClient } from '@tanstack/react-query';

import {
  patchKortixSessionTitleMirrors,
  refetchKortixSessionMirrors,
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
 * fill needs to correct. Prod, 2026-08-26 (sampleco): a turn sitting inside
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
      // The sidebar and the Sessions page read the PAGED list. A refetch aimed
      // only at `'list'` never reached them: `session.created` and title events
      // waited for the next poll (up to 60 s) to show up in the sidebar.
      { queryKey: [...qk.project.sessionsScope('proj_1'), 'list-paged'], type: 'active' },
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
    for (const call of calls as Array<{ queryKey: readonly unknown[] }>) {
      expect(call.queryKey.slice(0, 3)).toEqual([...qk.project.scope('proj_1')]);
    }
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

describe('patchKortixSessionTitleMirrors', () => {
  const pagedKey = qk.project.sessionsPaged('proj_1');
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    session_id: id,
    opencode_session_id: `ses_${id}`,
    name: null,
    custom_name: null,
    ...extra,
  });

  test('writes the runtime title into the paged list the sidebar reads', () => {
    const client = new QueryClient();
    client.setQueryData(pagedKey, {
      pages: [{ items: [row('a'), row('b')], next_cursor: 'c1' }, { items: [row('c')], next_cursor: null }],
      pageParams: [null, 'c1'],
    });

    patchKortixSessionTitleMirrors(client, 'proj_1', 'ses_c', 'Fix the audit 5xx');

    const data = client.getQueryData(pagedKey) as { pages: Array<{ items: Array<{ name: string | null }> }> };
    expect(data.pages[1].items[0].name).toBe('Fix the audit 5xx');
    expect(data.pages[0].items.map((r) => r.name)).toEqual([null, null]);
  });

  test('a user rename wins over the runtime title', () => {
    const client = new QueryClient();
    client.setQueryData(pagedKey, {
      pages: [{ items: [row('a', { custom_name: 'Mine' })], next_cursor: null }],
      pageParams: [null],
    });
    const before: unknown = client.getQueryData(pagedKey);

    patchKortixSessionTitleMirrors(client, 'proj_1', 'ses_a', 'Runtime title');

    expect(client.getQueryData(pagedKey) as unknown).toBe(before);
  });

  test('leaves the prompt inbox and other per-session entries untouched', () => {
    const client = new QueryClient();
    const prompts = [{ prompt_id: 'p1', opencode_session_id: 'ses_a', name: 'queued' }];
    client.setQueryData(qk.project.sessionPrompts('proj_1', 'a'), prompts);

    patchKortixSessionTitleMirrors(client, 'proj_1', 'ses_a', 'Runtime title');

    expect(client.getQueryData(qk.project.sessionPrompts('proj_1', 'a')) as unknown).toBe(prompts);
  });
});
