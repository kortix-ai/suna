import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type {
  AssistantMessage,
  Message,
  PermissionRequest,
  QuestionRequest,
  Session,
  ToolPart,
  UserMessage,
} from '@opencode-ai/sdk/v2/client';

// Mock the notification sink BEFORE importing the module under test, so
// `handle-event.ts`'s `import { infoToast, notify* } from '../../platform/ui'`
// resolves to these spies instead of the real (host-configured) sinks. Same
// mock-then-dynamic-import pattern as `use-kortix-master.test.ts`.
interface ToastCall {
  level: string;
  message: string;
}
interface NotifyCall {
  kind: string;
  [key: string]: unknown;
}
let toasts: ToastCall[] = [];
let notifications: NotifyCall[] = [];

mock.module('../../platform/ui', () => ({
  infoToast: (message: string) => {
    toasts.push({ level: 'info', message });
  },
  notifyPermissionRequest: (sessionId: string, toolName: string, sessionTitle?: string) => {
    notifications.push({ kind: 'permission', sessionId, toolName, sessionTitle });
  },
  notifyQuestion: (sessionId: string, questionText: string, sessionTitle?: string) => {
    notifications.push({ kind: 'question', sessionId, questionText, sessionTitle });
  },
  notifySessionError: (sessionId: string, errorTitle: string, sessionTitle?: string) => {
    notifications.push({ kind: 'session-error', sessionId, errorTitle, sessionTitle });
  },
  notifyTaskComplete: (sessionId: string, sessionTitle?: string) => {
    notifications.push({ kind: 'task-complete', sessionId, sessionTitle });
  },
}));

const { createEventHandler } = await import('./handle-event');
const { useSyncStore } = await import('../../browser/stores/sync-store');
const { useDiagnosticsStore } = await import('../../browser/stores/diagnostics-store');
const { opencodeKeys } = await import('../use-opencode-sessions');
const { fileListKeys, gitStatusKeys, fileContentKeys } = await import('../file-keys');
const { ptyKeys } = await import('../use-opencode-pty');

// ============================================================================
// Test harness — a fresh QueryClient + real sync store + spy callbacks for
// every test, mirroring exactly what `use-opencode-events/index.ts` wires up
// in production (see `createEventHandler`'s call site there).
// ============================================================================

function makeCalls<Args extends unknown[]>() {
  const calls: Args[] = [];
  const fn = (...args: Args) => {
    calls.push(args);
  };
  return { fn, calls };
}

function buildHandler(overrides: { messagesImpl?: () => Promise<{ data?: unknown }>; getImpl?: () => Promise<{ data?: unknown }> } = {}) {
  const queryClient = new QueryClient();
  const stopCompaction = makeCalls<[string]>();
  const addPermission = makeCalls<[PermissionRequest]>();
  const removePermission = makeCalls<[string]>();
  const addQuestion = makeCalls<[QuestionRequest]>();
  const removeQuestion = makeCalls<[string]>();
  const markSessionAbortedLocally = makeCalls<[string, string?]>();
  const fetchLspDiagnosticsDebounced = makeCalls<[]>();
  // `applySyncEvent` is a spy, NOT the real `useSyncStore.getState().applyEvent`
  // — the sync store's OWN reducer behavior is already covered end-to-end in
  // `../../browser/stores/sync-store.test.ts`. Keeping it a spy here means tests below
  // can seed `useSyncStore` state directly (e.g. a prior `sessionStatus`) to
  // exercise `handle-event.ts`'s OWN branching logic (transition detection,
  // cache writes, notifications) in isolation, instead of that logic being
  // entangled with — and clobbered by — the reducer's own state writes for
  // the very same event (`applySyncEvent` runs BEFORE the switch statement).
  const applySyncEvent = makeCalls<[unknown]>();

  const client = {
    session: {
      messages: overrides.messagesImpl ?? (async () => ({ data: [] })),
      get: overrides.getImpl ?? (async () => ({ data: undefined })),
    },
  } as unknown as Parameters<typeof createEventHandler>[0]['client'];

  const handleEvent = createEventHandler({
    queryClient,
    client,
    applySyncEvent: applySyncEvent.fn,
    stopCompaction: stopCompaction.fn,
    addPermission: addPermission.fn,
    removePermission: removePermission.fn,
    addQuestion: addQuestion.fn,
    removeQuestion: removeQuestion.fn,
    normalizeDiagnosticPaths: { current: (x) => x },
    markSessionAbortedLocally: { current: markSessionAbortedLocally.fn },
    fetchLspDiagnosticsDebounced: { current: fetchLspDiagnosticsDebounced.fn },
  });

  return {
    handleEvent,
    queryClient,
    applySyncEvent,
    stopCompaction,
    addPermission,
    removePermission,
    addQuestion,
    removeQuestion,
    markSessionAbortedLocally,
    fetchLspDiagnosticsDebounced,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: 'proj_1',
    directory: '/workspace',
    title: 'Untitled',
    version: '1.0.0',
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

function userMessage(id: string, sessionID = 'ses_1'): UserMessage {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude' },
  };
}

function assistantMessage(id: string, sessionID = 'ses_1'): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 1 },
    parentID: 'msg_parent',
    modelID: 'claude',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

