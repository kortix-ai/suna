import { expect, test } from 'bun:test';
import { createStdioMcpTools } from './stdio-mcp-tools';
import { PermissionBroker } from './permission-broker';
import { protectToolsWithPermissions } from './permission-tools';

function fixture() {
  const requests: any[] = [];
  const config = {
    fixture: {
      type: 'local' as const,
      command: ['node', '/workspace/server.mjs'],
      environment: { KEY: '{env:CONFIG_SECRET}' },
    },
  };
  let result: any = {
    tools: [{ name: 'counter', inputSchema: { type: 'object' } }],
    nextCursor: 'page2',
  };
  const env = {
    mcpRequest: async (input: any, signal?: AbortSignal) => {
      requests.push({ input, signal });
      return {
        ok: true as const,
        value: { connectionId: 'connection-1', result },
      };
    },
    mcpDisconnect: async (server: string, connectionId: string) => {
      requests.push({ server, connectionId });
      return { ok: true as const, value: { disconnected: true as const } };
    },
  };
  const tools = createStdioMcpTools(config, env as any);
  const call = (name: string, input: any, signal?: AbortSignal) =>
    tools.find((tool) => tool.name === name)!.execute('call-1', input, signal);
  return {
    requests,
    config,
    tools,
    call,
    env,
    result: (next: any) => {
      result = next;
    },
  };
}

test('custom MCP registration is lazy, isolated, and absent without enabled servers', async () => {
  const f = fixture();
  expect(f.requests).toEqual([]);
  expect(createStdioMcpTools(undefined, f.env as any)).toEqual([]);
  expect(
    createStdioMcpTools(
      { fixture: { ...f.config.fixture, enabled: false } },
      f.env as any,
    ),
  ).toEqual([]);
  f.config.fixture.command[0] = 'changed';
  const output = await f.call('mcp_list', { server: 'fixture' });
  expect(f.requests[0].input.configuration.command[0]).toBe('node');
  expect(output.content[0]).toEqual({
    type: 'text',
    text: JSON.stringify({ server: 'fixture', connectionId: 'connection-1' }),
  });
  expect(JSON.stringify(output)).toContain('page2');
  expect(JSON.stringify(output)).not.toContain('CONFIG_SECRET');
});

test.each([
  [
    'mcp_list',
    { kind: 'templates', cursor: 'page2' },
    'resources/templates/list',
    { cursor: 'page2' },
  ],
  [
    'mcp_call',
    { connectionId: 'c1', tool: 'counter', arguments: { value: 'exact' } },
    'tools/call',
    { name: 'counter', arguments: { value: 'exact' } },
  ],
  [
    'mcp_read_resource',
    { connectionId: 'c1', uri: 'fixture://value' },
    'resources/read',
    { uri: 'fixture://value' },
  ],
  [
    'mcp_get_prompt',
    { connectionId: 'c1', prompt: 'review', arguments: { file: 'a' } },
    'prompts/get',
    { name: 'review', arguments: { file: 'a' } },
  ],
] as const)(
  '%s sends the configured server and exact MCP request',
  async (name, input, method, params) => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.call(name, { server: 'fixture', ...input }, signal);
    expect(f.requests).toEqual([
      {
        input: {
          server: 'fixture',
          configuration: f.config.fixture,
          method,
          params,
          ...('connectionId' in input
            ? { connectionId: input.connectionId }
            : {}),
        },
        signal,
      },
    ]);
  },
);

test('MCP input rejects arbitrary commands, undeclared servers, missing identities, and pre-aborted requests', async () => {
  const f = fixture();
  for (const input of [
    { server: 'other' },
    { server: 'fixture', command: ['bash'] },
  ])
    await expect(f.call('mcp_list', input)).rejects.toThrow(/Invalid/);
  await expect(
    f.call('mcp_call', { server: 'fixture', tool: 'counter', arguments: {} }),
  ).rejects.toThrow(/Invalid/);
  await expect(
    f.call('mcp_list', { server: 'fixture' }, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(f.requests).toEqual([]);
  expect(
    await f.call('mcp_disconnect', { server: 'fixture', connectionId: 'c1' }),
  ).toMatchObject({
    content: [{ type: 'text', text: '{"disconnected":true}' }],
  });
});

test('MCP results keep images and embedded resources; server errors become tool errors', async () => {
  const f = fixture();
  f.result({
    content: [
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      {
        type: 'resource',
        resource: { uri: 'fixture://value', text: 'RESOURCE_OK' },
      },
    ],
  });
  const output = await f.call('mcp_call', {
    server: 'fixture',
    connectionId: 'c1',
    tool: 'image',
    arguments: {},
  });
  expect(output.content).toContainEqual({
    type: 'image',
    mimeType: 'image/png',
    data: 'aW1hZ2U=',
  });
  expect(JSON.stringify(output)).toContain('RESOURCE_OK');
  f.result({
    isError: true,
    content: [{ type: 'text', text: 'FIXTURE_ERROR' }],
  });
  await expect(
    f.call('mcp_call', {
      server: 'fixture',
      connectionId: 'c1',
      tool: 'error',
      arguments: {},
    }),
  ).rejects.toThrow('FIXTURE_ERROR');
});

test('MCP permission denial and Stop prevent execution before environment allocation', async () => {
  const f = fixture();
  const broker = new PermissionBroker({
    sessionId: 'session',
    publish: () => {},
    permission: { mcp_call: { '*': 'ask', 'fixture:delete': 'deny' } },
  });
  const tools = protectToolsWithPermissions(f.tools, broker, '/workspace');
  const tool = tools.find((tool) => tool.name === 'mcp_call')!;
  await expect(
    tool.execute('delete', {
      server: 'fixture',
      connectionId: 'c1',
      tool: 'delete',
      arguments: {},
    }),
  ).rejects.toThrow(/denied/);
  const stop = new AbortController();
  const pending = tool.execute(
    'read',
    { server: 'fixture', connectionId: 'c1', tool: 'read', arguments: {} },
    stop.signal,
  );
  expect(broker.list()).toMatchObject([{ patterns: ['fixture:read'] }]);
  expect(JSON.stringify(broker.list())).not.toContain('CONFIG_SECRET');
  stop.abort();
  await expect(pending).rejects.toThrow();
  expect(f.requests).toEqual([]);
});
