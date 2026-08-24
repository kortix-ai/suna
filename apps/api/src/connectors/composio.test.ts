import { expect, test } from 'bun:test';
import {
  composioCatalogPage,
  composioConnectUrl,
  composioSessionTools,
  composioUserId,
  executeComposio,
  finalizeComposioConnection,
  type ComposioRuntime,
  type ComposioSessionLike,
} from './composio';
import { handleCall, type GatewayDeps, type GatewayConnector } from './gateway';
import { normalizeComposio } from './normalize';

type ToolkitItem = Awaited<ReturnType<ComposioSessionLike['toolkits']>>['items'][number];

function session(
  input: {
    id?: string;
    tools?: ComposioSessionLike['tools'] extends (...args: never[]) => Promise<infer T> ? T : never;
    toolkit?: ToolkitItem;
    execute?: ComposioSessionLike['execute'];
    authorize?: ComposioSessionLike['authorize'];
  } = {},
): ComposioSessionLike {
  return {
    sessionId: input.id ?? 'session-1',
    async tools() {
      return input.tools ?? [];
    },
    async toolkits() {
      return {
        items: input.toolkit ? [input.toolkit] : [],
        cursor: undefined,
        totalPages: 1,
      };
    },
    authorize:
      input.authorize ??
      (async () => ({
        id: 'auth-request-1',
        status: 'INITIATED',
        redirectUrl: 'https://composio.test/connect',
        toJSON: () => ({
          id: 'auth-request-1',
          status: 'INITIATED',
          redirectUrl: 'https://composio.test/connect',
        }),
      })),
    execute: input.execute ?? (async () => ({ data: { ok: true }, error: null, logId: 'log-123' })),
  };
}

function fakeRuntime(
  input: {
    created?: ComposioSessionLike;
    resumed?: ComposioSessionLike;
    calls?: Array<Record<string, unknown>>;
    catalogPage?: Awaited<ReturnType<NonNullable<ComposioRuntime['toolkits']>['get']>>;
    authConfigs?: Array<{ id: string; name: string }>;
  } = {},
): ComposioRuntime {
  const calls = input.calls ?? [];
  return {
    sessions: {
      async create(userId, config) {
        calls.push({ type: 'create', userId, config });
        return input.created ?? session();
      },
      async use(sessionId) {
        calls.push({ type: 'use', sessionId });
        return input.resumed ?? input.created ?? session({ id: sessionId });
      },
    },
    ...(input.catalogPage
      ? {
          toolkits: {
            async get(query) {
              calls.push({ type: 'catalog', query });
              return input.catalogPage!;
            },
          },
        }
      : {}),
    ...(input.authConfigs
      ? {
          authConfigs: {
            async list(query) {
              calls.push({ type: 'auth-config-list', query });
              return { items: input.authConfigs! };
            },
            async create(toolkit, options) {
              calls.push({ type: 'auth-config-create', toolkit, options });
              return { id: 'auth-config-created' };
            },
          },
        }
      : {}),
  };
}

test('composioUserId is always connection-scoped', () => {
  expect(composioUserId('connection-1')).toBe('kortix-connection:connection-1');
  expect(() => composioUserId(' ')).toThrow('composio connection id is required');
});

test('normalizeComposio maps the installed 0.17 OpenAI-style session tools', () => {
  const actions = normalizeComposio(
    [
      {
        type: 'function',
        function: {
          name: 'GMAIL_SEND_EMAIL',
          description: 'Send one email',
          parameters: {
            type: 'object',
            properties: { to: { type: 'string' } },
            required: ['to'],
          },
        },
      },
    ],
    'gmail',
  );

  expect(actions).toEqual([
    {
      path: 'send_email',
      name: 'GMAIL_SEND_EMAIL',
      description: 'Send one email',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
      outputSchema: null,
      risk: 'write',
      binding: {
        kind: 'composio',
        toolkit: 'gmail',
        toolSlug: 'GMAIL_SEND_EMAIL',
      },
    },
  ]);
});

test('composioSessionTools creates a direct-tools session with the sandbox disabled', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'HACKERNEWS_GET_TOP_STORIES',
        parameters: { type: 'object' },
      },
    },
  ];
  const result = await composioSessionTools({
    connectionId: 'connection-1',
    toolkit: 'hackernews',
    runtime: fakeRuntime({ created: session({ tools }), calls }),
  });

  expect(result).toEqual(tools);
  expect(calls).toEqual([
    {
      type: 'create',
      userId: 'kortix-connection:connection-1',
      config: {
        sessionPreset: 'direct_tools',
        toolkits: ['hackernews'],
        manageConnections: false,
        sandbox: { enable: false },
      },
    },
  ]);
});

