import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  callConnector,
  describeConnectorTool,
  getConnectorCatalog,
  listConnectorTools,
  searchConnectorTools,
  uploadConnectorAttachment,
  type ConnectorCatalogEntry,
  type ConnectorCallResult,
} from './connectors';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

const catalog: { connectors: ConnectorCatalogEntry[] } = {
  connectors: [
    {
      slug: 'slack',
      name: 'Slack',
      provider: 'channel',
      status: 'active',
      actions: [
        {
          path: 'send_message',
          name: 'Send',
          description: 'post a message',
          risk: 'write',
          inputSchema: null,
        },
        {
          path: 'get_history',
          name: 'History',
          description: 'read channel history',
          risk: 'read',
          inputSchema: null,
        },
      ],
    },
  ],
};

let calls: RecordedRequest[] = [];
let responseStatus = 200;
let responseBody: unknown = catalog;

beforeEach(() => {
  calls = [];
  responseStatus = 200;
  responseBody = catalog;
  configureKortix({
    backendUrl: 'http://test.local/v1',
    getToken: async () => 'agent-token',
  });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: init?.body,
    });
    return new Response(
      responseBody === undefined ? null : JSON.stringify(responseBody),
      {
        status: responseStatus,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
});

test('catalog uses the project-scoped route and the shared token seam', async () => {
  const result = await getConnectorCatalog('project/one');

  expect(result).toEqual(catalog.connectors);
  expect(calls[0]?.url).toBe(
    'http://test.local/v1/connectors/projects/project%2Fone/catalog',
  );
  expect(calls[0]?.method).toBe('GET');
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer agent-token');
});

test('the platform fetch seam supports compatibility clients without replacing global fetch', async () => {
  const injectedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return new Response(JSON.stringify({ connectors: [] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-url': request.url,
      },
    });
  }) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://injected.local/v1',
    getToken: async () => 'compatibility-token',
    fetch: injectedFetch,
  });
  globalThis.fetch = mock(async () => {
    throw new Error('global fetch must not run');
  }) as unknown as typeof fetch;

  expect(await getConnectorCatalog('project-one')).toEqual([]);
  expect(injectedFetch).toHaveBeenCalledTimes(1);
});

test('catalog returns an empty list when the response omits connectors', async () => {
  responseBody = {};
  expect(await getConnectorCatalog('project-one')).toEqual([]);
});

test('tools flatten the catalog into stable connector.action identifiers', async () => {
  const tools = await listConnectorTools('project-one');

  expect(tools.map((tool) => tool.tool)).toEqual([
    'slack.send_message',
    'slack.get_history',
  ]);
  expect(tools[0]).toMatchObject({
    connector: 'slack',
    action: 'send_message',
    risk: 'write',
    description: 'post a message',
  });
});

test('search matches non-contiguous query tokens and applies the limit', async () => {
  expect((await searchConnectorTools('project-one', 'channel history')).map((tool) => tool.tool))
    .toEqual(['slack.get_history']);
  expect(await searchConnectorTools('project-one', '', { limit: 1 })).toHaveLength(1);
});

test('describe resolves one tool and returns null for an unknown tool', async () => {
  expect(await describeConnectorTool('project-one', 'slack.send_message')).toMatchObject({
    connector: 'slack',
    action: 'send_message',
  });
  expect(await describeConnectorTool('project-one', 'slack.missing')).toBeNull();
});

test('call accepts one tool identifier and sends the canonical gateway payload', async () => {
  responseBody = { ok: true, data: { ts: '1.2' }, risk: 'write' };

  const result = await callConnector<{ ts: string }>(
    'project-one',
    'slack.send_message',
    { channel: 'C1', text: 'hello' },
  );

  expect(result).toEqual({ ok: true, data: { ts: '1.2' }, risk: 'write' });
  expect(calls[0]?.url).toBe(
    'http://test.local/v1/connectors/projects/project-one/call',
  );
  expect(calls[0]?.method).toBe('POST');
  expect(JSON.parse(String(calls[0]?.body))).toEqual({
    connector: 'slack',
    action: 'send_message',
    args: { channel: 'C1', text: 'hello' },
  });
});

test('call rejects an invalid tool identifier before making a request', async () => {
  await expect(callConnector('project-one', 'send_message')).rejects.toThrow(
    'tool must use the connector.action format',
  );
  expect(calls).toHaveLength(0);
});

test('call preserves an asynchronous approval handoff', async () => {
  responseStatus = 202;
  const approval = {
    ok: false,
    status: 'pending_approval',
    execution_id: 'execution-one',
    retryable: false,
    approval_url: 'https://app.kortix.test/approve/token',
    approval_summary: 'to: finance@example.com',
    approval_instructions: 'Share the approval URL with a human, then stop.',
  } satisfies ConnectorCallResult;
  responseBody = approval;

  expect(
    await callConnector('project-one', 'gmail.send_email', {
      to: 'finance@example.com',
    }),
  ).toEqual(approval);
});

test('attachment upload sends raw bytes through the shared token seam', async () => {
  responseBody = {
    attachment_id: 'attachment-one',
    filename: 'chart.png',
    content_type: 'image/png',
    content_disposition: 'inline',
    content_id: 'chart-one',
    size: 3,
    expires_at: '2026-08-06T20:00:00.000Z',
  };
  const bytes = new Uint8Array([1, 2, 3]);

  const result = await uploadConnectorAttachment('project/one', bytes, {
    filename: 'chart.png',
    contentType: 'image/png',
    contentDisposition: 'inline',
    contentId: 'chart-one',
  });

  expect(result.attachment_id).toBe('attachment-one');
  expect(calls[0]?.url).toBe(
    'http://test.local/v1/connectors/projects/project%2Fone/attachments',
  );
  expect(calls[0]?.method).toBe('POST');
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer agent-token');
  expect(calls[0]?.headers.get('content-type')).toBe('image/png');
  expect(calls[0]?.headers.get('x-kortix-attachment-filename')).toBe('chart.png');
  expect(calls[0]?.headers.get('x-kortix-attachment-disposition')).toBe('inline');
  expect(calls[0]?.headers.get('x-kortix-attachment-content-id')).toBe('chart-one');
  expect(calls[0]?.body).toBe(bytes);
});

test('attachment upload handles an uncontrolled slash-heavy backend URL in linear time', async () => {
  responseBody = {
    attachment_id: 'attachment-one',
    filename: 'chart.png',
    content_type: 'image/png',
    content_disposition: 'attachment',
    content_id: null,
    size: 1,
    expires_at: '2026-08-09T00:00:00.000Z',
  };
  configureKortix({
    backendUrl: `http://test.local/${'/'.repeat(40_000)}x/v1`,
    getToken: async () => 'agent-token',
  });

  const startedAt = performance.now();
  await uploadConnectorAttachment(undefined, new Uint8Array([1]), {
    filename: 'chart.png',
    contentType: 'image/png',
  });

  expect(performance.now() - startedAt).toBeLessThan(200);
  expect(calls[0]?.url.endsWith('/v1/connectors/attachments')).toBe(true);
});

test('gateway failures use the SDK ApiError with the server reason', async () => {
  responseStatus = 403;
  responseBody = { ok: false, status: 'denied', reason: 'not_shared' };

  try {
    await callConnector('project-one', 'slack.send_message');
    throw new Error('expected callConnector to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe('not_shared');
    expect((error as ApiError).details).toEqual(responseBody);
  }
});
