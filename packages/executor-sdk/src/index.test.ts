/**
 * @kortix/executor-sdk — full unit coverage with an injected fetch (no network).
 * Exercises construction/validation, project-explicit vs flat route selection,
 * call/connectors/tools/discover/describe, error mapping (ExecutorError), the
 * URL normalization + path joining, and response-body parsing.
 */
import { describe, expect, test } from 'bun:test';
import {
  createExecutorClient,
  ExecutorClient,
  ExecutorError,
  type ExecutorConnector,
} from './index';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake fetch: records each request, returns the scripted (status, body). */
function harness(reply: (url: string, init: any) => { status?: number; body?: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = reply(String(url), init);
    const payload = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CATALOG: { connectors: ExecutorConnector[] } = {
  connectors: [
    {
      slug: 'slack',
      name: 'Slack',
      provider: 'channel',
      status: 'active',
      actions: [
        { path: 'send_message', name: 'Send', description: 'post a message', risk: 'write', inputSchema: null },
        { path: 'get_history', name: 'History', description: 'read messages', risk: 'read', inputSchema: null },
      ],
    },
  ],
};

/* ─── construction + validation ───────────────────────────────────────────── */

describe('construction', () => {
  test('requires apiUrl and token', () => {
    expect(() => new ExecutorClient({ apiUrl: '', token: 't' })).toThrow(/apiUrl/);
    expect(() => new ExecutorClient({ apiUrl: 'http://x', token: '  ' })).toThrow(/token/);
  });

  test('createExecutorClient returns a client', () => {
    expect(createExecutorClient({ apiUrl: 'http://x', token: 't' })).toBeInstanceOf(ExecutorClient);
  });
});

/* ─── URL normalization (observable via the request URL) ──────────────────── */

describe('apiUrl normalization', () => {
  async function urlFor(apiUrl: string): Promise<string> {
    const { fetchImpl, calls } = harness(() => ({ body: { connectors: [] } }));
    await createExecutorClient({ apiUrl, token: 't', fetchImpl }).connectors();
    return calls[0]!.url;
  }

  test('appends /v1 when missing', async () => {
    expect(await urlFor('http://localhost:8008')).toBe('http://localhost:8008/v1/executor/connectors');
  });
  test('strips trailing slashes then appends /v1', async () => {
    expect(await urlFor('http://localhost:8008///')).toBe('http://localhost:8008/v1/executor/connectors');
  });
  test('does not double /v1', async () => {
    expect(await urlFor('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1/executor/connectors');
  });
});

/* ─── route selection: project-explicit vs flat ───────────────────────────── */

describe('route selection', () => {
  test('flat routes when no projectId', async () => {
    const { fetchImpl, calls } = harness((url) =>
      url.includes('/call') ? { body: { ok: true, data: 1 } } : { body: { connectors: [] } },
    );
    const c = createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl });
    await c.connectors();
    await c.call('slack', 'auth_test');
    expect(calls[0]!.url).toBe('http://x/v1/executor/connectors');
    expect(calls[1]!.url).toBe('http://x/v1/executor/call');
  });

  test('project-explicit routes when projectId set (+ encoded)', async () => {
    const { fetchImpl, calls } = harness((url) =>
      url.includes('/call') ? { body: { ok: true } } : { body: { connectors: [] } },
    );
    const c = createExecutorClient({ apiUrl: 'http://x', token: 't', projectId: 'p/1', fetchImpl });
    await c.connectors();
    await c.call('slack', 'auth_test');
    expect(calls[0]!.url).toBe('http://x/v1/executor/projects/p%2F1/catalog');
    expect(calls[1]!.url).toBe('http://x/v1/executor/projects/p%2F1/call');
  });

  test('blank projectId falls back to flat', async () => {
    const { fetchImpl, calls } = harness(() => ({ body: { connectors: [] } }));
    await createExecutorClient({ apiUrl: 'http://x', token: 't', projectId: '   ', fetchImpl }).connectors();
    expect(calls[0]!.url).toBe('http://x/v1/executor/connectors');
  });
});

/* ─── call() ──────────────────────────────────────────────────────────────── */

describe('call', () => {
  test('POSTs {connector, action, args} with bearer auth + returns the envelope', async () => {
    const { fetchImpl, calls } = harness(() => ({ body: { ok: true, data: { ts: '1.2' }, risk: 'write' } }));
    const res = await createExecutorClient({ apiUrl: 'http://x', token: 'sek', fetchImpl })
      .call('slack', 'send_message', { channel: 'C1', text: 'hi' });
    expect(res).toEqual({ ok: true, data: { ts: '1.2' }, risk: 'write' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sek');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({ connector: 'slack', action: 'send_message', args: { channel: 'C1', text: 'hi' } });
  });

  test('defaults args to {}', async () => {
    const { fetchImpl, calls } = harness(() => ({ body: { ok: true } }));
    await createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).call('slack', 'auth_test');
    expect(calls[0]!.body).toEqual({ connector: 'slack', action: 'auth_test', args: {} });
  });
});

/* ─── catalog → tools / discover / describe ───────────────────────────────── */

describe('catalog helpers', () => {
  const make = () => createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl: harness(() => ({ body: CATALOG })).fetchImpl });

  test('connectors() returns the array; empty when absent', async () => {
    expect((await make().connectors())[0]!.slug).toBe('slack');
    const empty = createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl: harness(() => ({ body: {} })).fetchImpl });
    expect(await empty.connectors()).toEqual([]);
  });

  test('tools() flattens to slug.path matches', async () => {
    const tools = await make().tools();
    expect(tools.map((t) => t.tool)).toEqual(['slack.send_message', 'slack.get_history']);
    expect(tools[0]).toMatchObject({ connector: 'slack', action: 'send_message', risk: 'write', description: 'post a message' });
  });

  test('discover() filters by query + honors limit', async () => {
    expect((await make().discover('history')).map((t) => t.tool)).toEqual(['slack.get_history']);
    expect((await make().discover('')).length).toBe(2);
    expect((await make().discover('', { limit: 1 })).length).toBe(1);
  });

  test('describe() finds by tool name, null otherwise', async () => {
    expect((await make().describe('slack.send_message'))?.action).toBe('send_message');
    expect(await make().describe('slack.nope')).toBeNull();
  });
});

