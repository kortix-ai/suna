import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import {
  SAVED_HISTORY_SNAPSHOT_WAIT_MS,
  type SavedTranscriptInput,
  isEmptyConversation,
  loadSavedTranscript,
  readSavedSessionCopy,
  resolveSavedTranscript,
  savedCopyEmptyRoot,
} from './saved-transcript';
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';
import { configureKortix } from '../http/config';
import {
  OPEN_BUNDLE_TRANSCRIPT_LIMIT,
  SAVED_WINDOW_HOLD_MS,
  claimOpenBundle,
  openSessionBundle,
  resetSessionOpenBundles,
} from '../session/open-bundle';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionLog } from '../session-log/types';
import { EMPTY_SESSION_LOG_STATE, applySessionLogPage } from '../session-log/store';
import { sessionLogRoot } from '../session-log/v1-view';

const base: SavedTranscriptInput = {
  enabled: true,
  hasMessages: false,
  history: 'off',
  mirror: 'idle',
  root: 'known',
};

describe('resolveSavedTranscript', () => {
  test('messages on screen are shown, whatever else is still resolving', () => {
    expect(resolveSavedTranscript({ ...base, hasMessages: true })).toBe('shown');
    expect(
      resolveSavedTranscript({ ...base, hasMessages: true, enabled: false, root: 'unknown' }),
    ).toBe('shown');
    expect(resolveSavedTranscript({ ...base, hasMessages: true, history: 'absent' })).toBe('shown');
  });

  test('a hook that has not started yet cannot rule a saved copy out', () => {
    expect(resolveSavedTranscript({ ...base, enabled: false, root: 'unknown' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, enabled: false, mirror: 'absent' })).toBe('loading');
  });

  test('with saved history on, the history read decides', () => {
    expect(resolveSavedTranscript({ ...base, history: 'loading' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, history: 'absent' })).toBe('none');
    expect(resolveSavedTranscript({ ...base, history: 'present', mirror: 'loading' })).toBe(
      'loading',
    );
    // The read found a copy, but the paint refused it (another root).
    expect(resolveSavedTranscript({ ...base, history: 'present', mirror: 'absent' })).toBe('none');
  });

  test('without saved history, the mirror paint decides once the root is known', () => {
    expect(resolveSavedTranscript({ ...base, mirror: 'idle' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, mirror: 'loading' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, mirror: 'absent' })).toBe('none');
  });

  test('a root still resolving waits; a root nothing can supply rules the copy out', () => {
    expect(resolveSavedTranscript({ ...base, root: 'pending' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, root: 'unknown' })).toBe('none');
    expect(resolveSavedTranscript({ ...base, root: 'unknown', history: 'loading' })).toBe(
      'loading',
    );
  });

  test('a copy that proves the conversation empty waits for the turn record: the next surface is the composer or the boot screen', () => {
    // The two reads answer independently. Declaring `none` first would paint
    // the boot screen for the moment until the turn record lands.
    expect(resolveSavedTranscript({ ...base, history: 'absent', emptyAwaitingTurnRead: true })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, history: 'absent', emptyAwaitingTurnRead: false })).toBe('none');
    expect(resolveSavedTranscript({ ...base, hasMessages: true, emptyAwaitingTurnRead: true })).toBe('shown');
  });

  test('invariants hold for every input', () => {
    const histories = ['off', 'loading', 'present', 'absent'] as const;
    const mirrors = ['idle', 'loading', 'painted', 'absent'] as const;
    const roots = ['known', 'pending', 'unknown'] as const;
    let cases = 0;
    for (const enabled of [true, false])
      for (const hasMessages of [true, false])
        for (const history of histories)
          for (const mirror of mirrors)
            for (const root of roots) {
              const input = { enabled, hasMessages, history, mirror, root };
              const answer = resolveSavedTranscript(input);
              cases++;
              // `shown` exactly when there is something to show.
              expect(answer === 'shown').toBe(hasMessages);
              // Nothing is ruled out before the hook runs.
              if (!enabled && !hasMessages) expect(answer).toBe('loading');
              // A read still in flight never rules the copy out.
              if (enabled && !hasMessages && history === 'loading') expect(answer).toBe('loading');
              // A history read that found nothing always rules it out.
              if (enabled && !hasMessages && history === 'absent') expect(answer).toBe('none');
              // A root still resolving is "not yet", never "no".
              if (enabled && !hasMessages && root === 'pending' && history !== 'absent')
                expect(answer).toBe('loading');
            }
    expect(cases).toBe(2 * 2 * 4 * 4 * 3);
  });
});