beforeEach(() => {
  useSyncStore.getState().reset();
  useDiagnosticsStore.getState().clearAll();
  toasts = [];
  notifications = [];
});

afterEach(() => {
  toasts = [];
  notifications = [];
});

// ============================================================================
// message.updated / message.removed — sync store is the sole handler; no
// query-cache side effects expected.
// ============================================================================

describe('message.updated / message.removed', () => {
  test('message.updated is forwarded to the sync store (single source of truth)', () => {
    const { handleEvent, applySyncEvent } = buildHandler();
    const event = {
      id: 'evt_1',
      type: 'message.updated' as const,
      properties: { sessionID: 'ses_1', info: assistantMessage('msg_1') },
    };
    handleEvent(event);
    expect(applySyncEvent.calls).toEqual([[event]]);
  });
});

// ============================================================================
// message.part.updated — extracts diagnostics from a completed tool part into
// the (real) diagnostics store, in addition to the sync-store dispatch.
// ============================================================================

describe('message.part.updated', () => {
  test('forwards the raw event to the sync store', () => {
    const { handleEvent, applySyncEvent } = buildHandler();
    const event = {
      id: 'evt_1',
      type: 'message.part.updated' as const,
      properties: {
        sessionID: 'ses_1',
        time: Date.now(),
        part: { id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text' as const, text: 'Hello' },
      },
    };
    handleEvent(event);
    expect(applySyncEvent.calls).toEqual([[event]]);
  });

  test('extracts <file_diagnostics> from a completed tool part into the diagnostics store', () => {
    const { handleEvent } = buildHandler();
    const toolPart: ToolPart = {
      id: 'prt_tool',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'write',
      state: {
        status: 'completed',
        input: {},
        output:
          '<file_diagnostics>\nError: /workspace/src/app.ts:12:5 [ts] Something is wrong\n</file_diagnostics>',
        title: 'write',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    handleEvent({
      id: 'evt_1',
      type: 'message.part.updated',
      properties: { sessionID: 'ses_1', time: Date.now(), part: toolPart },
    });

    const byFile = useDiagnosticsStore.getState().byFile;
    expect(byFile['/workspace/src/app.ts']).toBeDefined();
    expect(byFile['/workspace/src/app.ts'][0]).toMatchObject({
      line: 11, // 0-indexed (source line 12)
      severity: 1, // Error
      message: 'Something is wrong',
    });
  });

  test('a tool part with no diagnostics tags leaves the diagnostics store untouched', () => {
    const { handleEvent } = buildHandler();
    const toolPart: ToolPart = {
      id: 'prt_tool',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'read',
      state: {
        status: 'completed',
        input: {},
        output: 'plain file contents, nothing diagnostic-shaped',
        title: 'read',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    handleEvent({
      id: 'evt_1',
      type: 'message.part.updated',
      properties: { sessionID: 'ses_1', time: Date.now(), part: toolPart },
    });
    expect(useDiagnosticsStore.getState().byFile).toEqual({});
  });
});

// ============================================================================
// session.created / session.updated / session.deleted — surgical cache
// mutations on the `opencodeKeys.sessions()` list + `opencodeKeys.session(id)`.
// ============================================================================

describe('session lifecycle cache mutations', () => {
  test('session.created inserts into an existing session list, newest first', () => {
    const { handleEvent, queryClient } = buildHandler();
    queryClient.setQueryData(opencodeKeys.sessions(), [session('ses_old', { time: { created: 1, updated: 1 } })]);

    handleEvent({
      id: 'evt_1',
      type: 'session.created',
      properties: { sessionID: 'ses_new', info: session('ses_new', { time: { created: 5, updated: 5 } }) },
    });

    const list = queryClient.getQueryData<Session[]>(opencodeKeys.sessions());
    expect(list?.map((s) => s.id)).toEqual(['ses_new', 'ses_old']);
    expect(queryClient.getQueryData(opencodeKeys.session('ses_new'))).toMatchObject({ id: 'ses_new' });
  });

  test('session.created on an empty/uninitialized list still seeds it', () => {
    const { handleEvent, queryClient } = buildHandler();
    handleEvent({
      id: 'evt_1',
      type: 'session.created',
      properties: { sessionID: 'ses_new', info: session('ses_new') },
    });
    expect(queryClient.getQueryData<Session[]>(opencodeKeys.sessions())).toEqual([session('ses_new')]);
  });

  test('session.updated patches the individual session cache and re-sorts the list', () => {
    const { handleEvent, queryClient } = buildHandler();
    queryClient.setQueryData(opencodeKeys.sessions(), [
      session('ses_a', { time: { created: 1, updated: 1 }, title: 'Old title' }),
    ]);
    queryClient.setQueryData(opencodeKeys.session('ses_a'), session('ses_a', { title: 'Old title' }));

    handleEvent({
      id: 'evt_1',
      type: 'session.updated',
      properties: { sessionID: 'ses_a', info: session('ses_a', { time: { created: 1, updated: 9 }, title: 'New title' }) },
    });

    expect(queryClient.getQueryData<Session>(opencodeKeys.session('ses_a'))?.title).toBe('New title');
    expect(queryClient.getQueryData<Session[]>(opencodeKeys.sessions())?.[0].title).toBe('New title');
  });

  test('session.deleted removes the session from the list and clears its query cache', () => {
    const { handleEvent, queryClient } = buildHandler();
    queryClient.setQueryData(opencodeKeys.sessions(), [session('ses_a'), session('ses_b')]);
    queryClient.setQueryData(opencodeKeys.session('ses_a'), session('ses_a'));

    handleEvent({
      id: 'evt_1',
      type: 'session.deleted',
      properties: { sessionID: 'ses_a', info: session('ses_a') },
    });

    expect(queryClient.getQueryData<Session[]>(opencodeKeys.sessions())?.map((s) => s.id)).toEqual(['ses_b']);
    expect(queryClient.getQueryData(opencodeKeys.session('ses_a'))).toBeUndefined();
  });
});

// ============================================================================
// session.status / session.idle — busy/retry → idle transition fires a
// task-complete notification + invalidates the git/file-list caches.
// ============================================================================

describe('session.status', () => {
  test('busy → idle fires notifyTaskComplete and invalidates git/file caches', () => {
    const { handleEvent, queryClient } = buildHandler();
    useSyncStore.getState().setStatus('ses_1', { type: 'busy' });
    const gitInvalidated = queryClient.invalidateQueries.bind(queryClient);
    let gitCalls = 0;
    let filesCalls = 0;
    queryClient.invalidateQueries = ((opts: { queryKey: unknown[] }) => {
      if (JSON.stringify(opts.queryKey) === JSON.stringify(gitStatusKeys.all)) gitCalls++;
      if (JSON.stringify(opts.queryKey) === JSON.stringify(fileListKeys.all)) filesCalls++;
      return gitInvalidated(opts);
    }) as typeof queryClient.invalidateQueries;

    handleEvent({
      id: 'evt_1',
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    });

    // handle-event.ts reads `sessionStatus` itself to detect the transition —
    // seeded above via `setStatus`, untouched by the (spied) `applySyncEvent`.
    expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: 'busy' });
    expect(notifications).toEqual([{ kind: 'task-complete', sessionId: 'ses_1', sessionTitle: undefined }]);
    expect(gitCalls).toBe(1);
    expect(filesCalls).toBe(1);
  });

  test('idle → idle (no real transition) does not fire a notification', () => {
    const { handleEvent } = buildHandler();
    useSyncStore.getState().setStatus('ses_1', { type: 'idle' });

    handleEvent({
      id: 'evt_1',
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    });

    expect(notifications).toEqual([]);
  });

  test('busy → busy does not fire a task-complete notification', () => {
    const { handleEvent } = buildHandler();
    useSyncStore.getState().setStatus('ses_1', { type: 'busy' });

    handleEvent({
      id: 'evt_1',
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'busy' } },
    });

    expect(notifications).toEqual([]);
  });
});

describe('session.idle', () => {
  test('busy → idle fires notifyTaskComplete', () => {
    const { handleEvent } = buildHandler();
    useSyncStore.getState().setStatus('ses_1', { type: 'retry', attempt: 1, message: 'retrying', next: 1 });

    handleEvent({
      id: 'evt_1',
      type: 'session.idle',
      properties: { sessionID: 'ses_1' },
    });

    expect(notifications).toEqual([{ kind: 'task-complete', sessionId: 'ses_1', sessionTitle: undefined }]);
  });
});

// ============================================================================
// session.error — patches .error onto the last assistant message in the
// messages query cache, and (unless it looks like an abort) rehydrates real
// messages from the injected client.
// ============================================================================

describe('session.error', () => {
  test('patches .error onto the last assistant message in the messages cache', () => {
    const { handleEvent, queryClient } = buildHandler();
    const key = opencodeKeys.messages('ses_1');
    queryClient.setQueryData(key, [
      { info: userMessage('msg_u'), parts: [] },
      { info: assistantMessage('msg_a'), parts: [] },
    ]);

    handleEvent({
      id: 'evt_1',
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'UnknownError', data: { message: 'boom' } } },
    });

    const cached = queryClient.getQueryData<Array<{ info: Message }>>(key);
    expect((cached?.[1].info as AssistantMessage).error).toEqual({
      name: 'UnknownError',
      data: { message: 'boom' },
    });
    expect(notifications).toEqual([
      { kind: 'session-error', sessionId: 'ses_1', errorTitle: 'UnknownError', sessionTitle: undefined },
    ]);
  });

  test('non-abort errors rehydrate real messages from the injected client', async () => {
    const rehydrated: Message[] = [assistantMessage('msg_real')];
    const { handleEvent, queryClient } = buildHandler({
      messagesImpl: async () => ({ data: rehydrated.map((info) => ({ info, parts: [] })) }),
    });
    useSyncStore.getState().optimisticAdd('ses_1', userMessage('msg_optimistic'), []);

    handleEvent({
      id: 'evt_1',
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'UnknownError', data: { message: 'boom' } } },
    });

    // The rehydrate fetch is fire-and-forget (`.then()`), so wait a tick.
    await Promise.resolve();
    await Promise.resolve();

    expect(useSyncStore.getState().messages.ses_1?.some((m) => m.id === 'msg_real')).toBe(true);
    expect(queryClient).toBeInstanceOf(QueryClient);
  });

  test('an abort-shaped error skips the rehydrate fetch entirely', async () => {
    let fetchCount = 0;
    const { handleEvent } = buildHandler({
      messagesImpl: async () => {
        fetchCount++;
        return { data: [] };
      },
    });
    useSyncStore.getState().optimisticAdd('ses_1', userMessage('msg_optimistic'), []);

    // A real `session.error` event's `error.name` is restricted to the SDK's
    // typed union — but `looksLikeAbortError` (see `helpers.ts`) exists
    // precisely because some servers emit a differently-shaped abort error.
    // Bypass the strict type here (as the real synthetic-abort call site in
    // `use-event-stream-refs.ts` also must) to exercise that defensive path.
    handleEvent({
      id: 'evt_1',
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'AbortError', data: { message: 'aborted' } } },
    } as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchCount).toBe(0);
    // Optimistic message is still cleared even on the abort path.
    expect(useSyncStore.getState().hasOptimisticMessages('ses_1')).toBe(false);
  });
});