/* ─── error mapping ───────────────────────────────────────────────────────── */

describe('error handling', () => {
  test('non-2xx throws ExecutorError with status + body + extracted reason', async () => {
    const { fetchImpl } = harness(() => ({ status: 500, body: { ok: false, status: 'error', reason: 'channel_not_found' } }));
    const c = createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl });
    try {
      await c.call('slack', 'send_message');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutorError);
      expect((e as ExecutorError).status).toBe(500);
      expect((e as ExecutorError).message).toBe('channel_not_found');
      expect((e as ExecutorError).body).toMatchObject({ reason: 'channel_not_found' });
    }
  });

  test('prefers reason, then error, then message, then HTTP status', async () => {
    const msg = async (body: unknown, status = 400) => {
      const { fetchImpl } = harness(() => ({ status, body }));
      try { await createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).connectors(); }
      catch (e) { return (e as ExecutorError).message; }
    };
    expect(await msg({ error: 'bad' })).toBe('bad');
    expect(await msg({ message: 'oops' })).toBe('oops');
    expect(await msg('', 503)).toBe('HTTP 503');
  });

  test('denied (403) still throws ExecutorError', async () => {
    const { fetchImpl } = harness(() => ({ status: 403, body: { ok: false, status: 'denied', reason: 'not_shared' } }));
    await expect(createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).call('s', 'a')).rejects.toBeInstanceOf(ExecutorError);
  });
});

/* ─── response body parsing ───────────────────────────────────────────────── */

describe('body parsing', () => {
  test('empty body → null result fields tolerated', async () => {
    const { fetchImpl } = harness(() => ({ status: 200, body: '' }));
    expect(await createExecutorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).connectors()).toEqual([]);
  });
});