describe('isEmptyConversation', () => {
  // A session whose saved copy proves it empty has nothing to wait for, so it
  // opens on its composer instead of a boot screen. The proof is the server's:
  // a complete read of the runtime found no messages.
  const ROOT = 'ses_root';
  const empty = {
    savedEmptyRoot: ROOT,
    rootSessionId: ROOT,
    turnRead: true,
    hasEndedTurn: false,
    hasOpenOrQueuedTurn: false,
  };

  test('a saved copy that proves this root empty, no turn ever, nothing queued: empty', () => {
    expect(isEmptyConversation(empty)).toBe(true);
  });

  test('no saved copy is not evidence: a session may have run turns no record kept', () => {
    // The turn ledger exists since 2026-08-17 and its writes are best-effort,
    // so "no turn ever ended" is also what an older session with history says.
    expect(isEmptyConversation({ ...empty, savedEmptyRoot: null })).toBe(false);
  });

  test('an empty copy of another root says nothing about this one', () => {
    expect(isEmptyConversation({ ...empty, rootSessionId: 'ses_repinned' })).toBe(false);
    expect(isEmptyConversation({ ...empty, rootSessionId: '' })).toBe(false);
  });

  test('a turn that ended outranks the saved copy: the copy is older than it', () => {
    expect(isEmptyConversation({ ...empty, hasEndedTurn: true })).toBe(false);
  });

  test('an open or queued turn is a conversation starting', () => {
    expect(isEmptyConversation({ ...empty, hasOpenOrQueuedTurn: true })).toBe(false);
  });

  test('an unanswered turn read is an unknown, never an empty', () => {
    expect(isEmptyConversation({ ...empty, turnRead: false })).toBe(false);
  });
});

describe('savedCopyEmptyRoot', () => {
  // The server's proof that a conversation is empty: a complete, available
  // saved window that counts zero messages, named by the root it was read from.
  const window = (fields: Partial<SessionTranscriptSyncEnvelope> = {}) =>
    ({
      available: true,
      reason: null,
      source: 'mirror',
      complete: true,
      captured_at: '2026-09-28T00:00:00Z',
      opencode_session_id: 'ses_root',
      message_count: 0,
      total: 0,
      messages: [],
      ...fields,
    }) as SessionTranscriptSyncEnvelope;

  test('a complete, available window that counts zero names its root', () => {
    expect(savedCopyEmptyRoot(window())).toBe('ses_root');
  });

  test('anything short of that proves nothing', () => {
    expect(savedCopyEmptyRoot(null)).toBeNull();
    expect(savedCopyEmptyRoot(undefined)).toBeNull();
    expect(savedCopyEmptyRoot(window({ complete: false }))).toBeNull();
    expect(savedCopyEmptyRoot(window({ available: false, source: 'none' }))).toBeNull();
    // An older API sends no total, and never an available empty window.
    expect(savedCopyEmptyRoot(window({ total: undefined }))).toBeNull();
    expect(savedCopyEmptyRoot(window({ total: 1 }))).toBeNull();
    expect(savedCopyEmptyRoot(window({ opencode_session_id: null }))).toBeNull();
    expect(
      savedCopyEmptyRoot(
        window({ messages: [{ info: { id: 'msg_1' }, parts: [] }] as SessionTranscriptSyncEnvelope['messages'] }),
      ),
    ).toBeNull();
  });

  test('both rules are public, so every host decides an empty conversation the same way', async () => {
    const sdk = await import('../../index');
    expect(sdk.savedCopyEmptyRoot).toBe(savedCopyEmptyRoot);
    expect(sdk.isEmptyConversation).toBe(isEmptyConversation);
  });
});