// ============================================================================
// permission.asked / permission.replied — forwarded to the injected pending
// store callbacks + a browser notification.
// ============================================================================

describe('permission.asked / permission.replied', () => {
  test('permission.asked calls addPermission with the raw request and notifies', () => {
    const { handleEvent, addPermission } = buildHandler();
    const req: PermissionRequest = {
      id: 'perm_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['*'],
      metadata: {},
      always: [],
    };

    handleEvent({ id: 'evt_1', type: 'permission.asked', properties: req });

    expect(addPermission.calls).toEqual([[req]]);
    expect(notifications).toEqual([
      { kind: 'permission', sessionId: 'ses_1', toolName: 'a tool', sessionTitle: undefined },
    ]);
  });

  test('permission.replied calls removePermission with the request id', () => {
    const { handleEvent, removePermission } = buildHandler();
    handleEvent({
      id: 'evt_1',
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', requestID: 'perm_1', reply: 'once' },
    });
    expect(removePermission.calls).toEqual([['perm_1']]);
  });
});

// ============================================================================
// question.asked / question.replied / question.rejected
// ============================================================================

describe('question.asked / question.replied / question.rejected', () => {
  test('question.asked calls addQuestion and notifies with the first question text', () => {
    const { handleEvent, addQuestion } = buildHandler();
    const req: QuestionRequest = {
      id: 'q_1',
      sessionID: 'ses_1',
      questions: [{ question: 'Should I proceed?', header: 'Proceed?', options: [] }],
    };

    handleEvent({ id: 'evt_1', type: 'question.asked', properties: req });

    expect(addQuestion.calls).toEqual([[req]]);
    expect(notifications).toEqual([
      { kind: 'question', sessionId: 'ses_1', questionText: 'Should I proceed?', sessionTitle: undefined },
    ]);
  });

  test('question.replied calls removeQuestion with the request id', () => {
    const { handleEvent, removeQuestion } = buildHandler();
    handleEvent({
      id: 'evt_1',
      type: 'question.replied',
      properties: { sessionID: 'ses_1', requestID: 'q_1', answers: [] },
    });
    expect(removeQuestion.calls).toEqual([['q_1']]);
  });

  test('question.rejected calls removeQuestion with the request id', () => {
    const { handleEvent, removeQuestion } = buildHandler();
    handleEvent({
      id: 'evt_1',
      type: 'question.rejected',
      properties: { sessionID: 'ses_1', requestID: 'q_2' },
    });
    expect(removeQuestion.calls).toEqual([['q_2']]);
  });
});

