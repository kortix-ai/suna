import { describe, expect, test, beforeEach, mock } from 'bun:test';

// This file must be hermetic against process-wide `mock.module` registrations
// made by OTHER test files (per the `../opencode/kortix-master.test.ts`
// comment: several files already mock '../platform/auth', the ONE lowest
// network boundary every transport call in this package goes through).
// Deliberately mocking that shared boundary — rather than '../opencode/client'
// itself — matters here for a reason beyond style: '../opencode/client' is
// the exact module `../opencode/client.test.ts` dynamically imports as ITS
// OWN module-under-test, and Bun's `mock.module` is process-wide for the
// whole `bun test` sweep — replacing that path here would race with (and can
// clobber) that file's real import. Mocking `../platform/auth` instead lets
// the REAL `use-kortix-master.ts` -> `../opencode/client` -> `../opencode/
// kortix-master` chain run for real, with only the actual fetch boundary
// faked, matching `kortix-master.test.ts`'s own established pattern.
//
// react-query's `useQuery`/`useMutation` are mocked down to identity
// functions (return the config object passed in) so the hooks under test can
// be called as plain functions — no React render tree needed — while still
// exercising the exact `queryKey`/`queryFn`/`mutationFn`/`onSuccess` values
// the real hooks build. Nothing else in this bun:test sweep renders a real
// react-query hook, so this is safe to mock process-wide.

interface Call {
  url: string;
  method: string;
  body?: string;
}

let calls: Call[] = [];
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });

mock.module('../platform/auth', () => ({
  getAuthToken: async () => 'test-token',
  getAuthTokenWithRetry: async () => 'test-token',
  authenticatedFetch: async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return nextResponse();
  },
  invalidateTokenCache: () => {},
  setCachedAuthToken: () => {},
  setBootstrapAuthToken: () => {},
  getSupabaseAccessToken: async () => 'test-token',
  getSupabaseAccessTokenWithRetry: async () => 'test-token',
}));

const FAKE_SERVER_URL = 'https://sbx.test';
mock.module('../browser/stores/server-store', () => ({
  useServerStore: Object.assign(
    (selector: (s: { getActiveServerUrl: () => string }) => unknown) =>
      selector({ getActiveServerUrl: () => FAKE_SERVER_URL }),
    { getState: () => ({ getActiveServerUrl: () => FAKE_SERVER_URL }) },
  ),
}));

let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => { invalidated.push(opts.queryKey); },
  }),
  keepPreviousData: Symbol('keepPreviousData') as unknown,
}));

const M = await import('./use-kortix-master');

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const last = () => calls[calls.length - 1];

beforeEach(() => {
  calls = [];
  invalidated = [];
  nextResponse = () => jsonResponse([]);
});

const IDENTITY_AUTHED: import('./use-kortix-master').KortixMasterIdentity = {
  userId: 'user-1',
  handle: 'alice',
  isLoading: false,
};

// ─────────────────────────────────────────────────────────────────────────
// Pure functions
// ─────────────────────────────────────────────────────────────────────────

describe('normalizeTask (pure)', () => {
  test('defaults an unrecognized daemon status to todo', () => {
    const raw = { id: 't1', project_id: 'p1', status: 'not-a-real-status', created_at: 'c', updated_at: 'u' };
    expect(M.normalizeTask(raw).status).toBe('todo');
  });

  test('passes through a valid status unchanged', () => {
    const raw = { id: 't1', project_id: 'p1', status: 'completed', created_at: 'c', updated_at: 'u' };
    expect(M.normalizeTask(raw).status).toBe('completed');
  });

  test('fills missing optional string fields with empty string, not undefined', () => {
    const raw = { id: 't1', project_id: 'p1', status: 'todo', created_at: 'c', updated_at: 'u' };
    const task = M.normalizeTask(raw);
    expect(task.title).toBe('');
    expect(task.description).toBe('');
    expect(task.verification_condition).toBe('');
  });

  test('defaults nullable fields to null rather than undefined', () => {
    const raw = { id: 't1', project_id: 'p1', status: 'todo', created_at: 'c', updated_at: 'u' };
    const task = M.normalizeTask(raw);
    expect(task.result).toBeNull();
    expect(task.verification_summary).toBeNull();
    expect(task.blocking_question).toBeNull();
    expect(task.owner_session_id).toBeNull();
    expect(task.owner_agent).toBeNull();
    expect(task.requested_by_session_id).toBeNull();
    expect(task.started_at).toBeNull();
    expect(task.completed_at).toBeNull();
  });
});