describe('readSavedSessionCopy', () => {
  // A host that shows a session before `useSession` binds it (the mobile
  // connecting view) reads the saved copy through the same read `useSession`
  // makes, and asks the SDK whether the conversation is proven empty.
  const ROOT = 'ses_root_1';
  const originalFetch = globalThis.fetch;
  const copy = (count: number, fields: Record<string, unknown> = {}) => ({
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-09-26T10:00:00Z',
    opencode_session_id: ROOT,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => ({
      info: { id: `msg_${i + 1}`, sessionID: ROOT, role: 'assistant', time: { created: i + 1 } },
      parts: [{ id: `prt_${i + 1}`, type: 'text', text: `message ${i + 1}` }],
    })),
    ...fields,
  });
  const provenEmpty = copy(0, { total: 0 });
  const read = () => readSavedSessionCopy({ projectId: 'p1', sessionId: 's1', runtimeSessionId: ROOT });

  /** Answers each URL with `route(url)` as JSON; records every URL. */
  function serve(route: (url: string) => unknown): string[] {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return Response.json(route(url));
    }) as unknown as typeof fetch;
    return urls;
  }

  beforeEach(() => {
    resetSessionOpenBundles();
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionOpenBundles();
  });

  test('reads the saved-history route once and answers its copy', async () => {
    const urls = serve(() => copy(3));
    const answer = await read();
    expect(answer.envelope?.message_count).toBe(3);
    expect(answer.empty).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/projects/p1/sessions/s1/transcript?shape=sync');
    expect(urls[0]).toContain('history=true');
  });

  test('a session-open snapshot in flight carries the copy: no transcript request', async () => {
    const urls = serve((url) =>
      url.includes('/snapshot')
        ? {
            observed_at: '2026-09-26T10:00:01Z',
            session: { session_id: 's1', runtime_session_id: ROOT, opencode_session_id: ROOT },
            turn: { known: false, reason: 'test' },
            queue: { known: false, reason: 'test' },
            transcript: { known: true, requested: true, ...copy(2) },
            config: { known: true },
            models: { known: false, reason: 'test' },
          }
        : copy(9),
    );
    openSessionBundle('p1', 's1');
    const answer = await read();
    expect(answer.envelope?.message_count).toBe(2);
    expect(urls.filter((url) => url.includes('/transcript'))).toHaveLength(0);
  });

  test('a failed read answers nothing, and never throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await read()).toEqual({ envelope: null, empty: false });
  });

  test('without ids nothing is read', async () => {
    const urls = serve(() => copy(1));
    expect(await readSavedSessionCopy({ projectId: 'p1', sessionId: 's1', runtimeSessionId: '' })).toEqual({
      envelope: null,
      empty: false,
    });
    expect(urls).toHaveLength(0);
  });

  test('a copy that proves this root empty, and no turn on record, is empty', async () => {
    serve((url) => (url.includes('/turn') ? { turns: [] } : provenEmpty));
    expect((await read()).empty).toBe(true);
  });

  test('a turn that ended since, or one open, outranks the empty copy', async () => {
    serve((url) =>
      url.includes('/turn')
        ? { turns: [], last_ended: { turn_token: 't1', end_reason: 'completed', ended_at: '2026-09-28T00:00:00Z' } }
        : provenEmpty,
    );
    expect((await read()).empty).toBe(false);
    serve((url) => (url.includes('/turn') ? { turns: [{ turn_token: 't2', state: 'running' }] } : provenEmpty));
    expect((await read()).empty).toBe(false);
  });

  test('an unanswered turn record is an unknown, never an empty', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/turn')) throw new TypeError('Network request failed');
      return Response.json(provenEmpty);
    }) as unknown as typeof fetch;
    const answer = await read();
    expect(answer.empty).toBe(false);
    expect(answer.envelope?.total).toBe(0);
  });

  test('no saved copy is not evidence, and the turn record is not read for it', async () => {
    const urls = serve(() => copy(0, { available: false, source: 'none' }));
    expect((await read()).empty).toBe(false);
    expect(urls.some((url) => url.includes('/turn'))).toBe(false);
  });

  test('an empty copy of another root proves nothing about this one', async () => {
    const urls = serve(() => ({ ...provenEmpty, opencode_session_id: 'ses_other_root' }));
    expect((await read()).empty).toBe(false);
    expect(urls.some((url) => url.includes('/turn'))).toBe(false);
  });

  test('is public, so a host reads the saved copy the way useSession does', async () => {
    const sdk = await import('../../index');
    expect(sdk.readSavedSessionCopy).toBe(readSavedSessionCopy);
  });

  describe("the session's next open reuses the copy (KRTX-189)", () => {
    // The connecting view reads the window while the computer wakes; the
    // thread that opens next must not download it again, neither in the
    // session-open snapshot nor in its own saved-history read.
    const pointerOnly = {
      observed_at: '2026-09-26T10:00:01Z',
      session: { session_id: 's1', runtime_session_id: ROOT, opencode_session_id: ROOT },
      turn: { known: false, reason: 'test' },
      queue: { known: false, reason: 'test' },
      transcript: { known: true, requested: false },
      config: { known: true },
      models: { known: false, reason: 'test' },
    };
    /** The snapshot answers the pointer only; the saved-history route, `copy(3)`. */
    const serveOpen = () => serve((url) => (url.includes('/snapshot') ? pointerOnly : copy(3)));
    /** Starts the session-open snapshot and waits until it answered. */
    const open = async (sessionId: string) => {
      openSessionBundle('p1', sessionId);
      await claimOpenBundle('p1', sessionId);
    };
    const snapshots = (urls: string[]) => urls.filter((url) => url.includes('/snapshot'));
    const windows = (urls: string[]) => urls.filter((url) => url.includes('/transcript?'));

    afterEach(() => setSystemTime());

    test('the snapshot asks for the pointer only, and the saved-history read sends nothing', async () => {
      const urls = serveOpen();
      await read();
      await open('s1');
      const answer = await loadSavedTranscript('p1', 's1');
      expect(answer.message_count).toBe(3);
      expect(snapshots(urls)).toHaveLength(1);
      expect(snapshots(urls)[0]).toContain('transcript=0');
      expect(windows(urls)).toHaveLength(1);
    });

    test('the held copy covers one wake: past the bound, the next open reads the window again', async () => {
      expect(SAVED_WINDOW_HOLD_MS).toBeGreaterThanOrEqual(4 * 60_000);
      const urls = serveOpen();
      const start = Date.now();
      setSystemTime(new Date(start));
      await read();
      setSystemTime(new Date(start + SAVED_WINDOW_HOLD_MS + 1));
      await open('s1');
      expect(snapshots(urls)[0]).toContain(`transcript=${OPEN_BUNDLE_TRANSCRIPT_LIMIT}`);
      await loadSavedTranscript('p1', 's1');
      expect(windows(urls)).toHaveLength(2);
    });

    test('each connecting view reads the current copy: a held one never answers it', async () => {
      const urls = serveOpen();
      await read();
      await read();
      expect(windows(urls)).toHaveLength(2);
    });

    test('a failed read holds nothing: the next open asks the snapshot for the window', async () => {
      globalThis.fetch = mock(async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch;
      await read();
      const urls = serveOpen();
      await open('s1');
      expect(snapshots(urls)[0]).toContain(`transcript=${OPEN_BUNDLE_TRANSCRIPT_LIMIT}`);
    });

    test('a copy held for one session answers no other', async () => {
      const urls = serveOpen();
      await read();
      await open('s2');
      expect(snapshots(urls)[0]).toContain(`transcript=${OPEN_BUNDLE_TRANSCRIPT_LIMIT}`);
      await loadSavedTranscript('p1', 's2');
      expect(windows(urls)).toHaveLength(2);
    });
  });
});

