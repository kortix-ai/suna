/**
 * @kortix/connector-sdk — full unit coverage with an injected fetch (no network).
 * Exercises construction/validation, project-explicit vs flat route selection,
 * call/connectors/tools/discover/describe, error mapping (ConnectorError), the
 * URL normalization + path joining, and response-body parsing.
 */
import { describe, expect, test } from 'bun:test';
import {
  createConnectorClient,
  ConnectorClient,
  ConnectorError,
  type ConnectorDefinition,
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
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const r = reply(String(url), init);
    const payload = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CATALOG: { connectors: ConnectorDefinition[] } = {
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
    expect(() => new ConnectorClient({ apiUrl: '', token: 't' })).toThrow(/apiUrl/);
    expect(() => new ConnectorClient({ apiUrl: 'http://x', token: '  ' })).toThrow(/token/);
  });

  test('createConnectorClient returns a client', () => {
    expect(createConnectorClient({ apiUrl: 'http://x', token: 't' })).toBeInstanceOf(ConnectorClient);
  });
});

/* ─── URL normalization (observable via the request URL) ──────────────────── */

describe('apiUrl normalization', () => {
  async function urlFor(apiUrl: string): Promise<string> {
    const { fetchImpl, calls } = harness(() => ({ body: { connectors: [] } }));
    await createConnectorClient({ apiUrl, token: 't', fetchImpl }).connectors();
    return calls[0]!.url;
  }

  test('appends /v1 when missing', async () => {
    expect(await urlFor('http://localhost:8008')).toBe('http://localhost:8008/v1/connectors/catalog');
  });
  test('strips trailing slashes then appends /v1', async () => {
    expect(await urlFor('http://localhost:8008///')).toBe('http://localhost:8008/v1/connectors/catalog');
  });
  test('does not double /v1', async () => {
    expect(await urlFor('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1/connectors/catalog');
  });
});

/* ─── route selection: project-explicit vs flat ───────────────────────────── */

describe('route selection', () => {
  test('flat routes when no projectId', async () => {
    const { fetchImpl, calls } = harness((url) =>
      url.includes('/call') ? { body: { ok: true, data: 1 } } : { body: { connectors: [] } },
    );
    const c = createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl });
    await c.connectors();
    await c.call('slack', 'auth_test');
    expect(calls[0]!.url).toBe('http://x/v1/connectors/catalog');
    expect(calls[1]!.url).toBe('http://x/v1/connectors/call');
  });

  test('project-explicit routes when projectId set (+ encoded)', async () => {
    const { fetchImpl, calls } = harness((url) =>
      url.includes('/call') ? { body: { ok: true } } : { body: { connectors: [] } },
    );
    const c = createConnectorClient({ apiUrl: 'http://x', token: 't', projectId: 'p/1', fetchImpl });
    await c.connectors();
    await c.call('slack', 'auth_test');
    expect(calls[0]!.url).toBe('http://x/v1/connectors/projects/p%2F1/catalog');
    expect(calls[1]!.url).toBe('http://x/v1/connectors/projects/p%2F1/call');
  });

  test('blank projectId falls back to flat', async () => {
    const { fetchImpl, calls } = harness(() => ({ body: { connectors: [] } }));
    await createConnectorClient({ apiUrl: 'http://x', token: 't', projectId: '   ', fetchImpl }).connectors();
    expect(calls[0]!.url).toBe('http://x/v1/connectors/catalog');
  });
});

/* ─── call() ──────────────────────────────────────────────────────────────── */