test('composioSessionTools resumes the persisted session id', async () => {
  const calls: Array<Record<string, unknown>> = [];
  await composioSessionTools({
    connectionId: 'connection-1',
    toolkit: 'hackernews',
    sessionId: 'persisted-session',
    runtime: fakeRuntime({ calls }),
  });
  expect(calls).toEqual([{ type: 'use', sessionId: 'persisted-session' }]);
});

test('composioConnectUrl uses session.authorize and does not treat its id as the connected account', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const created = session({
    toolkit: { slug: 'gmail', name: 'Gmail', isNoAuth: false },
    authorize: async (toolkit, options) => {
      calls.push({ type: 'authorize', toolkit, options });
      return {
        id: 'auth-request-1',
        status: 'INITIATED',
        redirectUrl: 'https://composio.test/connect',
        toJSON: () => ({
          id: 'auth-request-1',
          status: 'INITIATED',
          redirectUrl: 'https://composio.test/connect',
        }),
      };
    },
  });

  const result = await composioConnectUrl({
    projectId: 'project-1',
    slug: 'gmail',
    app: 'gmail',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    redirects: { success: 'https://kortix.test/success' },
    runtime: fakeRuntime({
      created,
      calls,
      authConfigs: [{ id: 'auth-config-existing', name: 'Kortix Gmail managed actions v1' }],
    }),
  });

  expect(result).toEqual({
    connectUrl: 'https://composio.test/connect',
    sessionId: 'session-1',
    authRequestId: 'auth-request-1',
    connected: false,
    isNoAuth: false,
  });
  expect(calls.at(-1)).toEqual({
    type: 'authorize',
    toolkit: 'gmail',
    options: { callbackUrl: 'https://kortix.test/success', alias: 'gmail' },
  });
});

test('composioConnectUrl binds Gmail to a managed auth config with explicit mail scopes', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const created = session({
    toolkit: { slug: 'gmail', name: 'Gmail', isNoAuth: false },
  });

  await composioConnectUrl({
    projectId: 'project-1',
    slug: 'gmail',
    app: 'gmail',
    connectionId: 'connection-scoped-gmail',
    stableUserId: 'kortix-connection:connection-scoped-gmail',
    runtime: fakeRuntime({ created, calls, authConfigs: [] }),
  });

  expect(calls[0]).toEqual({
    type: 'auth-config-list',
    query: {
      toolkit: 'gmail',
      search: 'Kortix Gmail managed actions v1',
      isComposioManaged: true,
      limit: 100,
    },
  });
  expect(calls[1]).toEqual({
    type: 'auth-config-create',
    toolkit: 'gmail',
    options: {
      type: 'use_composio_managed_auth',
      name: 'Kortix Gmail managed actions v1',
      credentials: {
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/gmail.labels',
        ].join(','),
      },
      isEnabledForToolRouter: true,
    },
  });
  expect(calls[2]).toMatchObject({
    type: 'create',
    config: {
      authConfigs: { gmail: 'auth-config-created' },
    },
  });
});

test('composioConnectUrl completes no-auth toolkits without authorization', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const created = session({
    toolkit: {
      slug: 'composio_search',
      name: 'Composio Search',
      isNoAuth: true,
    },
    authorize: async () => {
      throw new Error('authorize must not run for no-auth toolkits');
    },
  });

  const result = await composioConnectUrl({
    projectId: 'project-1',
    slug: 'search',
    app: 'composio_search',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    runtime: fakeRuntime({ created, calls }),
  });

  expect(result).toEqual({
    sessionId: 'session-1',
    connected: true,
    isNoAuth: true,
  });
  expect(calls.some((call) => call.type === 'authorize')).toBe(false);
});

test('finalizeComposioConnection resumes the persisted session and reads the active account', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const resumed = session({
    id: 'persisted-session',
    toolkit: {
      slug: 'gmail',
      name: 'Gmail',
      isNoAuth: false,
      connection: {
        isActive: true,
        connectedAccount: { id: 'connected-account-1', status: 'ACTIVE' },
      },
    },
  });

  const result = await finalizeComposioConnection({
    projectId: 'project-1',
    slug: 'gmail',
    app: 'gmail',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    sessionId: 'persisted-session',
    authRequestId: 'auth-request-1',
    runtime: fakeRuntime({ resumed, calls }),
  });

  expect(result).toEqual({
    connected: true,
    connectedAccountId: 'connected-account-1',
    sessionId: 'persisted-session',
    authRequestId: 'auth-request-1',
    isNoAuth: false,
  });
  expect(calls).toEqual([{ type: 'use', sessionId: 'persisted-session' }]);
});