describe('safeParseJsonArray (pure)', () => {
  test('parses a JSON array of strings', () => {
    expect(M.safeParseJsonArray('["a","b"]')).toEqual(['a', 'b']);
  });
  test('coerces non-string array elements to strings', () => {
    expect(M.safeParseJsonArray('[1,2]')).toEqual(['1', '2']);
  });
  test('returns [] for null/undefined input', () => {
    expect(M.safeParseJsonArray(null)).toEqual([]);
    expect(M.safeParseJsonArray(undefined)).toEqual([]);
  });
  test('returns [] for invalid JSON', () => {
    expect(M.safeParseJsonArray('{not json')).toEqual([]);
  });
  test('returns [] when the parsed value is not an array', () => {
    expect(M.safeParseJsonArray('{"a":1}')).toEqual([]);
  });
});

describe('parseCustomFields (pure)', () => {
  test('parses a JSON object', () => {
    expect(M.parseCustomFields('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });
  test('returns {} for null/undefined input', () => {
    expect(M.parseCustomFields(null)).toEqual({});
    expect(M.parseCustomFields(undefined)).toEqual({});
  });
  test('returns {} for invalid JSON', () => {
    expect(M.parseCustomFields('not json')).toEqual({});
  });
  test('returns {} when the parsed value is a primitive, not an object', () => {
    expect(M.parseCustomFields('42')).toEqual({});
  });
});

function ticketEvent(overrides: Partial<import('./use-kortix-master').TicketEvent> = {}): import('./use-kortix-master').TicketEvent {
  return {
    id: 'ev-1',
    ticket_id: 'tk-1',
    project_id: 'p1',
    actor_type: 'agent',
    actor_id: 'bot',
    type: 'comment',
    message: null,
    payload_json: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeUnread (pure)', () => {
  test('counts an @mention addressed to the handle', () => {
    const events = [ticketEvent({ type: 'comment', message: 'hey @alice can you look?' })];
    const result = M.computeUnread(events, 'alice', null);
    expect(result.total).toBe(1);
    expect(result.byTicket.get('tk-1')).toBe(1);
  });

  test('counts an assignment to the handle', () => {
    const events = [
      ticketEvent({ type: 'assigned', payload_json: JSON.stringify({ assignee_type: 'user', assignee_id: 'alice' }) }),
    ];
    expect(M.computeUnread(events, 'alice', null).total).toBe(1);
  });

  test('skips events the user themselves produced', () => {
    const events = [ticketEvent({ actor_type: 'user', actor_id: 'alice', type: 'comment', message: '@alice note to self' })];
    expect(M.computeUnread(events, 'alice', null).total).toBe(0);
  });

  test('filters out events at or before sinceIso', () => {
    const events = [ticketEvent({ created_at: '2026-01-01T00:00:00.000Z', message: '@alice hi', type: 'comment' })];
    expect(M.computeUnread(events, 'alice', '2026-01-01T00:00:00.000Z').total).toBe(0);
    expect(M.computeUnread(events, 'alice', '2025-12-31T00:00:00.000Z').total).toBe(1);
  });

  test('handle matching is case-insensitive', () => {
    const events = [ticketEvent({ message: '@Alice ping', type: 'comment' })];
    expect(M.computeUnread(events, 'alice', null).total).toBe(1);
  });

  test('returns an empty result for undefined events', () => {
    const result = M.computeUnread(undefined, 'alice', null);
    expect(result).toEqual({ total: 0, byTicket: new Map(), latestAt: null });
  });
});

describe('computeNotifications (pure)', () => {
  test('produces a mention notification carrying the triggering event', () => {
    const ev = ticketEvent({ type: 'comment', message: '@alice ping' });
    const notifications = M.computeNotifications([ev], 'alice', null);
    expect(notifications).toEqual([{ event: ev, ticket_id: 'tk-1', kind: 'mention', relatedComment: ev }]);
  });

  test('produces an assigned notification', () => {
    const ev = ticketEvent({ type: 'assigned', payload_json: JSON.stringify({ assignee_type: 'user', assignee_id: 'alice' }) });
    const notifications = M.computeNotifications([ev], 'alice', null);
    expect(notifications).toEqual([{ event: ev, ticket_id: 'tk-1', kind: 'assigned' }]);
  });

  test('returns [] for undefined events', () => {
    expect(M.computeNotifications(undefined, 'alice', null)).toEqual([]);
  });
});

describe('readLastSeen / writeLastSeen (pure, SSR-safe guard)', () => {
  test('readLastSeen returns null outside a window (no DOM in this test env)', () => {
    expect(M.readLastSeen('p1', 'alice')).toBeNull();
  });

  test('writeLastSeen does not throw outside a window', () => {
    expect(() => M.writeLastSeen('p1', 'alice', '2026-01-01T00:00:00.000Z')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Query-key construction — byte-identical to the pre-migration web hooks
// ─────────────────────────────────────────────────────────────────────────

describe('query key factories', () => {
  test('credentialKeys', () => {
    expect(M.credentialKeys.list('p1')).toEqual(['kortix', 'credentials', 'p1']);
    expect(M.credentialKeys.list()).toEqual(['kortix', 'credentials', '']);
    expect(M.credentialKeys.events('p1', 'API_KEY')).toEqual(['kortix', 'credentials', 'p1', 'API_KEY', 'events']);
  });

  test('kortixKeys', () => {
    expect(M.kortixKeys.projects()).toEqual(['kortix', 'projects']);
    expect(M.kortixKeys.project('p1')).toEqual(['kortix', 'projects', 'p1']);
  });

  test('ticketKeys', () => {
    expect(M.ticketKeys.tickets('p1')).toEqual(['kortix', 'tickets', 'p1']);
    expect(M.ticketKeys.tickets()).toEqual(['kortix', 'tickets', '']);
    expect(M.ticketKeys.ticket('tk-1')).toEqual(['kortix', 'ticket', 'tk-1']);
    expect(M.ticketKeys.events('tk-1')).toEqual(['kortix', 'ticket', 'tk-1', 'events']);
    expect(M.ticketKeys.columns('p1')).toEqual(['kortix', 'columns', 'p1']);
    expect(M.ticketKeys.fields('p1')).toEqual(['kortix', 'fields', 'p1']);
    expect(M.ticketKeys.templates('p1')).toEqual(['kortix', 'templates', 'p1']);
    expect(M.ticketKeys.agents('p1')).toEqual(['kortix', 'agents', 'p1']);
  });

  test('milestoneKeys', () => {
    expect(M.milestoneKeys.list('p1', 'open')).toEqual(['kortix', 'milestones', 'p1', 'open']);
    expect(M.milestoneKeys.list()).toEqual(['kortix', 'milestones', '', 'all']);
    expect(M.milestoneKeys.detail('p1', 'M-1')).toEqual(['kortix', 'milestone', 'p1', 'M-1']);
    expect(M.milestoneKeys.events('p1', 'M-1')).toEqual(['kortix', 'milestone', 'p1', 'M-1', 'events']);
  });

  test('serviceKeys', () => {
    expect(M.serviceKeys.all).toEqual(['sandbox-services']);
    expect(M.serviceKeys.list('https://sbx', true)).toEqual(['sandbox-services', 'https://sbx', 'all']);
    expect(M.serviceKeys.list('https://sbx', false)).toEqual(['sandbox-services', 'https://sbx', 'visible']);
    expect(M.serviceKeys.logs('https://sbx', 'svc-1')).toEqual(['sandbox-services', 'https://sbx', 'logs', 'svc-1']);
    expect(M.serviceKeys.templates('https://sbx')).toEqual(['sandbox-services', 'https://sbx', 'templates']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hook behavior — hermetically mocked transport + react-query + server-store
// ─────────────────────────────────────────────────────────────────────────

describe('useKortixTasks (hook query-key + query behavior)', () => {
  test('builds the query key exactly as the pre-migration hook did', () => {
    const cfg = M.useKortixTasks('proj-1', 'todo') as any;
    expect(cfg.queryKey).toEqual(['kortix', 'tasks', 'proj-1', 'todo']);
  });

  test('is disabled without a projectId', () => {
    const cfg = M.useKortixTasks(undefined) as any;
    expect(cfg.enabled).toBe(false);
  });

  test('is enabled once a projectId is supplied', () => {
    const cfg = M.useKortixTasks('proj-1') as any;
    expect(cfg.enabled).toBe(true);
  });

  test('respects pollingEnabled: false by turning off refetchInterval', () => {
    const cfg = M.useKortixTasks('proj-1', undefined, { pollingEnabled: false }) as any;
    expect(cfg.refetchInterval).toBe(false);
  });

  test('queryFn calls the transport with the active server url + params, and normalizes rows', async () => {
    nextResponse = () => jsonResponse([
      { id: 't1', project_id: 'proj-1', status: 'bogus-status', created_at: 'c', updated_at: 'u' },
    ]);
    const cfg = M.useKortixTasks('proj-1', 'todo') as any;
    const result = await cfg.queryFn();

    expect(last().url).toBe(`${FAKE_SERVER_URL}/kortix/tasks?project_id=proj-1&status=todo`);
    expect(last().method).toBe('GET');
    expect(result).toEqual([
      M.normalizeTask({ id: 't1', project_id: 'proj-1', status: 'bogus-status', created_at: 'c', updated_at: 'u' }),
    ]);
    expect(result[0].status).toBe('todo');
  });

  test('queryFn tolerates a non-array response', async () => {
    nextResponse = () => jsonResponse(null);
    const cfg = M.useKortixTasks('proj-1') as any;
    expect(await cfg.queryFn()).toEqual([]);
  });
});

describe('useKortixProjects (identity gating + cache partitioning)', () => {
  test('query key partitions by identity.userId and the active server url', () => {
    const cfg = M.useKortixProjects(IDENTITY_AUTHED) as any;
    expect(cfg.queryKey).toEqual(['kortix', 'projects', 'user-1', FAKE_SERVER_URL]);
  });

  test('falls back to "anonymous" in the query key with no user id', () => {
    const cfg = M.useKortixProjects({ userId: null, handle: 'me', isLoading: false }) as any;
    expect(cfg.queryKey).toEqual(['kortix', 'projects', 'anonymous', FAKE_SERVER_URL]);
  });

  test('is disabled while identity is loading, even with a user id already known', () => {
    const cfg = M.useKortixProjects({ userId: 'user-1', handle: 'alice', isLoading: true }) as any;
    expect(cfg.enabled).toBe(false);
  });

  test('is disabled with no authenticated user', () => {
    const cfg = M.useKortixProjects({ userId: null, handle: 'me', isLoading: false }) as any;
    expect(cfg.enabled).toBe(false);
  });

  test('is enabled once loaded and authenticated', () => {
    const cfg = M.useKortixProjects(IDENTITY_AUTHED) as any;
    expect(cfg.enabled).toBe(true);
  });
});

describe('useCreateTicket (identity injection into mutation body + invalidation)', () => {
  test('stamps actor_id/created_by_id from identity.handle, not a hardcoded value', async () => {
    nextResponse = () => jsonResponse({ ticket: { id: 'tk-1', project_id: 'proj-1' }, triggered: [] });
    const cfg = M.useCreateTicket(IDENTITY_AUTHED) as any;
    const result = await cfg.mutationFn({ project_id: 'proj-1', title: 'Fix the thing' });

    expect(last().url).toBe(`${FAKE_SERVER_URL}/kortix/tickets`);
    expect(last().method).toBe('POST');
    expect(JSON.parse(last().body!)).toEqual({
      project_id: 'proj-1',
      title: 'Fix the thing',
      actor_type: 'user',
      actor_id: 'alice',
      created_by_type: 'user',
      created_by_id: 'alice',
    });
    expect(result.ticket.project_id).toBe('proj-1');
  });

  test('a different identity stamps a different handle', async () => {
    nextResponse = () => jsonResponse({ ticket: { id: 'tk-2', project_id: 'proj-1' }, triggered: [] });
    const cfg = M.useCreateTicket({ userId: 'user-2', handle: 'bob', isLoading: false }) as any;
    await cfg.mutationFn({ project_id: 'proj-1', title: 'Another' });
    expect(JSON.parse(last().body!).actor_id).toBe('bob');
  });

  test('onSuccess invalidates the tickets-list key for the created ticket\'s project', () => {
    const cfg = M.useCreateTicket(IDENTITY_AUTHED) as any;
    cfg.onSuccess(undefined, { project_id: 'proj-1' });
    expect(invalidated).toEqual([[...M.ticketKeys.tickets('proj-1')]]);
  });
});
