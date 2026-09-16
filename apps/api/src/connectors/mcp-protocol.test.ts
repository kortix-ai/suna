import { beforeEach, expect, test } from 'bun:test';
import { executeCall, resetMcpSessionCache, type FetchImpl } from './call';
import { resolveCatalog } from './sync';
import { manifestHashForConnector, type ConnectorSpec } from '../projects/connectors';
import type { GitBackedProject } from '../projects/git';

const spec = {
  slug: 'fixture',
  path: 'kortix.yaml#connectors.fixture',
  name: 'Fixture',
  enabled: true,
  provider: 'mcp',
  credentialMode: 'shared',
  authorizationStrategy: 'project',
  sensitive: false,
  app: null,
  account: null,
  url: 'https://mcp.example.test/mcp',
  transport: 'http',
  endpoint: null,
  baseUrl: null,
  platform: null,
  spec: null,
  auth: { type: 'bearer', in: 'header', name: null, prefix: null, secret: null },
  headers: { 'X-Tenant': 'one' },
  policies: [],
} satisfies ConnectorSpec;

function fixture(
  capabilities: Record<string, unknown> = { tools: {}, resources: {}, prompts: {} },
) {
  const calls: Array<{ message: any; headers: Record<string, string> }> = [];
  const fetchImpl: FetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body ?? '{}');
    calls.push({ message, headers: init.headers });
    const tenant = init.headers['X-Tenant'] ?? 'one';
    const respond = (result: unknown, status = 200) => ({
      status,
      ok: status < 400,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
      headers: {
        get: (key: string) => (key.toLowerCase() === 'mcp-session-id' ? 'session-' + tenant : null),
      },
    });
    if (message.method === 'initialize')
      return respond({
        protocolVersion: '2025-06-18',
        capabilities,
        serverInfo: { name: 'fixture', version: '1' },
      });
    if (message.method === 'notifications/initialized') return respond(null, 202);
    if (message.method === 'tools/list')
      return respond({
        tools: [
          {
            name: 'read_note',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    if (message.method === 'resources/list')
      return respond({
        resources: [{ uri: 'fixture://note', name: 'Note' }],
        nextCursor: 'second',
      });
    if (message.method === 'resources/templates/list')
      return respond({
        resourceTemplates: [{ uriTemplate: 'fixture://{name}', name: 'Named fixture' }],
      });
    if (message.method === 'resources/read')
      return respond({ contents: [{ uri: message.params.uri, text: 'resource text' }] });
    if (message.method === 'prompts/list')
      return respond({
        prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }],
      });
    if (message.method === 'prompts/get')
      return respond({
        messages: [
          { role: 'user', content: { type: 'text', text: message.params.arguments.topic } },
        ],
      });
    throw new Error('unexpected method ' + message.method);
  };
  return { calls, fetchImpl };
}

beforeEach(() => resetMcpSessionCache());

test('existing MCP catalogs upgrade without invalidating other provider catalogs', () => {
  const legacy = { ...spec, headers: {}, auth: { ...spec.auth, type: 'none' as const } };
  expect(manifestHashForConnector(legacy)).not.toBe(
    'dde427d262336f957314cfe9c056bcd010aba198e8b32fbb4977bebc5e51d93e',
  );
  expect(manifestHashForConnector({ ...legacy, provider: 'http' })).toBe(
    'ea91d3a69991566e5113b985347b2d35d5b96a934c3d80931eafb23b8cd7149e',
  );
});