test('executeComposio resumes the selected connection session and returns real data plus log id', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const resumed = session({
    id: 'persisted-session',
    toolkit: {
      slug: 'gmail',
      name: 'Gmail',
      isNoAuth: false,
      connection: {
        isActive: true,
        connectedAccount: { id: 'connected-account-1', status: 'ACTIVE' },
      },
    },
    execute: async (toolSlug, args, options) => {
      calls.push({ type: 'execute', toolSlug, args, options });
      return { data: { sent: true }, error: null, logId: 'log-123' };
    },
  });

  const result = await executeComposio({
    projectId: 'project-1',
    connectorSlug: 'gmail',
    connectionId: 'connection-1',
    sessionId: 'persisted-session',
    toolkit: 'gmail',
    toolSlug: 'GMAIL_SEND_EMAIL',
    args: { to: 'a@example.com' },
    connectedAccountId: 'connected-account-1',
    runtime: fakeRuntime({ resumed, calls }),
  });

  expect(result).toEqual({
    ok: true,
    status: 200,
    data: {
      provider: 'composio',
      requestId: 'log-123',
      logId: 'log-123',
      sessionId: 'persisted-session',
      result: { sent: true },
    },
  });
  expect(calls).toEqual([
    { type: 'use', sessionId: 'persisted-session' },
    {
      type: 'execute',
      toolSlug: 'GMAIL_SEND_EMAIL',
      args: { to: 'a@example.com' },
      options: undefined,
    },
  ]);
});

test('executeComposio supports no-auth direct tools without an account id', async () => {
  const resumed = session({
    id: 'persisted-session',
    toolkit: {
      slug: 'composio_search',
      name: 'Composio Search',
      isNoAuth: true,
    },
    execute: async () => ({
      data: { results: [{ title: 'Kortix' }] },
      error: null,
      logId: 'log-search',
    }),
  });
  const result = await executeComposio({
    projectId: 'project-1',
    connectorSlug: 'search',
    connectionId: 'connection-1',
    sessionId: 'persisted-session',
    toolkit: 'composio_search',
    toolSlug: 'COMPOSIO_SEARCH_DUCK_DUCK_GO',
    args: { query: 'Kortix' },
    connectedAccountId: null,
    runtime: fakeRuntime({ resumed }),
  });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    logId: 'log-search',
    result: { results: [{ title: 'Kortix' }] },
  });
});

test('executeComposio fails closed when the resumed session is bound to another account', async () => {
  const resumed = session({
    toolkit: {
      slug: 'gmail',
      name: 'Gmail',
      isNoAuth: false,
      connection: {
        isActive: true,
        connectedAccount: { id: 'wrong-account', status: 'ACTIVE' },
      },
    },
  });
  await expect(
    executeComposio({
      projectId: 'project-1',
      connectorSlug: 'gmail',
      connectionId: 'connection-1',
      sessionId: 'persisted-session',
      toolkit: 'gmail',
      toolSlug: 'GMAIL_SEND_EMAIL',
      args: {},
      connectedAccountId: 'connected-account-1',
      runtime: fakeRuntime({ resumed }),
    }),
  ).rejects.toThrow('composio_connected_account_mismatch');
});

test('executeComposio rejects an empty Composio log id', async () => {
  const resumed = session({
    toolkit: {
      slug: 'composio_search',
      name: 'Composio Search',
      isNoAuth: true,
    },
    execute: async () => ({ data: {}, error: null, logId: ' ' }),
  });
  await expect(
    executeComposio({
      projectId: 'project-1',
      connectorSlug: 'search',
      connectionId: 'connection-1',
      sessionId: 'persisted-session',
      toolkit: 'composio_search',
      toolSlug: 'COMPOSIO_SEARCH_DUCK_DUCK_GO',
      args: {},
      connectedAccountId: null,
      runtime: fakeRuntime({ resumed }),
    }),
  ).rejects.toThrow('composio execution returned no log id');
});