describe('loadSavedTranscript', () => {
  // The read waits for a session-open snapshot in flight, because the snapshot
  // carries the same window. It never waits on a hung one: past
  // SAVED_HISTORY_SNAPSHOT_WAIT_MS the route answers.
  const ROOT = 'ses_wait_root';
  const originalFetch = globalThis.fetch;
  const window = {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-09-26T10:00:00Z',
    opencode_session_id: ROOT,
    message_count: 1,
    messages: [{ info: { id: 'msg_1', sessionID: ROOT, role: 'assistant', time: { created: 1 } }, parts: [] }],
  };

  beforeEach(() => {
    resetSessionOpenBundles();
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionOpenBundles();
  });

  test('the bound is a few seconds: long enough for a snapshot, short enough for a hung one', () => {
    expect(SAVED_HISTORY_SNAPSHOT_WAIT_MS).toBeGreaterThanOrEqual(1_000);
    expect(SAVED_HISTORY_SNAPSHOT_WAIT_MS).toBeLessThanOrEqual(3_000);
  });

  test('a snapshot slower than the wait loses to the saved-history route', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.includes('/snapshot')) return new Promise<Response>(() => {});
      return Response.json(window);
    }) as unknown as typeof fetch;
    openSessionBundle('p1', 's1');
    const answer = await loadSavedTranscript('p1', 's1', { snapshotWaitMs: 20 });
    expect(answer.messages).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/transcript?') && url.includes('history=true'))).toHaveLength(1);
  });
});

