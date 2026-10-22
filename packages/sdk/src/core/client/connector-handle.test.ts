import { beforeEach, expect, mock, test } from 'bun:test';
import { ConnectorCallError, type ConnectorHandle } from '../rest/projects-client/connector-run';
import { createKortix } from './kortix';

// A synthetic generated registry entry, as `kortix connectors types` writes it.
declare module '../rest/projects-client/connectors' {
  interface ConnectorActionRegistry {
    'ke2e-handle': {
      list_rows: {
        args: { table: string; after?: string };
        result: { rows: Array<{ id: string }>; next: string | null };
      };
    };
  }
}

let requests: Array<{ url: string; method: string; body: any }> = [];
let replies: unknown[] = [];
let status = 200;

beforeEach(() => {
  requests = [];
  replies = [];
  status = 200;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const body = replies.length > 1 ? replies.shift() : replies[0];
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const kortix = createKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

test('project(id).connector(slug).run posts to the project route and returns output', async () => {
  replies = [{ ok: true, data: { rows: [{ id: 'r1' }], next: null }, binding: 'openapi', upstream_status: 200 }];
  const handle = kortix.project('PID1').connector('ke2e-handle');

  const page = await handle.run('list_rows', { table: 'orders' }, { account: 'project' });

  expect(handle.slug).toBe('ke2e-handle');
  expect(requests[0]).toMatchObject({
    method: 'POST',
    url: 'http://test.local/v1/connectors/projects/PID1/call',
    body: { connector: 'ke2e-handle', action: 'list_rows', args: { table: 'orders' }, account: 'project' },
  });
  const firstId: string | undefined = page.rows[0]?.id;
  expect(firstId).toBe('r1');

  // @ts-expect-error `table` is required by the generated args type
  await handle.run('list_rows', {});
  // @ts-expect-error an unknown argument is rejected
  await handle.run('list_rows', { table: 'orders', bad: 1 });
});

test('kortix.connector(slug) uses the token-scoped route', async () => {
  replies = [{ ok: true, data: { n: 1 }, binding: 'http', upstream_status: 200 }];
  const output = await kortix.connector('crm').run('count', {});
  expect(requests[0]!.url).toBe('http://test.local/v1/connectors/call');
  expect(output).toEqual({ n: 1 });
});

test('run throws a typed error; call resolves the raw result', async () => {
  status = 403;
  replies = [{ ok: false, status: 'denied', reason: 'connector_not_connected', connect_url: 'https://app.test/c/1' }];
  const handle: ConnectorHandle<'crm'> = kortix.project('PID1').connector('crm');
  const error = await handle.run('list', {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConnectorCallError);
  expect((error as ConnectorCallError).connectUrl).toBe('https://app.test/c/1');

  status = 202;
  replies = [{ ok: false, status: 'pending_approval', execution_id: 'e1' }];
  const raw = await handle.call('send', { to: 'x' });
  expect(raw).toMatchObject({ ok: false, status: 'pending_approval', execution_id: 'e1' });
  expect(requests[1]!.body).toEqual({ connector: 'crm', action: 'send', args: { to: 'x' } });
});

test('describe() reads the connector with input and output schemas; describe(action) one action', async () => {
  replies = [
    {
      connectors: [
        {
          slug: 'crm',
          name: 'CRM',
          provider: 'openapi',
          status: 'active',
          actions: [
            {
              path: 'list',
              name: 'List',
              description: 'List rows',
              risk: 'read',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'array' },
            },
          ],
        },
      ],
    },
  ];
  const handle = kortix.project('PID1').connector('crm');

  const entry = await handle.describe();
  expect(requests[0]!.url).toBe(
    'http://test.local/v1/connectors/projects/PID1/catalog?slug=crm&include_schemas=true&include_output_schemas=true',
  );
  expect(entry?.actions[0]?.outputSchema).toEqual({ type: 'array' });

  const action = await handle.describe('list');
  expect(action).toMatchObject({ tool: 'crm.list', outputSchema: { type: 'array' } });

  replies = [{ connectors: [] }];
  expect(await handle.describe()).toBeNull();
});

test('accounts() lists the accounts of this connector', async () => {
  replies = [{ connector: 'crm', accounts: [{ connection_id: 'c1', label: 'work', owner_type: 'user', is_default: true }] }];
  const accounts = await kortix.project('PID1').connector('crm').accounts();
  expect(requests[0]!.url).toBe('http://test.local/v1/connectors/projects/PID1/connectors/crm/accounts');
  expect(accounts.map((a) => a.label)).toEqual(['work']);
});

test('paginate follows a typed cursor', async () => {
  replies = [
    { ok: true, data: { rows: [{ id: 'a' }], next: 'c2' }, binding: 'openapi', upstream_status: 200 },
    { ok: true, data: { rows: [{ id: 'b' }], next: null }, binding: 'openapi', upstream_status: 200 },
  ];
  const ids: string[] = [];
  for await (const page of kortix.project('PID1').connector('ke2e-handle').paginate(
    'list_rows',
    { table: 'orders' },
    { next: (page, args) => (page.next ? { ...args, after: page.next } : undefined) },
  )) {
    ids.push(...page.rows.map((row) => row.id));
  }
  expect(ids).toEqual(['a', 'b']);
  expect(requests[1]!.body.args).toEqual({ table: 'orders', after: 'c2' });
});

test('uploadAttachment names this connector', async () => {
  status = 201;
  replies = [{ attachment_id: 'att1', filename: 'a.txt', content_type: 'text/plain', size: 1 }];
  await kortix.project('PID1').connector('microsoft-graph').uploadAttachment(new Uint8Array([1]), {
    filename: 'a.txt',
    contentType: 'text/plain',
  });
  const sent = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
  const headers = new Headers((sent[1] as RequestInit).headers);
  expect(headers.get('X-Kortix-Attachment-Connector')).toBe('microsoft-graph');
});
