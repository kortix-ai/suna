import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import type { KeyValueStorage } from '../core/cache/persisted-query-cache';
import { configureKortix } from '../core/http/config';
import type { SessionTranscriptSyncEnvelope } from '../core/rest/projects-client/sessions';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import { createSavedCopyStore, setSavedCopyStore } from '../core/session-sync/saved-copy-store';
import { readSavedSessionCopy } from '../core/session-sync/saved-transcript';
import { useSession } from './opencode';

/**
 * `useSession().savedTranscript` tells a host, before the computer wakes,
 * whether the session's saved conversation is on its way (`loading`), on
 * screen (`shown`), or not coming (`none`). `/start` never answers in any of
 * these tests: the computer stays down, which is the window this covers.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'proj_saved';
const SESSION_ID = '4b9f6c2e-1d3a-4e5b-9c8d-7f6e5d4c3b2a';
const ROOT = 'ses_saved_root';
const originalFetch = globalThis.fetch;

let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  useSyncStore.getState().reset();
  resetSessionOpenBundles();
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
  globalThis.fetch = originalFetch;
});

function row(pin: string | null) {
  return {
    session_id: SESSION_ID,
    project_id: PROJECT_ID,
    account_id: 'acct',
    opencode_session_id: pin,
    metadata: {},
    opencode_sessions: [],
    status: 'stopped',
  };
}

function envelope(saved: boolean) {
  return {
    available: saved,
    reason: null,
    source: saved ? 'mirror' : 'none',
    complete: true,
    captured_at: saved ? '2026-09-25T00:00:00Z' : null,
    opencode_session_id: saved ? ROOT : null,
    message_count: saved ? 1 : 0,
    messages: saved
      ? [
          {
            info: {
              id: 'msg_saved_1',
              sessionID: ROOT,
              role: 'assistant',
              time: { created: 1, completed: 2 },
            },
            parts: [{ id: 'prt_saved_1', type: 'text', text: 'Saved reply' }],
          },
        ]
      : [],
  };
}

function bundle(
  pin: string | null,
  saved: boolean,
  legs: {
    turn?: Record<string, unknown>;
    queue?: Record<string, unknown>;
    /** The saved window the snapshot carries. Default: `envelope(saved)`. */
    transcript?: Record<string, unknown>;
  } = {},
) {
  return {
    observed_at: '2026-09-25T00:00:00Z',
    session: row(pin),
    turn: legs.turn ?? { known: false, reason: 'test' },
    queue: legs.queue ?? { known: false, reason: 'test' },
    transcript: { known: true, requested: true, ...(legs.transcript ?? envelope(saved)) },
    config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: false },
    models: { known: false, reason: 'test' },
  };
}

/** A snapshot read that failed: every consumer falls back to its own route. */
const failedSnapshot = async () => Response.json({ error: 'Not found' }, { status: 404 });

/** Every URL the hook requested, in order. */
let urls: string[] = [];
/** The saved-window reads among them (`/transcript?…`), with or without history. */
const transcriptReads = () => urls.filter((url) => url.includes('/transcript?'));
const snapshotReads = () => urls.filter((url) => url.includes('/snapshot'));

/** Routes the session-open reads; `/start` and anything unlisted never answer. */
function serve(routes: {
  snapshot?: () => Promise<Response>;
  history?: () => Promise<Response>;
  /** The project's stored `experimental` map. Omitted: the project detail
   *  never answers, which saved history must not wait for. */
  experimental?: Record<string, boolean>;
}) {
  const never = () => new Promise<Response>(() => {});
  urls = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.includes('/snapshot')) return (routes.snapshot ?? never)();
    if (url.includes('/transcript?') && url.includes('history=true'))
      return (routes.history ?? never)();
    if (url.includes(`/projects/${PROJECT_ID}/detail`)) {
      if (!routes.experimental) return never();
      return Response.json({
        project: { project_id: PROJECT_ID, experimental: routes.experimental },
        config: {},
      });
    }
    return never();
  }) as unknown as typeof fetch;
}

let latest: ReturnType<typeof useSession> | null = null;

/** The hook's latest answer; throws if the host never rendered. */
function current(): ReturnType<typeof useSession> {
  if (!latest) throw new Error('the host has not rendered');
  return latest;
}

function Host(props: { enabled: boolean; initialPin?: string | null }) {
  latest = useSession(PROJECT_ID, SESSION_ID, {
    enabled: props.enabled,
    replayStartStash: false,
    initialOpenCodeSessionId: props.initialPin ?? null,
    subscribeMessages: false,
  });
  return null;
}