describe('readSavedSessionCopy with the session log (`session_log` on, P8)', () => {
  // With the project flag on the session log is the saved copy: the connecting view paints
  // its newest page, and no v1 window (`GET …/transcript`) is read.
  const originalFetch = globalThis.fetch;
  const golden: SessionLog = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
  );
  const root = golden.threads.find((thread) => thread.parent_thread_id === null)!;
  const page = (fields: Record<string, unknown> = {}) => {
    const { threads, ...session } = structuredClone(golden);
    return {
      session,
      generation: 1,
      threads: threads.map(({ messages: _m, ...head }) => head),
      thread_id: root.thread_id,
      messages: root.messages,
      has_more: true,
      ...fields,
    };
  };
  const emptyPage = page({ messages: [], has_more: false });
  const rootRuntimeId = sessionLogRoot(applySessionLogPage(EMPTY_SESSION_LOG_STATE, emptyPage as never))!.runtimeSessionId!;
  const read = () =>
    readSavedSessionCopy({ projectId: 'p1', sessionId: 's1', runtimeSessionId: rootRuntimeId, sessionLog: true });

  function serve(route: (url: string) => Response): string[] {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return route(url);
    }) as unknown as typeof fetch;
    return urls;
  }

  beforeEach(() => {
    resetSessionOpenBundles();
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionOpenBundles();
  });

  test("reads the log's newest page once, and no v1 window", async () => {
    const urls = serve(() => Response.json(page()));
    const answer = await read();
    expect(answer.log?.thread_id).toBe(root.thread_id);
    expect(answer.log?.messages).toHaveLength(root.messages.length);
    expect(answer.envelope).toBeNull();
    expect(answer.empty).toBe(false);
    expect(urls).toEqual(['http://test.local/v1/projects/p1/sessions/s1/log?limit=40']);
  });

  test('a page that proves the root empty, and no turn on record, is empty', async () => {
    const urls = serve((url) => Response.json(url.includes('/turn') ? { turns: [] } : emptyPage));
    expect((await read()).empty).toBe(true);
    expect(urls.some((url) => url.includes('/transcript'))).toBe(false);
  });

  test('a turn that ended since outranks the empty page', async () => {
    serve((url) =>
      Response.json(url.includes('/turn') ? { turns: [], last_ended: { turn_token: 't1', end_reason: 'completed', ended_at: '2026-09-28T00:00:00Z' } } : emptyPage),
    );
    expect((await read()).empty).toBe(false);
  });

  test('an empty page of another root proves nothing about this one', async () => {
    const urls = serve(() => Response.json(emptyPage));
    const answer = await readSavedSessionCopy({ projectId: 'p1', sessionId: 's1', runtimeSessionId: 'ses_child', sessionLog: true });
    expect(answer.empty).toBe(false);
    expect(urls.some((url) => url.includes('/turn'))).toBe(false);
  });

  test('no stored log (404) answers no copy, and still reads no v1 window', async () => {
    const urls = serve(() => Response.json({ error: 'No session log for this session' }, { status: 404 }));
    expect(await read()).toEqual({ envelope: null, empty: false, log: null });
    expect(urls.some((url) => url.includes('/transcript'))).toBe(false);
  });
});
