import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { configureKortix } from '../core/http/config';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import { qk } from './query-keys';
import { readSessionPromptsInbox } from './use-session-prompts';
import { readSessionTurnObservation } from './use-session-working';

/**
 * ONE in-flight `/turn` and ONE in-flight `/prompts` per session.
 *
 * Staging HAR, 2026-09-23: during a turn both endpoints went out in identical
 * TRIPLES — same millisecond — although each query has a single poll owner.
 * The poll was never the source. Three components mount `useSessionWorking`
 * for one session, and each one's status-phase effect calls
 * `invalidateQueries` in the same commit. `invalidateQueries` refetches with
 * `cancelRefetch: true`, so every call CANCELS the fetch the previous one
 * started and issues a new one. The queryFns take no `AbortSignal`, so the
 * "cancelled" requests were never aborted on the wire: three requests, one
 * answer used. That is the triple.
 *
 * These tests drive the real TanStack `QueryClient` so the assertion is on the
 * mechanism itself, not on a model of it.
 */

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A fetch that never answers until `release()` — the request is in flight. */
function stallingFetch(body: () => unknown) {
  const urls: string[] = [];
  const pending: Array<() => void> = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    await new Promise<void>((resolve) => pending.push(resolve));
    return Response.json(body());
  }) as unknown as typeof fetch;
  return {
    urls,
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('session truth reads are single-flight per session', () => {
  test('three same-tick invalidations of /turn put ONE request on the wire', async () => {
    resetSessionOpenBundles();
    const wire = stallingFetch(() => ({ turns: [] }));
    const client = new QueryClient();
    const key = qk.project.sessionTurn('P1', 'S1');
    // Seed data so invalidation takes TanStack's cancel-and-refire branch —
    // the steady state during a turn, where the triple was observed.
    client.setQueryData(key, { turns: [], atMs: 0 });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => readSessionTurnObservation('P1', 'S1', { bundle: false }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    // The three mounts' phase effects, in one commit.
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: key });
    await nextMacrotask();

    expect(wire.urls.filter((u) => u.endsWith('/sessions/S1/turn'))).toHaveLength(1);
    wire.release();
    unsubscribe();
    client.clear();
  });

  test('three same-tick invalidations of /prompts put ONE request on the wire', async () => {
    resetSessionOpenBundles();
    const wire = stallingFetch(() => ({ prompts: [] }));
    const client = new QueryClient();
    const key = qk.project.sessionPrompts('P1', 'S1');
    client.setQueryData(key, []);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => readSessionPromptsInbox('P1', 'S1', client.getQueryData(key)),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: key });
    await nextMacrotask();

    expect(wire.urls.filter((u) => u.endsWith('/sessions/S1/prompts'))).toHaveLength(1);
    wire.release();
    unsubscribe();
    client.clear();
  });

  test('a read triggered in a LATER tick still asks the server again', async () => {
    // The dedupe must never answer a later trigger with a read issued before
    // it: a status frame that arrives while a read is in flight is news the
    // in-flight read cannot contain.
    resetSessionOpenBundles();
    const wire = stallingFetch(() => ({ turns: [] }));
    const first = readSessionTurnObservation('P1', 'S1', { bundle: false });
    await nextMacrotask();
    const second = readSessionTurnObservation('P1', 'S1', { bundle: false });
    await nextMacrotask();
    expect(wire.urls.filter((u) => u.endsWith('/turn'))).toHaveLength(2);
    wire.release();
    await Promise.all([first, second]);
  });

  test('joined readers share the request instant, stamped before the request', async () => {
    resetSessionOpenBundles();
    const wire = stallingFetch(() => ({ turns: [] }));
    const before = Date.now();
    const a = readSessionTurnObservation('P1', 'S1', { bundle: false });
    const b = readSessionTurnObservation('P1', 'S1', { bundle: false });
    wire.release();
    await nextMacrotask();
    wire.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(wire.urls).toHaveLength(1);
    expect(ra.atMs).toBe(rb.atMs);
    expect(ra.atMs).toBeGreaterThanOrEqual(before);
  });

  test('different sessions never share a read', async () => {
    resetSessionOpenBundles();
    const wire = stallingFetch(() => ({ turns: [] }));
    const a = readSessionTurnObservation('P1', 'S1', { bundle: false });
    const b = readSessionTurnObservation('P1', 'S2', { bundle: false });
    await nextMacrotask();
    expect(wire.urls).toHaveLength(2);
    wire.release();
    await Promise.all([a, b]);
  });
});