test('composioCatalogPage uses a discovery-only identity and session.toolkits pagination', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const created = session({
    toolkit: {
      slug: 'composio_search',
      name: 'Composio Search',
      isNoAuth: true,
    },
  });
  created.toolkits = async (options) => {
    calls.push({ type: 'toolkits', options });
    return {
      items: [{ slug: 'composio_search', name: 'Composio Search', isNoAuth: true }],
      cursor: 'next-page',
      totalPages: 2,
    };
  };

  const result = await composioCatalogPage({
    projectId: 'project-1',
    q: 'search',
    cursor: 'cursor-1',
    limit: 20,
    runtime: fakeRuntime({ created, calls }),
  });

  expect(result).toEqual({
    items: [{ slug: 'composio_search', name: 'Composio Search', isNoAuth: true }],
    cursor: 'next-page',
    totalPages: 2,
  });
  expect(calls).toEqual([
    {
      type: 'create',
      userId: 'kortix-discovery:project-1',
      config: { manageConnections: false, sandbox: { enable: false } },
    },
    {
      type: 'toolkits',
      options: { search: 'search', cursor: 'cursor-1', limit: 20 },
    },
  ]);
});

test('composioCatalogPage applies category filtering to the provider catalogue', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await composioCatalogPage({
    projectId: 'project-1',
    q: 'mail',
    category: 'productivity',
    cursor: 'cursor-1',
    limit: 20,
    runtime: fakeRuntime({
      calls,
      catalogPage: [
        {
          slug: 'gmail',
          name: 'Gmail',
          noAuth: false,
          meta: {
            logo: 'https://cdn.example.test/gmail.svg',
            description: 'Email',
            categories: [{ slug: 'productivity', name: 'Productivity' }],
          },
        },
      ],
    }),
  });

  expect(calls).toEqual([{ type: 'catalog', query: { category: 'productivity', limit: 1000 } }]);
  expect(result).toEqual({
    provider: 'composio',
    toolkits: [
      {
        slug: 'gmail',
        name: 'Gmail',
        logo: 'https://cdn.example.test/gmail.svg',
        description: 'Email',
        categories: ['productivity'],
        isNoAuth: false,
        connected: false,
      },
    ],
    total: 1,
    hasMore: false,
  });
});

test('gateway executes Composio with selected-row metadata and never exposes a secret', async () => {
  const connector: GatewayConnector = {
    connectorId: 'connector-1',
    connectionId: 'connection-1',
    connectionIsDefault: true,
    connectionMetadata: {
      session_id: 'persisted-session',
      connected_account_id: 'connected-account-1',
    },
    slug: 'gmail',
    provider: 'composio',
    platform: 'gmail',
    baseUrl: null,
    auth: { type: 'none', in: 'header', name: null, prefix: null },
    hasAuth: true,
    credentialMode: 'shared',
    enabled: true,
  };
  const executions: Array<Record<string, unknown>> = [];
  const deps: GatewayDeps = {
    async loadConnectorBySlug() {
      return connector;
    },
    async loadAction() {
      return {
        path: 'gmail.send_email',
        relPath: 'send_email',
        inputSchema: null,
        risk: 'write',
        binding: {
          kind: 'composio',
          toolkit: 'gmail',
          toolSlug: 'GMAIL_SEND_EMAIL',
        },
      };
    },
    async resolveCredential() {
      throw new Error('Composio must not use connector credentials');
    },
    async loadPolicies() {
      return [];
    },
    async recordExecution(rec) {
      executions.push(rec as unknown as Record<string, unknown>);
      return 'exec-1';
    },
    fetchImpl: async () => new Response('{}'),
    enforcePolicies: false,
    async executeComposio(input) {
      executions.push({ composioInput: input });
      return {
        ok: true,
        status: 200,
        data: {
          provider: 'composio',
          requestId: 'log-123',
          logId: 'log-123',
          sessionId: 'persisted-session',
          result: { sent: true },
        },
      };
    },
  };

  const result = await handleCall(deps, {
    projectId: 'project-1',
    accountId: 'account-1',
    subject: { userId: 'user-1', groupIds: [] },
    sessionId: 'kortix-session-1',
    connectorSlug: 'gmail',
    actionPath: 'send_email',
    args: { to: 'a@example.com' },
  });

  expect(result).toEqual({
    status: 'ok',
    risk: 'write',
    data: {
      provider: 'composio',
      requestId: 'log-123',
      logId: 'log-123',
      sessionId: 'persisted-session',
      result: { sent: true },
    },
  });
  expect(executions[0]).toEqual({
    composioInput: {
      projectId: 'project-1',
      connectorSlug: 'gmail',
      connectionId: 'connection-1',
      sessionId: 'persisted-session',
      toolkit: 'gmail',
      toolSlug: 'GMAIL_SEND_EMAIL',
      args: { to: 'a@example.com' },
      connectedAccountId: 'connected-account-1',
    },
  });
  expect(JSON.stringify(executions)).not.toContain('COMPOSIO_API_KEY');
});
