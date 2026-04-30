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

let sessionCounter = 0;

function makeFetch(failIdx: number[] = []): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/session') && method === 'POST') {
      const id = `sess-${++sessionCounter}`;
      return new Response(JSON.stringify({ id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/prompt_async') && method === 'POST') {
      return new Response('', { status: 204 });
    }
    throw new Error(`Unexpected: ${method} ${url}`);
  };
}

describe('POST /v1/agents/parallel', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    sessionCounter = 0;
  });

  test('fans out 3 tasks → returns 3 session objects', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    const cb = `?t=${Date.now()}`;
    const { parallelApp } = await import(`../routes/parallel.ts${cb}`);

    const res = await parallelApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: ['Write about cats', 'Write about dogs', 'Write about fish'] }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { sessions: any[]; spawned: number; total: number; failed: any[] };
    expect(json.sessions.length).toBe(3);
    expect(json.spawned).toBe(3);
    expect(json.total).toBe(3);
    expect(json.failed.length).toBe(0);
    // Each session has session_id and task
    expect(json.sessions[0].session_id).toMatch(/^sess-/);
    expect(typeof json.sessions[0].task).toBe('string');
  });

  test('returns 400 when tasks is empty array', async () => {
    const cb = `?t=${Date.now() + 1}`;
    const { parallelApp } = await import(`../routes/parallel.ts${cb}`);

    const res = await parallelApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when more than 20 tasks', async () => {
    const cb = `?t=${Date.now() + 2}`;
    const { parallelApp } = await import(`../routes/parallel.ts${cb}`);

    const res = await parallelApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: Array.from({ length: 21 }, (_, i) => `task ${i}`) }),
    });
    expect(res.status).toBe(400);
  });

  test('context prepended to each task prompt', async () => {
    const prompts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/session') && method === 'POST') {
        return new Response(JSON.stringify({ id: `sess-${++sessionCounter}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/prompt_async') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { parts: Array<{ text: string }> };
        prompts.push(body.parts[0]?.text ?? '');
        return new Response('', { status: 204 });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const cb = `?t=${Date.now() + 3}`;
    const { parallelApp } = await import(`../routes/parallel.ts${cb}`);

    await parallelApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: ['Write A', 'Write B'],
        context: 'You are an expert writer.',
      }),
    });

    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain('You are an expert writer.');
    expect(prompts[0]).toContain('Write A');
    expect(prompts[1]).toContain('Write B');
  });
});