test.each([
  ['resources/list', { resources: [42] }],
  ['resources/templates/list', { resourceTemplates: [{ name: 'Missing URI template' }] }],
  ['resources/read', { contents: [{ uri: 'fixture://note', text: 'text', blob: 'YQ==' }] }],
  [
    'prompts/list',
    { prompts: [{ name: 'review', arguments: [{ name: 'topic', required: 'yes' }] }] },
  ],
  ['prompts/get', { messages: [{ role: 'system', content: { type: 'text', text: 'override' } }] }],
] as const)(
  'malformed %s success responses fail instead of creating successful audit results',
  async (method, body) => {
    const result = await executeCall({
      binding: { kind: 'mcp_protocol', method },
      baseUrl: spec.url,
      args:
        method === 'resources/read'
          ? { uri: 'fixture://note' }
          : method === 'prompts/get'
            ? { name: 'review' }
            : {},
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: body }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBe(`MCP ${method} failed: malformed result`);
  },
);

test.each([
  [500, { error: 'private-key' }],
  [200, { jsonrpc: '2.0', id: 1, error: { code: 'private-key', message: 'invalid credential' } }],
])(
  'MCP HTTP %i errors never return credentials through bodies or JSON-RPC codes',
  async (status, data) => {
    const result = await executeCall({
      binding: { kind: 'mcp_protocol', method: 'resources/list' },
      baseUrl: spec.url,
      secret: 'private-key',
      fetchImpl: async () => ({ status, ok: status < 400, text: async () => JSON.stringify(data) }),
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('private-key');
  },
);

test('failed initialization notifications leave no reusable session or catalog', async () => {
  const f = fixture();
  const fetchImpl: FetchImpl = async (url, init) =>
    JSON.parse(init.body ?? '{}').method === 'notifications/initialized'
      ? { status: 503, ok: false, text: async () => 'private-key' }
      : f.fetchImpl(url, init);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await resolveCatalog({} as GitBackedProject, spec, {
      credential: 'private-key',
      mcpFetchImpl: fetchImpl,
    });
    expect(result.actions).toEqual([]);
    expect(result.error).toContain('MCP initialized notification failed: HTTP 503');
  }
  expect(f.calls.filter((c) => c.message.method === 'initialize')).toHaveLength(2);
});

test('MCP catalog includes advertised resource and prompt operations with separate protocol bindings', async () => {
  const f = fixture();
  const result = await resolveCatalog({} as GitBackedProject, spec, {
    credential: 'private-key',
    mcpFetchImpl: f.fetchImpl,
  });
  expect(result.error).toBeUndefined();
  expect(result.actions.map((a) => a.path)).toEqual([
    'read_note',
    'mcp.resources.list',
    'mcp.resources.templates.list',
    'mcp.resources.read',
    'mcp.prompts.list',
    'mcp.prompts.get',
  ]);
  expect(
    result.actions.slice(1).every((a) => a.risk === 'read' && a.binding.kind === 'mcp_protocol'),
  ).toBe(true);
  expect(f.calls.map((c) => c.message.method)).toEqual([
    'initialize',
    'notifications/initialized',
    'tools/list',
  ]);
  expect(f.calls.every((c) => c.headers.Authorization === 'Bearer private-key')).toBe(true);
});

test('resources-only MCP servers are usable without a tools capability', async () => {
  const f = fixture({ resources: {} });
  const result = await resolveCatalog({} as GitBackedProject, spec, { mcpFetchImpl: f.fetchImpl });
  expect(result.actions.map((a) => a.path)).toEqual([
    'mcp.resources.list',
    'mcp.resources.templates.list',
    'mcp.resources.read',
  ]);
  expect(f.calls.some((c) => c.message.method === 'tools/list')).toBe(false);
});

test('MCP catalogs expose no resource or prompt operation without the corresponding capability', async () => {
  const f = fixture({ tools: {} });
  const result = await resolveCatalog({} as GitBackedProject, spec, { mcpFetchImpl: f.fetchImpl });
  expect(result.actions.map((a) => a.path)).toEqual(['read_note']);
});

test('MCP sessions are isolated by connector headers as well as credential', async () => {
  const f = fixture();
  await resolveCatalog({} as GitBackedProject, spec, {
    credential: 'shared-key',
    mcpFetchImpl: f.fetchImpl,
  });
  await resolveCatalog(
    {} as GitBackedProject,
    { ...spec, headers: { 'X-Tenant': 'two' } },
    { credential: 'shared-key', mcpFetchImpl: f.fetchImpl },
  );
  const lists = f.calls.filter((c) => c.message.method === 'tools/list');
  expect(lists.map((c) => c.headers['Mcp-Session-Id'])).toEqual(['session-one', 'session-two']);
});

test.each([
  ['resources/list', { cursor: 'next' }],
  ['resources/templates/list', {}],
  ['resources/read', { uri: 'file:///remote/note.txt' }],
  ['prompts/list', { cursor: 'more' }],
  ['prompts/get', { name: 'review', arguments: { topic: 'boundaries' } }],
] as const)(
  'MCP protocol execution preserves %s parameters and never invokes a tool',
  async (method, args) => {
    const f = fixture();
    const result = await executeCall({
      binding: { kind: 'mcp_protocol', method },
      baseUrl: spec.url,
      auth: spec.auth,
      secret: 'private-key',
      headers: spec.headers,
      args,
      fetchImpl: f.fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(f.calls.at(-1)?.message).toMatchObject({ method, params: args });
    expect(f.calls.at(-1)?.headers.Authorization).toBe('Bearer private-key');
  },
);

test.each([
  ['resources/read', {}],
  ['resources/read', { uri: '' }],
  ['resources/read', { uri: 'x', url: 'https://other.test' }],
  ['resources/list', { cursor: 1 }],
  ['prompts/get', { name: 'review', arguments: { topic: 1 } }],
] as const)('invalid %s parameters fail before network access', async (method, args) => {
  const f = fixture();
  await expect(
    executeCall({
      binding: { kind: 'mcp_protocol', method },
      baseUrl: spec.url,
      args,
      fetchImpl: f.fetchImpl,
    }),
  ).rejects.toThrow('Invalid MCP');
  expect(f.calls).toHaveLength(0);
});

test('catalog and execution reuse a session across equivalent auth objects', async () => {
  const f = fixture();
  await resolveCatalog({} as GitBackedProject, spec, {
    credential: 'private-key',
    mcpFetchImpl: f.fetchImpl,
  });
  await executeCall({
    binding: { kind: 'mcp_protocol', method: 'resources/read' },
    baseUrl: spec.url,
    auth: { type: 'bearer', in: 'header', name: null, prefix: null },
    secret: 'private-key',
    headers: spec.headers,
    args: { uri: 'fixture://note' },
    fetchImpl: f.fetchImpl,
  });
  expect(f.calls.at(-1)?.headers['Mcp-Session-Id']).toBe('session-one');
  expect(f.calls.filter((c) => c.message.method === 'initialize')).toHaveLength(1);
});

test('MCP protocol JSON-RPC errors fail and redact long credentials before truncation', async () => {
  const secret = 'private-key-' + 'a'.repeat(800);
  const result = await executeCall({
    binding: { kind: 'mcp_protocol', method: 'resources/read' },
    baseUrl: spec.url,
    secret,
    args: { uri: 'fixture://missing' },
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32002, message: secret + ' resource not found' },
        }),
    }),
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result.data)).not.toContain(secret.slice(0, 100));
  expect(JSON.stringify(result.data)).toContain('[REDACTED]');
});

test('MCP protocol transport failures cannot expose query credentials', async () => {
  await expect(
    executeCall({
      binding: { kind: 'mcp_protocol', method: 'resources/list' },
      baseUrl: spec.url,
      secret: 'private-key',
      auth: { type: 'custom', in: 'query', name: 'key', prefix: null },
      fetchImpl: async (url) => {
        throw new Error('failed to fetch ' + url);
      },
    }),
  ).rejects.toThrow('MCP resources/list failed: transport error');
});