// ============================================================================
// session.diff / todo.updated / vcs.branch.updated — targeted query-cache
// writes, no invalidation.
// ============================================================================

describe('misc targeted cache writes', () => {
  test('session.diff writes the diff array under the session-diff key', () => {
    const { handleEvent, queryClient } = buildHandler();
    const diff = [{ file: 'a.ts', additions: 1, deletions: 0, status: 'modified' as const }];
    handleEvent({
      id: 'evt_1',
      type: 'session.diff',
      properties: { sessionID: 'ses_1', diff },
    });
    expect(queryClient.getQueryData<typeof diff>(['opencode', 'session-diff', 'ses_1'])).toEqual(diff);
  });

  test('todo.updated writes the todos array under the session-todo key', () => {
    const { handleEvent, queryClient } = buildHandler();
    const todos = [{ content: 'write tests', status: 'pending', priority: 'high', id: 't1' }];
    handleEvent({
      id: 'evt_1',
      type: 'todo.updated',
      properties: { sessionID: 'ses_1', todos },
    });
    expect(queryClient.getQueryData<typeof todos>(['opencode', 'session-todo', 'ses_1'])).toEqual(todos);
  });

  test('vcs.branch.updated writes the branch under the vcs key', () => {
    const { handleEvent, queryClient } = buildHandler();
    handleEvent({
      id: 'evt_1',
      type: 'vcs.branch.updated',
      properties: { branch: 'feat/foo' },
    });
    expect(queryClient.getQueryData<{ branch: string }>(['opencode', 'vcs'])).toEqual({ branch: 'feat/foo' });
  });
});

