import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import { configureKortix } from '../core/http/config';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
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

function bundle(pin: string | null, saved: boolean) {
  return {
    observed_at: '2026-09-25T00:00:00Z',
    session: row(pin),
    turn: { known: false, reason: 'test' },
    queue: { known: false, reason: 'test' },
    transcript: { known: true, requested: true, ...envelope(saved) },
    config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: false },
    models: { known: false, reason: 'test' },
  };
}

/** Routes the session-open reads; `/start` and anything unlisted never answer. */
function serve(routes: {
  snapshot?: () => Promise<Response>;
  history?: () => Promise<Response>;
  historyFlag?: boolean;
  /** The project detail (it carries the flag) never answers. */
  flagUnknown?: boolean;
}) {
  const never = () => new Promise<Response>(() => {});
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/snapshot')) return (routes.snapshot ?? never)();
    if (url.includes('/transcript?') && url.includes('history=true'))
      return (routes.history ?? never)();
    if (url.includes(`/projects/${PROJECT_ID}/detail`)) {
      if (routes.flagUnknown) return never();
      return Response.json({
        project: {
          project_id: PROJECT_ID,
          experimental: { session_transcript_history: routes.historyFlag === true },
        },
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
  serve({ snapshot: async () => Response.json(bundle(ROOT, false)) });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('none');
});

test('a session with no root anywhere but the runtime is none', async () => {
  serve({ snapshot: async () => Response.json(bundle(null, false)) });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('none');
});

test('with saved history on, a history read that finds nothing is none', async () => {
  serve({
    historyFlag: true,
    snapshot: async () => Response.json(bundle(ROOT, false)),
    history: async () => Response.json(envelope(false)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('none');
});

test('with saved history on, the history read paints the copy', async () => {
  serve({
    historyFlag: true,
    snapshot: () => new Promise<Response>(() => {}),
    history: async () => Response.json(envelope(true)),
  });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('shown');
  expect(current().messages).toHaveLength(1);
});

test('while the saved-history flag is unknown, a copy is not ruled out', async () => {
  // Deciding `none` from the flag-off path and then re-deciding once the flag
  // answers would flip the host from its boot screen back to placeholder rows.
  serve({ flagUnknown: true, snapshot: async () => Response.json(bundle(ROOT, false)) });
  await mount({ enabled: true });
  expect(current().savedTranscript).toBe('loading');
});