async function mount(props: { enabled: boolean; initialPin?: string | null }) {
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Host, props)),
    );
  });
  await flush();
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

test('before the hook runs (no signed-in user yet) nothing is ruled out', async () => {
  serve({});
  await mount({ enabled: false });
  expect(current().savedTranscript).toBe('loading');
});

test('messages already in the store are shown', async () => {
  serve({});
  useSyncStore.getState().hydrate(
    ROOT,
    [
      {
        info: {
          id: 'msg_live',
          sessionID: ROOT,
          role: 'user',
          time: { created: 1 },
        } as never,
        parts: [],
      },
    ],
    { source: 'cache' },
  );
  await mount({ enabled: false, initialPin: ROOT });
  expect(current().savedTranscript).toBe('shown');
});

test('a saved copy on its way is loading, and shown once it paints', async () => {
  let answer!: (response: Response) => void;
  serve({
    snapshot: () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('loading');
  await act(async () => {
    answer(Response.json(bundle(ROOT, true)));
  });
  await flush();
  expect(current().savedTranscript).toBe('shown');
  expect(current().messages).toHaveLength(1);
});

test('a session whose server holds no saved copy is none', async () => {
  serve({
    snapshot: async () => Response.json(bundle(ROOT, false)),
    history: async () => Response.json(envelope(false)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('none');
});

test('a session with no root anywhere but the runtime is none', async () => {
  serve({
    snapshot: async () => Response.json(bundle(null, false)),
    history: async () => Response.json(envelope(false)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('none');
});

test('a history read that finds nothing is none', async () => {
  serve({
    snapshot: async () => Response.json(bundle(ROOT, false)),
    history: async () => Response.json(envelope(false)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('none');
});

test('the history read paints the copy without waiting for the project detail', async () => {
  // Saved history has no project flag any more, so nothing it needs sits
  // behind the project detail read.
  serve({
    snapshot: failedSnapshot,
    history: async () => Response.json(envelope(true)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('shown');
  expect(current().messages).toHaveLength(1);
});

test('a project that stored the old off override still paints its saved history', async () => {
  serve({
    experimental: { session_transcript_history: false },
    snapshot: failedSnapshot,
    history: async () => Response.json(envelope(true)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('shown');
  expect(current().messages).toHaveLength(1);
});

describe('one saved-history read per open (KRTX-189)', () => {
  // The snapshot carries the saved window; with no snapshot to ride, the
  // history route answers. The sync layer's own read never runs beside it,
  // also when the root is known before the history answers (`initialPin`),
  // which is when it used to.
  afterEach(() => setSavedCopyStore(null));

  function held() {
    let answer!: (response: Response) => void;
    const response = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    return { response, answer: (body: unknown) => answer(Response.json(body)) };
  }

  test('with the snapshot in flight, the snapshot carries the window: no transcript route is read', async () => {
    const snapshot = held();
    serve({ snapshot: snapshot.response, history: async () => Response.json(envelope(true)) });
    await mount({ enabled: true, initialPin: ROOT });
    expect(current().savedTranscript).toBe('loading');
    await act(async () => snapshot.answer(bundle(ROOT, true)));
    await flush();
    expect(current().savedTranscript).toBe('shown');
    expect(current().messages).toHaveLength(1);
    expect(snapshotReads()).toHaveLength(1);
    expect(transcriptReads()).toEqual([]);
  });

  test('with no snapshot to ride, exactly one transcript read answers', async () => {
    serve({ snapshot: failedSnapshot, history: async () => Response.json(envelope(true)) });
    await mount({ enabled: true, initialPin: ROOT });
    expect(current().savedTranscript).toBe('shown');
    expect(transcriptReads()).toHaveLength(1);
    expect(transcriptReads()[0]).toContain('history=true');
  });

  test('a copy read before the bind answers the open: the snapshot asks for the pointer only, and no transcript route is read again', async () => {
    serve({
      snapshot: async () => Response.json(bundle(ROOT, true, { transcript: { requested: false } })),
      history: async () => Response.json(envelope(true)),
    });
    // A connecting view read the copy while the computer woke.
    await readSavedSessionCopy({ projectId: PROJECT_ID, sessionId: SESSION_ID, runtimeSessionId: ROOT });
    expect(transcriptReads()).toHaveLength(1);
    await mount({ enabled: true, initialPin: ROOT });
    expect(current().savedTranscript).toBe('shown');
    expect(current().messages).toHaveLength(1);
    expect(snapshotReads()).toHaveLength(1);
    expect(snapshotReads()[0]).toContain('transcript=0');
    expect(transcriptReads()).toHaveLength(1);
  });

  test('an absent history still resolves to none, with one transcript read', async () => {
    serve({ snapshot: failedSnapshot, history: async () => Response.json(envelope(false)) });
    await mount({ enabled: true, initialPin: ROOT });
    expect(current().savedTranscript).toBe('none');
    expect(transcriptReads()).toHaveLength(1);
  });

  test("the device's copy paints first, and the snapshot's copy reconciles into it with no transcript read", async () => {
    const data = new Map<string, string>();
    const storage: KeyValueStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
    const copies = createSavedCopyStore({ storage, userId: 'user-a' });
    const kept = envelope(true);
    await copies.write(PROJECT_ID, SESSION_ID, {
      ...kept,
      captured_at: '2026-09-24T00:00:00Z',
      message_count: 2,
      messages: [
        { ...kept.messages[0], info: { ...kept.messages[0].info, id: 'msg_device_0', time: { created: 0, completed: 1 } } },
        ...kept.messages,
      ],
    } as unknown as SessionTranscriptSyncEnvelope);
    setSavedCopyStore(copies);
    const snapshot = held();
    serve({ snapshot: snapshot.response });

    await mount({ enabled: true, initialPin: ROOT });
    expect(current().savedTranscript).toBe('shown');
    expect(current().messages).toHaveLength(2);

    await act(async () => snapshot.answer(bundle(ROOT, true)));
    await flush();
    expect(current().messages.some((message) => message.info.id === 'msg_saved_1')).toBe(true);
    expect(transcriptReads()).toEqual([]);
  });
});

describe('an empty conversation', () => {
  // The server's saved copy proves the conversation empty: a complete read of
  // the runtime found no messages. With no turn ever and nothing queued there
  // is nothing to wait for, so a host opens it on its composer.
  const neverRan = { turn: { known: true, turns: [] }, queue: { known: true, prompts: [], held: false } };
  // The snapshot carries the same window the route serves: the saved-history
  // read takes it from whichever answers this open (KRTX-189).
  const provenEmptyCopy = { ...envelope(true), message_count: 0, total: 0, messages: [] };
  const provenEmpty = () => Response.json(provenEmptyCopy);

  test('a saved copy that proves it empty, no turn ever and nothing queued is an empty conversation', async () => {
    serve({
      snapshot: async () => Response.json(bundle(ROOT, false, { ...neverRan, transcript: provenEmptyCopy })),
      history: async () => provenEmpty(),
    });
    await mount({ enabled: true });
    expect(current().savedTranscript).toBe('none');
    expect(current().conversationEmpty).toBe(true);
  });

  test('no saved copy is not an empty conversation, even with no turn on record', async () => {
    // What an older session with history looks like before its first wake:
    // its turns may predate the turn record.
    serve({
      snapshot: async () => Response.json(bundle(ROOT, false, neverRan)),
      history: async () => Response.json(envelope(false)),
    });
    await mount({ enabled: true });
    expect(current().savedTranscript).toBe('none');
    expect(current().conversationEmpty).toBe(false);
  });

  test('a turn that ended outranks an empty saved copy', async () => {
    const ended = {
      ...neverRan,
      turn: {
        known: true,
        turns: [],
        last_ended: { turn_token: 'tok_1', message_id: null, end_reason: 'completed', ended_at: '2026-09-25T00:00:00Z' },
      },
    };
    serve({
      snapshot: async () => Response.json(bundle(ROOT, false, { ...ended, transcript: provenEmptyCopy })),
      history: async () => provenEmpty(),
    });
    await mount({ enabled: true });
    expect(current().conversationEmpty).toBe(false);
  });

  test('an unanswered turn record is an unknown, never an empty, and never the boot screen', async () => {
    serve({
      snapshot: async () => Response.json(bundle(ROOT, false, { transcript: provenEmptyCopy })),
      history: async () => provenEmpty(),
    });
    await mount({ enabled: true });
    expect(current().conversationEmpty).toBe(false);
    // The composer may be one read away: placeholder rows, not a boot screen.
    expect(current().savedTranscript).toBe('loading');
  });
});
