import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  environmentManager,
  focusManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { configureKortix } from '../core/http/config';
import { INBOX_OBSERVATION_MAX_MS } from '../core/session/working';
import { openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import type { SessionPrompt } from '../core/rest/projects-client/sessions';
import { resetPollOwners } from '../core/session/poll-owner';
import {
  applyOptimisticPrompt,
  applyInboxObservation,
  inboxDrained,
  optimisticSessionPrompt,
  reconcileOptimisticPrompts,
  removeOptimisticPrompt,
  settleOptimisticPrompt,
  SESSION_PROMPTS_IDLE_POLL_MS,
  SESSION_PROMPTS_LIVE_POLL_LADDER_MS,
  SESSION_PROMPTS_POLL_MS,
  type SessionPromptsCadenceState,
  type UseSessionPromptsResult,
  countNonTerminalSessionPrompts,
  nextSessionPromptsCadenceState,
  noteInboxObservation,
  readSessionPromptsInbox,
  sessionPromptsFingerprint,
  sessionPromptsPollMs,
  startSessionWithPrompt,
  useSessionPrompts,
} from './use-session-prompts';
import { qk } from './query-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The polling cadence is a CORRECTNESS decision, not a performance one.
 *
 * A prompt can ENTER this list without the tab doing anything: the reaper
 * redelivers one whose turn never ran, and parking a box requeues its in-flight
 * prompt as `held`. Both land on a session whose list is, at that moment, empty
 * — and the `held` design depends on the user seeing the row so they can
 * release it. A cadence of `false` at zero rows means the tab never learns, and
 * only a full page load recovers.
 */
describe('sessionPromptsPollMs', () => {
  const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  test('polls fast while prompts are pending — their state changes on its own', () => {
    expect(sessionPromptsPollMs(1)).toBe(SESSION_PROMPTS_POLL_MS);
    expect(sessionPromptsPollMs(7)).toBe(SESSION_PROMPTS_POLL_MS);
  });

  test('an EMPTY list still polls, slowly — a prompt can come back on its own', () => {
    expect(sessionPromptsPollMs(0)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
    expect(SESSION_PROMPTS_IDLE_POLL_MS).toBeGreaterThan(SESSION_PROMPTS_POLL_MS);
  });

  test('an explicit cadence overrides the busy one, never the idle one', () => {
    // Hosts tune the busy cadence for their own UI. The idle floor is not
    // theirs to remove: it is what makes a re-entering prompt visible.
    expect(sessionPromptsPollMs(2, 500)).toBe(500);
    expect(sessionPromptsPollMs(0, 500)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
  });

  /**
   * The cadence is picked from the PREVIOUS result, and that is what opened the
   * hole this covers.
   *
   * `notePromptAccepted` records a believed pending row the instant
   * `POST .../prompts` returns, because `GET .../turn` cannot see the send yet
   * and the composer must not swap Stop back to Send underneath it. That belief
   * is an OBSERVATION like any other, so `projectWorking` expires it at
   * `INBOX_OBSERVATION_MAX_MS` (10s) — and only a list read can refresh it.
   *
   * MEASURED on the local stack 2026-08-21: a first read landed before the row
   * existed, answered zero, and locked the cadence to `SESSION_PROMPTS_IDLE_POLL_MS`
   * (15s). Nothing then refreshed the belief inside its 10s life, and the
   * projection dropped to `idle` at 23:44:18.284 with `inbox=1@10004` while the
   * user's prompt was still pending — a guaranteed 5s hole between the two
   * constants, in which the composer offers Send for a prompt already queued.
   *
   * The list length alone cannot close it, because at that moment the list is
   * honestly empty. What the tab BELIEVES is pending has to count too.
   */
  test('a believed pending row polls fast even when the fetched list is empty', () => {
    expect(sessionPromptsPollMs(0, undefined, 1)).toBe(SESSION_PROMPTS_POLL_MS);
  });

  test('the cadence that refreshes the belief must outlive nothing — it must beat the bound', () => {
    // The invariant behind the test above, stated so a future change to either
    // constant cannot silently reopen the hole.
    expect(sessionPromptsPollMs(0, undefined, 1)).toBeLessThan(INBOX_OBSERVATION_MAX_MS);
    expect(sessionPromptsPollMs(1)).toBeLessThan(INBOX_OBSERVATION_MAX_MS);
  });

  test('no belief and no rows still means the idle floor', () => {
    expect(sessionPromptsPollMs(0, undefined, 0)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
  });

  test('a terminal-only list uses the idle floor, while a queued row uses the live ladder', () => {
    const failed = prompt({ state: 'failed' });
    const queued = prompt({ prompt_id: 'p2' });

    expect(countNonTerminalSessionPrompts([failed])).toBe(0);
    expect(sessionPromptsPollMs(countNonTerminalSessionPrompts([failed]))).toBe(
      SESSION_PROMPTS_IDLE_POLL_MS,
    );
    expect(countNonTerminalSessionPrompts([failed, queued])).toBe(1);
    expect(sessionPromptsPollMs(countNonTerminalSessionPrompts([failed, queued]))).toBe(
      SESSION_PROMPTS_POLL_MS,
    );
  });

  test('identical live snapshots advance 1,000 → 2,000 → 4,000 → 4,000 ms inside the latency budget', () => {
    const rows = [prompt()];
    let cadence = nextSessionPromptsCadenceState(undefined, rows);
    const rungs = [0, 1, 2, 3].map(() => {
      const interval = sessionPromptsPollMs(
        countNonTerminalSessionPrompts(rows),
        undefined,
        0,
        cadence,
      );
      cadence = nextSessionPromptsCadenceState(cadence, rows);
      return interval;
    });

    expect(SESSION_PROMPTS_LIVE_POLL_LADDER_MS).toEqual([1_000, 2_000, 4_000]);
    expect(rungs).toEqual([1_000, 2_000, 4_000, 4_000]);
    for (const rung of rungs) {
      expect(rung + 2 * 2_500).toBeLessThan(INBOX_OBSERVATION_MAX_MS);
    }
  });

  test('a changed fingerprint, mutation reset, and focus reset each return live polling to 1,000 ms', () => {
    const rows = [prompt()];
    let cadence = nextSessionPromptsCadenceState(undefined, rows);
    cadence = nextSessionPromptsCadenceState(cadence, rows);
    cadence = nextSessionPromptsCadenceState(cadence, rows);
    expect(sessionPromptsPollMs(1, undefined, 0, cadence)).toBe(4_000);

    const changed = nextSessionPromptsCadenceState(cadence, [prompt({ state: 'delivering' })]);
    expect(sessionPromptsPollMs(1, undefined, 0, changed)).toBe(1_000);
    expect(sessionPromptsPollMs(1, undefined, 0, nextSessionPromptsCadenceState(changed, rows, true))).toBe(1_000);
    expect(sessionPromptsPollMs(1, undefined, 0, nextSessionPromptsCadenceState(changed, rows, true))).toBe(1_000);
  });

  test('held rows remain non-terminal, and the fingerprint ignores observation timestamps only', () => {
    const held = prompt({ state: 'waiting', reason: 'held' });
    expect(countNonTerminalSessionPrompts([held])).toBe(1);

    const original = {
      ...held,
      observed_at: '2026-08-18T10:00:00.000Z',
    } as SessionPrompt & { observed_at: string };
    const observedLater = {
      ...original,
      observed_at: '2026-08-18T10:01:00.000Z',
    };
    expect(sessionPromptsFingerprint([original])).toBe(sessionPromptsFingerprint([observedLater]));

    for (const changed of [
      { prompt_id: 'p2' },
      { state: 'queued' as const },
      { reason: null },
      { attempts: 1 },
      { last_error: 'retry' },
      { message_id: 'msg_02' },
      { available_at: '2026-08-18T10:02:00.000Z' },
    ]) {
      expect(sessionPromptsFingerprint([original])).not.toBe(
        sessionPromptsFingerprint([{ ...original, ...changed }]),
      );
    }
  });
});

class FakeTimers {
  private nextId = 1;
  private now = 0;
  private timers = new Map<number, { callback: () => void; due: number; interval: number | null }>();

  install(): () => void {
    const native = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      this.schedule(() => typeof callback === 'function' && callback(...args), delay ?? 0, null)) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => this.timers.delete(id)) as typeof clearTimeout;
    globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      this.schedule(() => typeof callback === 'function' && callback(...args), delay ?? 0, delay ?? 0)) as typeof setInterval;
    globalThis.clearInterval = ((id: number) => this.timers.delete(id)) as typeof clearInterval;
    return () => Object.assign(globalThis, native);
  }

  async advanceBy(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      const [id, timer] = due;
      this.now = timer.due;
      if (timer.interval == null) this.timers.delete(id);
      else timer.due += timer.interval;
      timer.callback();
      await flushPromises();
    }
    this.now = end;
    await flushPromises();
  }

  activeIntervals(): number {
    return [...this.timers.values()].filter((timer) => timer.interval != null).length;
  }

  private schedule(callback: () => void, delay: number, interval: number | null): number {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + delay, interval });
    return id;
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('prompt inbox QueryObserver cadence', () => {
  let restoreFakeTimers: (() => void) | undefined;

  const row = (state: SessionPrompt['state']): SessionPrompt => ({
    prompt_id: 'p1', client_message_id: 'q1', message_id: 'msg_01', state, reason: null,
    text: 'hi', attempts: 0, last_error: null, created_at: '2026-08-18T10:00:00.000Z', available_at: '2026-08-18T10:00:00.000Z',
  });

  afterEach(() => {
    restoreFakeTimers?.();
    restoreFakeTimers = undefined;
    environmentManager.setIsServer(() => true);
    focusManager.setFocused(undefined);
  });

  test('backs a terminal row off to at most four reads in 60 seconds, follows 1/2/4/4 for live rows, and focus re-arms 1 second', async () => {
    const timers = new FakeTimers();
    restoreFakeTimers = timers.install();
    environmentManager.setIsServer(() => false);
    focusManager.setFocused(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.mount();
    let rows = [row('failed')];
    let cadence: SessionPromptsCadenceState | undefined;
    let resetOnNextRead = false;
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['prompts', 'p1', 's1'],
      queryFn: async () => {
        reads += 1;
        cadence = nextSessionPromptsCadenceState(cadence, rows, resetOnNextRead);
        resetOnNextRead = false;
        return rows;
      },
      refetchInterval: (query) => sessionPromptsPollMs(
        countNonTerminalSessionPrompts(query.state.data ?? []), undefined, 0, cadence,
      ),
      refetchOnWindowFocus: true,
    });
    const unsubscribe = observer.subscribe(() => {});
    await flushPromises();
    expect(reads).toBe(1);
    await timers.advanceBy(60_000);
    expect(reads).toBeLessThanOrEqual(5);

    rows = [row('queued')];
    resetOnNextRead = true;
    await observer.refetch();
    expect(reads).toBe(6);
    await timers.advanceBy(999);
    expect(reads).toBe(6);
    await timers.advanceBy(1);
    expect(reads).toBe(7);
    await timers.advanceBy(1_999);
    expect(reads).toBe(7);
    await timers.advanceBy(1);
    expect(reads).toBe(8);
    await timers.advanceBy(3_999);
    expect(reads).toBe(8);
    await timers.advanceBy(1);
    expect(reads).toBe(9);

    resetOnNextRead = true;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flushPromises();
    await timers.advanceBy(999);
    expect(reads).toBe(10);
    await timers.advanceBy(1);
    expect(reads).toBe(11);
    unsubscribe();
    client.unmount();
  });

  test('two observers retain one poll owner and do not advance cadence twice', async () => {
    const timers = new FakeTimers();
    restoreFakeTimers = timers.install();
    environmentManager.setIsServer(() => false);
    focusManager.setFocused(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rows = [row('queued')];
    let cadence: SessionPromptsCadenceState | undefined;
    let reads = 0;
    const options = (owner: boolean) => ({
      queryKey: ['prompts', 'p1', 's1'],
      queryFn: async () => {
        reads += 1;
        cadence = nextSessionPromptsCadenceState(cadence, rows);
        return rows;
      },
      refetchInterval: (query: { state: { data?: SessionPrompt[] } }) => owner
        ? sessionPromptsPollMs(countNonTerminalSessionPrompts(query.state.data ?? []), undefined, 0, cadence)
        : false,
    });
    const owner = new QueryObserver(client, options(true));
    const follower = new QueryObserver(client, options(false));
    const unsubscribeOwner = owner.subscribe(() => {});
    const unsubscribeFollower = follower.subscribe(() => {});
    await flushPromises();
    await timers.advanceBy(1_000);
    expect(reads).toBe(2);
    expect(sessionPromptsPollMs(1, undefined, 0, cadence)).toBe(2_000);
    unsubscribeFollower();
    unsubscribeOwner();
  });
});