describe('call', () => {
  test('POSTs {connector, action, args} with bearer auth + returns the envelope', async () => {
    const { fetchImpl, calls } = harness(() => ({ body: { ok: true, data: { ts: '1.2' }, risk: 'write' } }));
    const res = await createConnectorClient({ apiUrl: 'http://x', token: 'sek', fetchImpl })
      .call('slack', 'send_message', { channel: 'C1', text: 'hi' });
    expect(res).toEqual({ ok: true, data: { ts: '1.2' }, risk: 'write' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sek');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({ connector: 'slack', action: 'send_message', args: { channel: 'C1', text: 'hi' } });
  });

  test('defaults args to {}', async () => {
    const { fetchImpl, calls } = harness(() => ({ body: { ok: true } }));
    await createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).call('slack', 'auth_test');
    expect(calls[0]!.body).toEqual({ connector: 'slack', action: 'auth_test', args: {} });
  });

  test('preserves the approval handoff URL and human-readable summary', async () => {
    const pending = {
      ok: false,
      status: 'pending_approval',
      execution_id: 'exec-1',
      retryable: false,
      approval_url: 'https://app.kortix.test/approve/token',
      approval_summary: 'to: finance@example.com',
      approval_instructions:
        'Share approval_url with a human, then stop this turn. Kortix resumes the session after approve or deny.',
    };
    const { fetchImpl } = harness(() => ({ status: 202, body: pending }));
    const result = await createConnectorClient({
      apiUrl: 'http://x',
      token: 't',
      fetchImpl,
    }).call('gmail', 'send_email', { to: 'finance@example.com' });
    expect(result).toEqual(pending);
  });
});

/* ─── attachment upload ──────────────────────────────────────────────────── */

describe('uploadAttachment', () => {
  test('streams raw bytes to the flat attachment route', async () => {
    const { fetchImpl, calls } = harness(() => ({
      body: {
        attachment_id: '019fc40d-04dd-7f52-a591-65ab13d2a245',
        filename: 'Investment Memo.pdf',
        content_type: 'application/pdf',
        content_disposition: 'attachment',
        size: 9,
        expires_at: '2026-08-03T20:00:00.000Z',
      },
    }));
    const bytes = new TextEncoder().encode('pdf-bytes');
    const result = await createConnectorClient({
      apiUrl: 'http://x',
      token: 'sek',
      fetchImpl,
    }).uploadAttachment(bytes, {
      filename: 'Investment Memo.pdf',
      contentType: 'application/pdf',
    });

    expect(result.attachment_id).toBe('019fc40d-04dd-7f52-a591-65ab13d2a245');
    expect(calls[0]!.url).toBe('http://x/v1/connectors/attachments');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sek');
    expect(calls[0]!.headers['Content-Type']).toBe('application/pdf');
    expect(calls[0]!.headers['X-Kortix-Attachment-Filename']).toBe(
      encodeURIComponent('Investment Memo.pdf'),
    );
    expect(calls[0]!.body).toBe(bytes);
  });

  test('uses the project-explicit route and sends optional inline metadata', async () => {
    const { fetchImpl, calls } = harness(() => ({
      body: {
        attachment_id: '019fc40d-04dd-7f52-a591-65ab13d2a245',
        filename: 'chart.png',
        content_type: 'image/png',
        content_disposition: 'inline',
        content_id: 'chart-1',
        size: 3,
        expires_at: '2026-08-03T20:00:00.000Z',
      },
    }));
    await createConnectorClient({
      apiUrl: 'http://x',
      token: 'sek',
      projectId: 'p/1',
      fetchImpl,
    }).uploadAttachment(new Uint8Array([1, 2, 3]), {
      filename: 'chart.png',
      contentType: 'image/png',
      contentDisposition: 'inline',
      contentId: 'chart-1',
    });

    expect(calls[0]!.url).toBe('http://x/v1/connectors/projects/p%2F1/attachments');
    expect(calls[0]!.headers['X-Kortix-Attachment-Disposition']).toBe('inline');
    expect(calls[0]!.headers['X-Kortix-Attachment-Content-Id']).toBe('chart-1');
  });
});

/* ─── catalog → tools / discover / describe ───────────────────────────────── */

describe('catalog helpers', () => {
  const make = () => createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl: harness(() => ({ body: CATALOG })).fetchImpl });

  test('connectors() returns the array; empty when absent', async () => {
    expect((await make().connectors())[0]!.slug).toBe('slack');
    const empty = createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl: harness(() => ({ body: {} })).fetchImpl });
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

  test('discover() matches every query token when the words are not contiguous', async () => {
    const catalog = structuredClone(CATALOG);
    catalog.connectors[0]!.actions[0]!.description = 'echo one query value';
    const client = createConnectorClient({
      apiUrl: 'http://x',
      token: 't',
      fetchImpl: harness(() => ({ body: catalog })).fetchImpl,
    });
    expect((await client.discover('echo query value')).map((t) => t.tool)).toEqual(['slack.send_message']);
  });

  test('describe() finds by tool name, null otherwise', async () => {
    expect((await make().describe('slack.send_message'))?.action).toBe('send_message');
    expect(await make().describe('slack.nope')).toBeNull();
  });
});

/* ─── error mapping ───────────────────────────────────────────────────────── */

describe('error handling', () => {
  test('non-2xx throws ConnectorError with status + body + extracted reason', async () => {
    const { fetchImpl } = harness(() => ({ status: 500, body: { ok: false, status: 'error', reason: 'channel_not_found' } }));
    const c = createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl });
    try {
      await c.call('slack', 'send_message');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as ConnectorError).status).toBe(500);
      expect((e as ConnectorError).message).toBe('channel_not_found');
      expect((e as ConnectorError).body).toMatchObject({ reason: 'channel_not_found' });
    }
  });

  test('prefers reason, then error, then message, then HTTP status', async () => {
    const msg = async (body: unknown, status = 400) => {
      const { fetchImpl } = harness(() => ({ status, body }));
      try { await createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).connectors(); }
      catch (e) { return (e as ConnectorError).message; }
    };
    expect(await msg({ error: 'bad' })).toBe('bad');
    expect(await msg({ message: 'oops' })).toBe('oops');
    expect(await msg('', 503)).toBe('HTTP 503');
  });

  test('denied (403) still throws ConnectorError', async () => {
    const { fetchImpl } = harness(() => ({ status: 403, body: { ok: false, status: 'denied', reason: 'not_shared' } }));
    await expect(createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).call('s', 'a')).rejects.toBeInstanceOf(ConnectorError);
  });
});

/* ─── response body parsing ───────────────────────────────────────────────── */

describe('body parsing', () => {
  test('empty body → null result fields tolerated', async () => {
    const { fetchImpl } = harness(() => ({ status: 200, body: '' }));
    expect(await createConnectorClient({ apiUrl: 'http://x', token: 't', fetchImpl }).connectors()).toEqual([]);
  });
});
