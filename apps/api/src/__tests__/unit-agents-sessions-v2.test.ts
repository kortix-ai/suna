import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../config', () => ({
  config: {
    OPENCODE_URL: 'http://localhost:14000',
    KORTIX_MASTER_URL: undefined,
    SANDBOX_PORT_BASE: 14000,
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

const MOCK_SESSIONS = [
  {
    id: 'sess-abc123',
    title: 'fix authentication bug in user service',
    time: { created: 1700000000000, updated: 1700003000000 },
  },
  {
    id: 'sess-def456',
    title: 'add payment processing feature',
    time: { created: 1700000000000, updated: 1700001000000 },
  },
];

const MOCK_STATUS: Record<string, { type: string }> = {
  'sess-abc123': { type: 'busy' },
  'sess-def456': { type: 'idle' },
};

function makeFetch(opts: {
  sessions?: typeof MOCK_SESSIONS;
  status?: Record<string, { type: string }>;
  execResult?: { code: number; stdout: string; stderr: string };
  newSessionId?: string;
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const { sessions = MOCK_SESSIONS, status = MOCK_STATUS, execResult, newSessionId = 'sess-new-789' } = opts;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/session/status') && method === 'GET') {
      return new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/session') && !url.includes('/session/') && method === 'GET') {
      return new Response(JSON.stringify(sessions), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/session') && !url.includes('/session/') && method === 'POST') {
      return new Response(JSON.stringify({ id: newSessionId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/prompt_async') && method === 'POST') {
      return new Response('', { status: 204 });
    }
    if (url.includes('/kortix/core/exec') && method === 'POST') {
      const result = execResult ?? { code: 0, stdout: '', stderr: '' };
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
}

describe('GET /v1/agents/sessions', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = originalFetch; });

  test('returns sessions sorted by last_activity_at descending', async () => {
    globalThis.fetch = makeFetch({}) as unknown as typeof fetch;
    const cb = `?t=${Date.now()}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', { method: 'GET' });
    expect(res.status).toBe(200);
    const json = await res.json() as { sessions: any[]; next_cursor: string | null };
    expect(json.sessions.length).toBe(2);
    expect(json.sessions[0].session_id).toBe('sess-abc123');
    expect(json.sessions[0].status).toBe('running');
    expect(json.sessions[1].session_id).toBe('sess-def456');
    expect(json.sessions[1].status).toBe('idle');
    expect(json.next_cursor).toBeNull();
  });

  test('paginates with limit and cursor', async () => {
    globalThis.fetch = makeFetch({}) as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 1}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions?limit=1', { method: 'GET' });
    const json = await res.json() as { sessions: any[]; next_cursor: string | null };
    expect(json.sessions.length).toBe(1);
    expect(json.next_cursor).toBe('sess-abc123');

    const res2 = await agentsApp.request(`http://localhost/sessions?limit=1&cursor=${json.next_cursor}`, { method: 'GET' });
    const json2 = await res2.json() as { sessions: any[]; next_cursor: string | null };
    expect(json2.sessions.length).toBe(1);
    expect(json2.sessions[0].session_id).toBe('sess-def456');
    expect(json2.next_cursor).toBeNull();
  });

  test('returns empty sessions on OpenCode unreachable', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 2}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', { method: 'GET' });
    expect(res.status).toBe(200);
    const json = await res.json() as { sessions: any[] };
    expect(json.sessions.length).toBe(0);
  });
});

describe('POST /v1/agents/sessions', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = originalFetch; });

  test('creates session with task, returns session_id and status:running', async () => {
    globalThis.fetch = makeFetch({ newSessionId: 'sess-new-123' }) as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 3}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'fix the auth bug' }),
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { session_id: string; branch_name: null; status: string };
    expect(json.session_id).toBe('sess-new-123');
    expect(json.status).toBe('running');
    expect(json.branch_name).toBeNull();
  });

  test('creates session with worktree, calls git worktree add, stores branch_name', async () => {
    globalThis.fetch = makeFetch({ newSessionId: 'sess-wt-456', execResult: { code: 0, stdout: '', stderr: '' } }) as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 4}`;
    const { agentsApp, getSessionMeta } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'add payment feature', worktree: 'feature/payments' }),
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { session_id: string; branch_name: string };
    expect(json.branch_name).toBe('feature/payments');
    expect(json.session_id).toBe('sess-wt-456');

    const meta = getSessionMeta('sess-wt-456');
    expect(meta.branch_name).toBe('feature/payments');
  });

  test('returns 422 when git worktree add fails', async () => {
    globalThis.fetch = makeFetch({
      execResult: { code: 128, stdout: 'fatal: branch already exists', stderr: '' },
    }) as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 5}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'fix things', worktree: 'feature/existing' }),
    });
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('worktree');
  });

  test('returns 400 when task missing', async () => {
    const cb = `?t=${Date.now() + 6}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktree: 'feature/x' }),
    });
    expect(res.status).toBe(400);
  });
});
