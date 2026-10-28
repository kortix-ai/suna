import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  type SavedTranscriptInput,
  isEmptyConversation,
  readSavedSessionCopy,
  resolveSavedTranscript,
  savedCopyEmptyRoot,
} from './saved-transcript';
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';
import { configureKortix } from '../http/config';
import { resetSessionOpenBundles } from '../session/open-bundle';
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

describe('readSavedSessionCopy reads the session log first (P8)', () => {
  // The session log is the saved copy: the connecting view paints its newest page, and no v1
  // window (`GET …/transcript`) is read. The project flag is not read; `sessionLog` is ignored.
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

  test('without `sessionLog` (the flag unknown or off) the log is still read first, and no v1 window', async () => {
    for (const sessionLog of [undefined, false]) {
      const urls = serve(() => Response.json(page()));
      const answer = await readSavedSessionCopy({ projectId: 'p1', sessionId: 's1', runtimeSessionId: rootRuntimeId, sessionLog });
      expect(answer.log?.thread_id).toBe(root.thread_id);
      expect(answer.envelope).toBeNull();
      expect(urls).toEqual(['http://test.local/v1/projects/p1/sessions/s1/log?limit=40']);
    }
  });

  test('a new session on an API that serves the log (404 session_log_missing): no copy, and no v1 window', async () => {
    const urls = serve(() => Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 }));
    expect(await read()).toEqual({ envelope: null, empty: false, log: null });
    expect(urls).toEqual(['http://test.local/v1/projects/p1/sessions/s1/log?limit=40']);
  });

  test.each([
    ['a 404 without a code', () => Response.json({ error: 'No session log for this session' }, { status: 404 })],
    ['a 500', () => Response.json({ error: 'Internal Server Error' }, { status: 500 })],
    ['an invalid page', () => Response.json(page({ messages: [{ seq: 'x' }] }))],
  ] as const)('GET …/log answers %s: no copy, and no v1 window (P8.3)', async (_name, answer) => {
    const urls = serve((url) => (url.includes('/log?') ? answer() : Response.json({ available: true, source: 'mirror', messages: [] })));
    expect(await read()).toEqual({ envelope: null, empty: false, log: null });
    expect(urls).toEqual(['http://test.local/v1/projects/p1/sessions/s1/log?limit=40']);
  });
});