describe('useSessionPrompts production cadence wiring', () => {
  let renderer: ReactTestRenderer | null = null;
  let restoreFakeTimers: (() => void) | undefined;
  let restoreFetch: (() => void) | undefined;
  let client: QueryClient | null = null;

  const queued = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function PromptProbe({ capture }: { capture: (result: UseSessionPromptsResult) => void }) {
    capture(useSessionPrompts('P1', 'S1'));
    return null;
  }

  function renderPrompts(
    ids: readonly string[],
    capture: (result: UseSessionPromptsResult) => void,
  ): void {
    renderer?.update(
      createElement(
        QueryClientProvider,
        { client: client! },
        ids.map((id) => createElement(PromptProbe, { key: id, capture })),
      ),
    );
  }

  beforeEach(() => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    useSessionWorkingStore.getState().reset();
    resetPollOwners();
    resetSessionOpenBundles();
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
    client?.clear();
    client = null;
    restoreFakeTimers?.();
    restoreFakeTimers = undefined;
    restoreFetch?.();
    restoreFetch = undefined;
    environmentManager.setIsServer(() => true);
    focusManager.setFocused(undefined);
    configureKortix({ backendUrl: '', getToken: async () => null });
    useSessionWorkingStore.getState().reset();
    resetPollOwners();
    resetSessionOpenBundles();
  });

  test('focus re-arms the production-owned live interval at one second', async () => {
    const timers = new FakeTimers();
    restoreFakeTimers = timers.install();
    environmentManager.setIsServer(() => false);
    focusManager.setFocused(true);
    let reads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      reads += 1;
      return json({ prompts: [queued()], observed_at: '2026-08-18T10:00:00.000Z' });
    }) as unknown as typeof fetch;
    restoreFetch = () => void (globalThis.fetch = originalFetch);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let promptInbox: UseSessionPromptsResult | null = null;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client: client! }, createElement(PromptProbe, {
          capture: (result) => { promptInbox = result; },
        })),
      );
      await flushPromises();
    });
    expect(promptInbox).not.toBeNull();
    expect(reads).toBe(1);
    expect(timers.activeIntervals()).toBe(1);
    await act(async () => { await timers.advanceBy(1_000); });
    expect(reads).toBe(2);
    await act(async () => { await timers.advanceBy(2_000); });
    expect(reads).toBe(3);

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await flushPromises();
    });
    expect(reads).toBe(4);
    await act(async () => { await timers.advanceBy(999); });
    expect(reads).toBe(4);
    await act(async () => { await timers.advanceBy(1); });
    expect(reads).toBe(5);
  });

  test('two production hooks share one poller, hand it off, and clear cadence after the last unmount', async () => {
    const timers = new FakeTimers();
    restoreFakeTimers = timers.install();
    environmentManager.setIsServer(() => false);
    focusManager.setFocused(true);
    let reads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      reads += 1;
      return json({ prompts: [queued()], observed_at: '2026-08-18T10:00:00.000Z' });
    }) as unknown as typeof fetch;
    restoreFetch = () => void (globalThis.fetch = originalFetch);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let promptInbox: UseSessionPromptsResult | null = null;

    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client: client! },
          createElement(PromptProbe, { key: 'owner', capture: (result) => { promptInbox = result; } }),
          createElement(PromptProbe, { key: 'follower', capture: (result) => { promptInbox = result; } }),
        ),
      );
      await flushPromises();
    });
    expect(promptInbox).not.toBeNull();
    expect(reads).toBe(1);
    expect(timers.activeIntervals()).toBe(1);
    await act(async () => { await timers.advanceBy(1_000); });
    expect(reads).toBe(2);

    await act(async () => {
      renderPrompts(['follower'], (result) => { promptInbox = result; });
      await flushPromises();
    });
    await act(async () => { await timers.advanceBy(1_999); });
    expect(reads).toBe(2);
    await act(async () => { await timers.advanceBy(1); });
    expect(reads).toBe(3);

    await act(async () => {
      renderPrompts([], (result) => { promptInbox = result; });
      await flushPromises();
      renderPrompts(['fresh'], (result) => { promptInbox = result; });
      await flushPromises();
    });
    // A new observer immediately refetches the stale cache entry. That fetch
    // must create fresh cadence state after the prior last-observer cleanup.
    expect(reads).toBe(4);
    await act(async () => { await timers.advanceBy(999); });
    expect(reads).toBe(4);
    await act(async () => { await timers.advanceBy(1); });
    expect(reads).toBe(5);
  });

  test('retry retains its queued row when an older in-flight inbox snapshot resolves later', async () => {
    environmentManager.setIsServer(() => true);
    const failed = queued({ state: 'failed', last_error: 'delivery failed' });
    const deferredReads: Array<(response: Response) => void> = [];
    let promptReads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/retry')) return json(queued());
      if (String(init?.method ?? 'GET') === 'GET' && url.endsWith('/prompts')) {
        promptReads += 1;
        if (promptReads === 1) {
          return json({ prompts: [failed], observed_at: '2026-08-18T10:00:01.000Z' });
        }
        return await new Promise<Response>((resolve) => { deferredReads.push(resolve); });
      }
      throw new Error(`unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
    }) as unknown as typeof fetch;
    restoreFetch = () => void (globalThis.fetch = originalFetch);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let promptInbox: UseSessionPromptsResult | null = null;

    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client: client! }, createElement(PromptProbe, {
          capture: (result) => { promptInbox = result; },
        })),
      );
      await flushPromises();
    });
    expect(client.getQueryData<SessionPrompt[]>(qk.project.sessionPrompts('P1', 'S1'))).toEqual([failed]);

    await act(async () => {
      void promptInbox!.refetch();
      await flushPromises();
    });
    expect(deferredReads).toHaveLength(1);
    let retried: Promise<SessionPrompt> | undefined;
    await act(async () => {
      retried = promptInbox!.retry('p1');
      await flushPromises();
    });
    expect(client.getQueryData<SessionPrompt[]>(qk.project.sessionPrompts('P1', 'S1'))?.[0]?.state).toBe('queued');

    await act(async () => {
      deferredReads.shift()!(json({ prompts: [], observed_at: '2026-08-18T10:00:01.000Z' }));
      await flushPromises();
    });
    expect(client.getQueryData<SessionPrompt[]>(qk.project.sessionPrompts('P1', 'S1'))).toEqual([queued()]);

    // Retry invalidates after success. Its later read is newer and may settle
    // normally; resolve it with the queued row before the mutation finishes.
    await act(async () => {
      deferredReads.shift()!(json({ prompts: [queued()], observed_at: '2026-08-18T10:00:02.000Z' }));
      await flushPromises();
    });
    await act(async () => {
      await retried;
      await flushPromises();
    });
  });
});

/**
 * The inbox is a WORKING signal, not just a list to render.
 *
 * A prompt is durably accepted long before it is a turn — the row still has to
 * be drained and the box may still have to resume. `GET .../turn` answers "no
 * turns" for all of it, honestly, and the composer used to believe that and
 * swap Stop back to Send while the user's prompt sat in the queue. Every read
 * of the list therefore feeds `projectWorking` too.
 */
describe('noteInboxObservation', () => {
  const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  test('records how many rows the server still intends to run, and when it looked', () => {
    useSessionWorkingStore.getState().reset();
    noteInboxObservation('sess_1', [prompt(), prompt({ prompt_id: 'p2', state: 'delivering' })], 500);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 2, atMs: 500 });
  });

  test('a held queue records zero — Stop must put the composer back', () => {
    useSessionWorkingStore.getState().reset();
    noteInboxObservation('sess_1', [prompt({ state: 'waiting', reason: 'held' })], 500);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 0, atMs: 500 });
  });

  test('an older empty stream snapshot cannot erase a newer confirmed queue row', () => {
    useSessionWorkingStore.getState().reset();
    const queued = prompt({ prompt_id: 'p2', client_message_id: 'q_2' });

    expect(applyInboxObservation('sess_1', undefined, [queued], 500)).toEqual([queued]);
    expect(applyInboxObservation('sess_1', [queued], [], 400)).toEqual([queued]);
    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 1, atMs: 500 });
  });

  test('a newer empty snapshot removes a queue row after delivery', () => {
    useSessionWorkingStore.getState().reset();
    const queued = prompt({ prompt_id: 'p2', client_message_id: 'q_2' });

    applyInboxObservation('sess_1', undefined, [queued], 500);

    expect(applyInboxObservation('sess_1', [queued], [], 600)).toEqual([]);
    // The reading also carries WHAT it saw happen: a row this tab had watched
    // waiting is gone, which is the server handing it to the runtime. Without
    // that stamp the two honest-but-stale readings below it (an empty list, a
    // `/turn` read taken before the hand-off) agree on `idle` and the session
    // goes INACTIVE with the prompt in flight.
    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({
      pending: 0,
      atMs: 600,
      drainedAtMs: 600,
    });
  });

  /**
   * The cross-clock race PR #6957's review reproduced, closed at the boundary:
   * every snapshot the SERVER produced ranks on the server's own clock, so a
   * read that STARTED before a POST — however late it settles, whatever the
   * client clock says — can never erase the row that POST confirmed.
   */
  test('a queue read started before the POST cannot erase it after it settles', () => {
    useSessionWorkingStore.getState().reset();
    const confirmed = prompt({ prompt_id: 'srv_1', client_message_id: 'q_9' });

    // POST .../prompts settled at server instant 5_000; the row is durable.
    useSessionWorkingStore.getState().notePromptAccepted('sess_1', 200, 5_000);

    // The slow read was ISSUED at server instant 4_000 (before the write) and
    // settles only now, with a browser stamp newer than everything above.
    expect(applyInboxObservation('sess_1', [confirmed], [], 900, 4_000)).toEqual([confirmed]);
    expect(useSessionWorkingStore.getState().inbox.sess_1?.pending).toBe(1);
  });

  test('a server ten minutes ahead does not get its snapshots rejected or latched', () => {
    useSessionWorkingStore.getState().reset();
    const skew = 10 * 60_000;
    const queued = prompt({ prompt_id: 'p3', client_message_id: 'q_3' });

    // A bundle observed on the API clock (10 min ahead of this tab)…
    applyInboxObservation('sess_1', undefined, [queued], 1_000, 61_000 + skew);
    // …must not outrank the DIRECT read issued right after it: the direct
    // read's server stamp is newer on the one clock that may decide.
    expect(applyInboxObservation('sess_1', [queued], [], 1_500, 62_000 + skew)).toEqual([]);
    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({
      pending: 0,
      atMs: 1_500,
      serverAtMs: 62_000 + skew,
      drainedAtMs: 1_500,
    });
  });
});

/**
 * The first prompt of a brand-new session, as ONE durable POST — the SDK
 * function every "new session" producer calls instead of stashing the text in
 * sessionStorage for a replay effect to send 19-25s later (the measured boot),
 * during which a closed tab lost the message silently.
 */
describe('startSessionWithPrompt', () => {
  test('POSTs the prompt with a minted wire id and files the receipt around the round-trip', async () => {
    useSessionWorkingStore.getState().reset();
    const calls: any[] = [];
    const result = await startSessionWithPrompt(
      'proj-1',
      'sess-1',
      { parts: [{ type: 'text', text: 'go' }], overrides: { agent: 'default' } },
      {
        create: async (projectId, sessionId, input) => {
          // The receipt is taken BEFORE the POST: from here a `/turn` read is
          // barred from answering idle until the row is durable or refused.
          expect(useSessionWorkingStore.getState().receipts['sess-1']).not.toBeNull();
          calls.push([projectId, sessionId, input]);
          return { prompt_id: 'p1', state: 'queued', message_id: input.messageId, deduped: false };
        },
      },
    );

    expect(result.state).toBe('queued');
    expect(calls).toHaveLength(1);
    const [projectId, sessionId, input] = calls[0];
    expect(projectId).toBe('proj-1');
    expect(sessionId).toBe('sess-1');
    expect(input.messageId).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    expect(input.clientMessageId.length).toBeGreaterThan(8);
    // This producer can never read a transcript, so it must say so.
    expect(input.remintOnDelivery).toBe(true);
    expect(input.parts).toEqual([{ type: 'text', text: 'go' }]);
    expect(input.overrides).toEqual({ agent: 'default' });
    // Accepted: the server has the row, and the projection may answer for it.
    const receipt = useSessionWorkingStore.getState().receipts['sess-1'];
    expect(receipt?.acceptedAtMs ?? null).not.toBeNull();
  });

  test('a refused row drops the receipt and throws instead of posing as sent', async () => {
    useSessionWorkingStore.getState().reset();
    await expect(
      startSessionWithPrompt(
        'proj-1',
        'sess-2',
        { parts: [{ type: 'text', text: 'go' }] },
        {
          create: async (_p, _s, input) => ({
            prompt_id: 'p1',
            state: 'failed',
            message_id: input.messageId,
            deduped: true,
          }),
        },
      ),
    ).rejects.toThrow(/refused/i);
    expect(useSessionWorkingStore.getState().receipts['sess-2']).toBeFalsy();
  });

  test('a network failure also drops the receipt', async () => {
    useSessionWorkingStore.getState().reset();
    await expect(
      startSessionWithPrompt(
        'proj-1',
        'sess-3',
        { parts: [{ type: 'text', text: 'go' }] },
        {
          create: async () => {
            throw new Error('boom');
          },
        },
      ),
    ).rejects.toThrow('boom');
    expect(useSessionWorkingStore.getState().receipts['sess-3']).toBeFalsy();
  });
});

/**
 * Enter must paint the queue row IMMEDIATELY. The row is durable only once
 * `POST .../prompts` returns, but the user pressed Enter now: the strip shows
 * an optimistic row (`prompt_id` = `optimistic:<clientMessageId>`, state
 * `queued`) in the same frame, and the server's row replaces it on the
 * response — or it disappears on failure so a refused send never lingers.
 */
describe('optimistic queue rows', () => {
  const input = {
    clientMessageId: 'c1',
    messageId: 'msg_0168552a2001AAAAAAAAAAAAAA',
    parts: [{ type: 'text' as const, text: 'hello there' }, { type: 'file' as const, url: 'x', mime: 'image/png', filename: 'a.png' }],
  };

  test("optimisticSessionPrompt renders the text of the parts, in the strip's shape", () => {
    const row = optimisticSessionPrompt(input, 1_000);
    expect(row.prompt_id).toBe('optimistic:c1');
    expect(row.client_message_id).toBe('c1');
    expect(row.message_id).toBe(input.messageId);
    expect(row.state).toBe('queued');
    expect(row.text).toBe('hello there');
    expect(row.attempts).toBe(0);
    expect(row.created_at).toBe(new Date(1_000).toISOString());
  });

  test('applyOptimisticPrompt appends once and is idempotent for the same submission', () => {
    const a = applyOptimisticPrompt([], input, 1_000);
    const b = applyOptimisticPrompt(a, input, 2_000);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0].prompt_id).toBe('optimistic:c1');
  });

  test('settleOptimisticPrompt swaps the optimistic row for the server row by client id', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    const settled = settleOptimisticPrompt(rows, 'c1', {
      prompt_id: 'p-real',
      state: 'delivering',
      message_id: input.messageId,
      deduped: false,
    });
    expect(settled).toHaveLength(1);
    expect(settled[0].prompt_id).toBe('p-real');
    expect(settled[0].state).toBe('delivering');
    expect(settled[0].text).toBe('hello there');
  });

  test('a failed submission removes the optimistic row', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    expect(removeOptimisticPrompt(rows, 'c1')).toEqual([]);
  });

  test('a real row that already carries the client id wins over a stale optimistic one', () => {
    // The poll can land the server's row before the mutation settles.
    const rows = applyOptimisticPrompt([], input, 1_000);
    const merged = reconcileOptimisticPrompts(rows, [
      { prompt_id: 'p-real', client_message_id: 'c1', message_id: input.messageId, state: 'queued', reason: null, text: 'hello there', attempts: 0, last_error: null, created_at: 'x', available_at: 'x' },
    ]);
    expect(merged.map((r) => r.prompt_id)).toEqual(['p-real']);
  });

  test('reconcile keeps optimistic rows the server has not listed yet (POST still in flight)', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    const merged = reconcileOptimisticPrompts(rows, []);
    expect(merged.map((r) => r.prompt_id)).toEqual(['optimistic:c1']);
  });
});

/**
 * The inbox is PROJECT-scoped, and not every session has a project.
 *
 * A sub-session — the "Agent · general: …" panel `SubSessionModal` opens over
 * the transcript — is a local OpenCode child. It is rendered by `SessionChat`
 * with a `sessionId` and NOTHING else: no project id, no project session id.
 * The `enabled` flag on the query covers react-query's own scheduling, but it
 * is not the only way into the request: `QueryObserver.refetch()` goes
 * straight to `query.fetch()` with no `enabled` check, and `session-chat.tsx`
 * calls `promptInbox.refetch()` the moment a new user bubble lands — which is
 * exactly what a streaming sub-agent produces.
 *
 * The two `undefined`s then went into `listSessionPrompts`'s template literal
 * and came out as text: `GET /projects/undefined/sessions/undefined/prompts`
 * → 400 `Invalid session id` → a red toast beside a sub-agent that was
 * rendering perfectly. The read itself has to refuse, so no path can build
 * that URL.
 */
describe('readSessionPromptsInbox', () => {
  const stubFetch = () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return Response.json({ prompts: [] });
    }) as unknown as typeof fetch;
    return { urls, restore: () => void (globalThis.fetch = original) };
  };

  test('a session with no project issues NO request', async () => {
    const stub = stubFetch();
    try {
      expect(await readSessionPromptsInbox(undefined, undefined, undefined)).toEqual([]);
      expect(await readSessionPromptsInbox(undefined, 'sess-1', undefined)).toEqual([]);
      expect(await readSessionPromptsInbox('proj-1', undefined, undefined)).toEqual([]);
      expect(stub.urls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test('a session with no project keeps the rows already on screen', async () => {
    const stub = stubFetch();
    const cached = applyOptimisticPrompt(
      [],
      { clientMessageId: 'c1', messageId: 'msg_01', parts: [{ type: 'text', text: 'hi' }] },
      1_000,
    );
    try {
      expect(await readSessionPromptsInbox(undefined, undefined, cached)).toEqual(cached);
      expect(stub.urls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test('a project session still reads its own inbox', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetch();
    try {
      expect(await readSessionPromptsInbox('proj-1', 'sess-1', undefined)).toEqual([]);
      expect(stub.urls).toEqual(['http://api.test/v1/projects/proj-1/sessions/sess-1/prompts']);
    } finally {
      stub.restore();
      configureKortix({ backendUrl: '', getToken: async () => null });
    }
  });
});

// ── The session-open bundle seam ────────────────────────────────────────────

describe('readSessionPromptsInbox and the open bundle', () => {
  beforeEach(() => {
    // An earlier case deliberately misconfigures the client to prove the
    // unconfigured path; re-arm here rather than depend on file order.
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  });

  function mockFetch(body: (url: string) => unknown) {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body(String(url))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return urls;
  }

  function bundle(queue: unknown) {
    return {
      observed_at: '2026-08-26T12:00:00.000Z',
      session: { session_id: 'S1' },
      turn: { known: true, turns: [] },
      queue,
      transcript: { known: true, requested: false },
      config: { known: true },
      models: { known: false, reason: 'llm_gateway_disabled' },
    };
  }

  test('answers from the open bundle without touching /prompts', async () => {
    resetSessionOpenBundles();
    const row = { prompt_id: 'p1', state: 'queued', text: 'hi' };
    const urls = mockFetch(() => bundle({ known: true, prompts: [row], held: false }));
    openSessionBundle('P1', 'S1');
    const prompts = await readSessionPromptsInbox('P1', 'S1', undefined);
    expect(urls.filter((u) => u.endsWith('/prompts'))).toHaveLength(0);
    expect(prompts).toEqual([row] as never);
  });

  test('a read that already holds rows never answers from the bundle — it asks', async () => {
    // THE STALE-BUNDLE WINDOW (measured 2026-09-08, on video). The bundle is
    // claimable for OPEN_BUNDLE_SHARE_MS after it lands, and every read inside
    // that window — the 1s poll AND the repair refetch a new user bubble
    // fires — re-claimed it and got the same pre-delivery row back. Meanwhile
    // the drain re-minted the prompt and the runtime echoed it under the new
    // id: the transcript showed the message under M while the "fresh" list
    // still named W, and the prompt was on screen twice until the window
    // expired. The bundle collapses the OPEN burst — reads issued before this
    // tab holds any rows. A read that already has rows is a poll, and a poll
    // asks the server.
    resetSessionOpenBundles();
    const stale = { prompt_id: 'p1', state: 'queued', text: 'hi', message_id: 'msg_W' };
    const urls = mockFetch((url) =>
      url.includes('/snapshot')
        ? bundle({ known: true, prompts: [stale], held: false })
        : { prompts: [], observed_at: '2026-08-26T12:00:01.000Z' },
    );
    openSessionBundle('P1', 'S1');
    const prompts = await readSessionPromptsInbox('P1', 'S1', [stale as never]);
    expect(urls.filter((u) => u.endsWith('/prompts'))).toHaveLength(1);
    expect(prompts).toEqual([]);
  });

  test('the bundled rows still feed the working projection', async () => {
    resetSessionOpenBundles();
    useSessionWorkingStore.getState().clearSession('S1');
    mockFetch(() =>
      bundle({ known: true, prompts: [{ prompt_id: 'p1', state: 'queued' }], held: false }),
    );
    openSessionBundle('P1', 'S1');
    await readSessionPromptsInbox('P1', 'S1', undefined);
    // The inbox observation is what keeps the composer showing Stop while a
    // prompt is durable but not yet a turn. Serving the list from the bundle
    // must not skip it.
    expect(useSessionWorkingStore.getState().inbox.S1?.pending).toBe(1);
  });

  test('the bundle stamps AGE from this tab’s clock and ORDER from the server’s', async () => {
    resetSessionOpenBundles();
    useSessionWorkingStore.getState().clearSession('S1');
    // A server clock ten minutes BEHIND this tab. Stamping age from
    // `observed_at` made this observation expire on arrival
    // (INBOX_OBSERVATION_MAX_MS is 10s), flipping the composer to Send with
    // the prompt still queued.
    const observedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    mockFetch(() => ({
      ...bundle({ known: true, prompts: [{ prompt_id: 'p1', state: 'queued' }], held: false }),
      observed_at: observedAt,
    }));
    openSessionBundle('P1', 'S1');
    const before = Date.now();
    await readSessionPromptsInbox('P1', 'S1', undefined);
    const entry = useSessionWorkingStore.getState().inbox.S1;
    expect(entry?.pending).toBe(1);
    // Age: browser clock at receive time — fresh, not 10 minutes old.
    expect(entry!.atMs).toBeGreaterThanOrEqual(before);
    // Order: the server's own stamp, kept for ranking against other server reads.
    expect(entry?.serverAtMs).toBe(Date.parse(observedAt));
  });

  test('a direct read carries the endpoint’s server stamp into the projection', async () => {
    resetSessionOpenBundles();
    useSessionWorkingStore.getState().clearSession('S2');
    const observedAt = '2026-08-26T12:34:56.000Z';
    mockFetch(() => ({ prompts: [{ prompt_id: 'p1', state: 'queued' }], observed_at: observedAt }));
    const before = Date.now();
    await readSessionPromptsInbox('P1', 'S2', undefined);
    const entry = useSessionWorkingStore.getState().inbox.S2;
    expect(entry?.pending).toBe(1);
    expect(entry!.atMs).toBeGreaterThanOrEqual(before);
    expect(entry?.serverAtMs).toBe(Date.parse(observedAt));
  });

  test('falls back to /prompts when the bundle could not read the inbox', async () => {
    resetSessionOpenBundles();
    const urls = mockFetch((url) =>
      url.includes('/snapshot')
        ? bundle({ known: false, reason: 'inbox read failed' })
        : { prompts: [{ prompt_id: 'p9', state: 'queued' }] },
    );
    openSessionBundle('P1', 'S1');
    const prompts = await readSessionPromptsInbox('P1', 'S1', undefined);
    expect(urls.some((u) => u.endsWith('/prompts'))).toBe(true);
    expect(prompts[0]?.prompt_id).toBe('p9');
  });
});

/**
 * WHICH readings mean "the server took a prompt off the queue".
 *
 * The count alone cannot say. A row that drains and a row the user just put on
 * hold both take the live count to zero, and they are opposites: one means a
 * turn is opening, the other means the user asked for nothing to run. So the
 * signal is the ROW, not the number — and a held or failed row is still listed,
 * which is what makes them distinguishable at all.
 */
describe('inboxDrained', () => {
  const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  test('a queued row that is simply gone is a drain', () => {
    expect(inboxDrained([prompt()], [])).toBe(true);
  });

  test('a delivering row that is gone is a drain too', () => {
    // `delivering` is already at OpenCode, queued behind the turn in front of
    // it. Its disappearance is the ledger confirming a turn consumed it.
    expect(inboxDrained([prompt({ state: 'delivering' })], [])).toBe(true);
  });

  test('a HELD row is still listed, so nothing drained', () => {
    // Stop parks the row (`waiting`/`held`) rather than removing it. Reading
    // that as a drain would put the composer back on Stop with nothing
    // running — exactly what `countLiveInboxPrompts` excludes it to prevent.
    const held = prompt({ state: 'waiting', reason: 'held' });
    expect(inboxDrained([prompt()], [held])).toBe(false);
  });

  test('a row that only FAILED has not drained', () => {
    expect(inboxDrained([prompt()], [prompt({ state: 'failed' })])).toBe(false);
  });

  test("this tab's own optimistic row being replaced is not a drain", () => {
    // The echo arrives under the SERVER's prompt id, so the optimistic row
    // "disappears" on every successful send. That is a rename, not a hand-off.
    const optimistic = optimisticSessionPrompt(
      { clientMessageId: 'q_9', messageId: 'msg_09', parts: [{ type: 'text', text: 'go' }] },
      1_000,
    );
    expect(inboxDrained([optimistic], [prompt({ prompt_id: 'srv_9', client_message_id: 'q_9' })])).toBe(
      false,
    );
  });

  test('nothing to compare against is never a drain', () => {
    expect(inboxDrained(undefined, [])).toBe(false);
    expect(inboxDrained([], [])).toBe(false);
  });

  test('a row that is still there has not drained', () => {
    expect(inboxDrained([prompt()], [prompt()])).toBe(false);
  });
});

describe('the drain stamp survives the readings that follow it', () => {
  const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  test('a later empty reading inherits it — the queue has not changed its mind', () => {
    // The list polls every second while the projection believes something is
    // pending. Without carry-forward the stamp would be erased by the very next
    // poll, one second into a wait for a `/turn` read that takes a round trip.
    useSessionWorkingStore.getState().reset();
    applyInboxObservation('sess_1', undefined, [prompt()], 500);
    applyInboxObservation('sess_1', [prompt()], [], 600);
    applyInboxObservation('sess_1', [], [], 700);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({
      pending: 0,
      atMs: 700,
      drainedAtMs: 600,
    });
  });

  test('a new pending row drops it — this is a fact about an empty queue', () => {
    useSessionWorkingStore.getState().reset();
    applyInboxObservation('sess_1', undefined, [prompt()], 500);
    applyInboxObservation('sess_1', [prompt()], [], 600);
    applyInboxObservation('sess_1', [], [prompt({ prompt_id: 'p2' })], 700);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 1, atMs: 700 });
  });
});