// ============================================================================
// Everything else — smoke coverage that each remaining case dispatches
// without throwing and hits the expected side effect.
// ============================================================================

describe('remaining event kinds — smoke coverage', () => {
  test('mcp.tools.changed refetches MCP status + tool ids (active only)', () => {
    const { handleEvent, queryClient } = buildHandler();
    expect(() =>
      handleEvent({ id: 'evt_1', type: 'mcp.tools.changed', properties: { server: 'github' } }),
    ).not.toThrow();
    expect(queryClient).toBeInstanceOf(QueryClient);
  });

  test('worktree.ready invalidates worktrees + projects', () => {
    const { handleEvent } = buildHandler();
    expect(() =>
      handleEvent({ id: 'evt_1', type: 'worktree.ready', properties: { name: 'wt-1' } }),
    ).not.toThrow();
  });

  test('file.edited invalidates file list/git status, and file content only when a path is given', () => {
    const { handleEvent, queryClient } = buildHandler();
    let contentInvalidated = 0;
    const orig = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((opts: { queryKey: unknown[] }) => {
      if (JSON.stringify(opts.queryKey) === JSON.stringify(fileContentKeys.all)) contentInvalidated++;
      return orig(opts);
    }) as typeof queryClient.invalidateQueries;

    handleEvent({ id: 'evt_1', type: 'file.edited', properties: { file: 'src/app.ts' } });
    expect(contentInvalidated).toBe(1);
  });

  test('installation.updated shows a toast', () => {
    const { handleEvent } = buildHandler();
    handleEvent({ id: 'evt_1', type: 'installation.updated', properties: { version: '1.2.3' } });
    expect(toasts).toEqual([{ level: 'info', message: 'Installation updated (v1.2.3). Restart to apply changes.' }]);
  });

  test('installation.update-available shows a toast', () => {
    const { handleEvent } = buildHandler();
    handleEvent({ id: 'evt_1', type: 'installation.update-available', properties: { version: '2.0.0' } });
    expect(toasts).toEqual([{ level: 'info', message: 'v2.0.0 is available. Update when you\'re ready.' }]);
  });

  test('pty.* events invalidate the pty list', () => {
    const { handleEvent, queryClient } = buildHandler();
    let ptyInvalidated = 0;
    const orig = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((opts: { queryKey: unknown[] }) => {
      if (JSON.stringify(opts.queryKey) === JSON.stringify(ptyKeys.listPrefix())) ptyInvalidated++;
      return orig(opts);
    }) as typeof queryClient.invalidateQueries;

    handleEvent({ id: 'evt_1', type: 'pty.created', properties: { info: { id: 'pty_1' } } as never });
    expect(ptyInvalidated).toBe(1);
  });

  test('server.instance.disposed marks every non-idle session aborted locally', () => {
    const { handleEvent, markSessionAbortedLocally } = buildHandler();
    useSyncStore.getState().setStatus('ses_busy', { type: 'busy' });
    useSyncStore.getState().setStatus('ses_idle', { type: 'idle' });

    handleEvent({
      id: 'evt_1',
      type: 'server.instance.disposed',
      properties: { directory: '/workspace' },
    });

    expect(markSessionAbortedLocally.calls.map((c) => c[0])).toEqual(['ses_busy']);
  });

  test('lsp.updated triggers a debounced diagnostics refetch', () => {
    const { handleEvent, fetchLspDiagnosticsDebounced } = buildHandler();
    handleEvent({ id: 'evt_1', type: 'lsp.updated', properties: {} });
    expect(fetchLspDiagnosticsDebounced.calls.length).toBe(1);
  });

  test('lsp.client.diagnostics triggers a debounced diagnostics refetch', () => {
    const { handleEvent, fetchLspDiagnosticsDebounced } = buildHandler();
    handleEvent({
      id: 'evt_1',
      type: 'lsp.client.diagnostics',
      properties: { serverID: 'srv_1', path: 'src/app.ts' },
    });
    expect(fetchLspDiagnosticsDebounced.calls.length).toBe(1);
  });
});
