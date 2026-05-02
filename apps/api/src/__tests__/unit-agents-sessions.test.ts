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
    time: { created: 1700000000000, updated: 1700001000000 },
  },
  {
    id: 'sess-def456',
    title: 'add new feature: payment processing',
    time: { created: 1700000000000, updated: 1700002000000 },
  },
];

const MOCK_STATUS: Record<string, { type: string }> = {
  'sess-abc123': { type: 'busy' },
  'sess-def456': { type: 'idle' },
};

function makeFetch(
  sessions = MOCK_SESSIONS,
  status = MOCK_STATUS,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (url.endsWith('/session/status')) {
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/session')) {
      return new Response(JSON.stringify(sessions), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

describe('GET /v1/agents/sessions', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns sessions array with correct field mapping', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;

    const cb = `?t=${Date.now()}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', { method: 'GET' });

    expect(res.status).toBe(200);
    const json = await res.json() as { sessions: any[] };
    expect(json.sessions.length).toBe(2);

    const s0 = json.sessions[0];
    expect(s0.session_id).toBe('sess-abc123');
    expect(s0.task_title).toBe('fix authentication bug in user service');
    expect(s0.status).toBe('running');     // busy → running
    expect(s0.branch_name).toBeNull();
    expect(s0.pr_url).toBeNull();
    expect(s0.pr_ci_status).toBeNull();
    expect(new Date(s0.last_activity_at).getTime()).toBe(1700001000000);

    const s1 = json.sessions[1];
    expect(s1.session_id).toBe('sess-def456');
    expect(s1.status).toBe('idle');
  });

  test('returns empty sessions array when OpenCode unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const cb = `?t=${Date.now() + 1}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', { method: 'GET' });

    expect(res.status).toBe(200);
    const json = await res.json() as { sessions: any[] };
    expect(Array.isArray(json.sessions)).toBe(true);
    expect(json.sessions.length).toBe(0);
  });

  test('truncates task_title to 80 chars', async () => {
    const longTitle = 'a'.repeat(100);
    globalThis.fetch = makeFetch(
      [{ ...MOCK_SESSIONS[0], title: longTitle }],
      {},
    ) as unknown as typeof fetch;

    const cb = `?t=${Date.now() + 2}`;
    const { agentsApp } = await import(`../routes/agents.ts${cb}`);

    const res = await agentsApp.request('http://localhost/sessions', { method: 'GET' });
    const json = await res.json() as { sessions: any[] };
    expect(json.sessions[0].task_title.length).toBe(80);
  });
});
