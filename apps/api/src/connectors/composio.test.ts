import { expect, test } from 'bun:test';
import type { HTTPException } from 'hono/http-exception';
import type { ComposioCatalogClient } from './composio-catalog-search';
import {
  composioCatalogPage,
  composioCatalogTools,
  composioConnectUrl,
  composioSessionTools,
  composioUserId,
  executeComposio,
  finalizeComposioConnection,
  invalidToolkitSlugsFromError,
  probeComposioIdentity,
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

test('composioConnectUrl retries under a fresh alias when Composio says the slug alias is taken', async () => {
  // A previous Connect left a non-active account aliased `github`; Composio
  // refuses the slug alias with ConnectedAccount_BadRequest. The retry must
  // use a different alias and the caller must still get a connect URL.
  const aliases: Array<string | undefined> = [];
  const created = session({
    toolkit: { slug: 'github', name: 'GitHub', isNoAuth: false },
    authorize: async (_toolkit, options) => {
      aliases.push(options?.alias);
      if (aliases.length === 1) {
        throw new Error(
          '400 {"error":{"message":"Alias \\"github\\" is already in use by another connection for this entity","code":600,"slug":"ConnectedAccount_BadRequest","status":400}}',
        );
      }
      return {
        id: 'auth-request-2',
        status: 'INITIATED',
        redirectUrl: 'https://composio.test/connect-2',
        toJSON: () => ({
          id: 'auth-request-2',
          status: 'INITIATED',
          redirectUrl: 'https://composio.test/connect-2',
        }),
      };
    },
  });

  const result = await composioConnectUrl({
    projectId: 'project-1',
    slug: 'github',
    app: 'github',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    runtime: fakeRuntime({ created }),
  });

  expect(aliases[0]).toBe('github');
  expect(aliases[1]).toMatch(/^github-[0-9a-z]+$/);
  expect(aliases[1]).not.toBe('github');
  expect(result.connectUrl).toBe('https://composio.test/connect-2');
  expect(result.authRequestId).toBe('auth-request-2');
});

test('composioConnectUrl surfaces any other Composio refusal as a 502, not an opaque 500', async () => {
  const created = session({
    toolkit: { slug: 'github', name: 'GitHub', isNoAuth: false },
    authorize: async () => {
      throw new Error('403 {"error":{"message":"Toolkit disabled for this org"}}');
    },
  });
  const attempt = composioConnectUrl({
    projectId: 'project-1',
    slug: 'github',
    app: 'github',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    runtime: fakeRuntime({ created }),
  });
  await expect(attempt).rejects.toMatchObject({
    status: 502,
    message: expect.stringContaining('Composio refused the authorization'),
  });
});

test('invalidToolkitSlugsFromError names the slugs Composio rejected', () => {
  expect(
    invalidToolkitSlugsFromError(
      new Error(
        '400 {"error":{"message":"Invalid toolkit slugs: anthropic, openai. Please provide valid toolkit slugs.","code":4305,"slug":"ToolRouterV2_InvalidToolkitSlugs","status":400}}',
      ),
    ),
  ).toEqual(['anthropic', 'openai']);
  expect(invalidToolkitSlugsFromError(new Error('boom'))).toBeNull();
});

test('composioConnectUrl answers 422, not an unhandled 500, when the toolkit slug is invalid', async () => {
  // A connector can hold an app slug Composio does not know (typed by hand
  // through the CLI, or left behind when the catalogue dropped it). The
  // connector sync already rejects it; the connect attempt must too, as a
  // controlled 4xx. Before this it threw the raw @composio/client error, which
  // reached Sentry as a handled 500 (Better Stack pattern b9632119).
  const runtime = fakeRuntime();
  runtime.sessions.create = async () => {
    throw new Error(
      '400 {"error":{"message":"Invalid toolkit slugs: anthropic. Please provide valid toolkit slugs.",' +
        '"code":4305,"slug":"ToolRouterV2_InvalidToolkitSlugs","status":400,"request_id":"req-1"}}',
    );
  };

  const attempt = composioConnectUrl({
    projectId: 'project-1',
    slug: 'anthropic',
    app: 'anthropic',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    runtime,
  });
  await expect(attempt).rejects.toMatchObject({
    status: 422,
    message: expect.stringContaining('anthropic'),
  });
});

test('composioConnectUrl answers 422 for an app Composio no longer lists', async () => {
  const attempt = composioConnectUrl({
    projectId: 'project-1',
    slug: 'anthropic',
    app: 'anthropic',
    connectionId: 'connection-1',
    stableUserId: 'kortix-connection:connection-1',
    runtime: fakeRuntime({ created: session({ toolkit: undefined }) }),
  });
  await expect(attempt).rejects.toMatchObject({
    status: 422,
    message: expect.stringContaining('anthropic'),
  });
});

test('composioConnectUrl uses Composio managed Gmail defaults without selecting stale auth configs', async () => {
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
    runtime: fakeRuntime({
      created,
      calls,
    }),
  });

  expect(calls.some((call) => call.type === 'auth-config-list')).toBe(false);
  expect(calls.some((call) => call.type === 'auth-config-create')).toBe(false);
  expect(calls.find((call) => call.type === 'create')).toMatchObject({
    type: 'create',
    config: {
      sessionPreset: 'direct_tools',
      toolkits: ['gmail'],
    },
  });
});

test('composioConnectUrl does not create a custom Gmail auth config', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const created = session({
    toolkit: { slug: 'gmail', name: 'Gmail', isNoAuth: false },
  });

  await composioConnectUrl({
    projectId: 'project-1',
    slug: 'gmail',
    app: 'gmail',
    connectionId: 'connection-scoped-gmail-new',
    stableUserId: 'kortix-connection:connection-scoped-gmail-new',
    runtime: fakeRuntime({ created, calls }),
  });

  expect(calls.some((call) => call.type === 'auth-config-create')).toBe(false);
  expect(calls.find((call) => call.type === 'create')).toMatchObject({
    config: {
      sessionPreset: 'direct_tools',
      toolkits: ['gmail'],
      manageConnections: false,
      sandbox: { enable: false },
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
    cursor: 'cursor-1',
    limit: 20,
    runtime: fakeRuntime({ created, calls }),
  });

  // Enriched even with no metadata available: the fields are part of the page's
  // contract now, so the client's category bucketing reads `[]` rather than
  // `undefined` and cannot fork on which branch answered.
  expect(result).toEqual({
    items: [
      {
        slug: 'composio_search',
        name: 'Composio Search',
        isNoAuth: true,
        description: null,
        categories: [],
      },
    ],
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
      options: { cursor: 'cursor-1', limit: 20 },
    },
  ]);
});

// Every search answers from the full catalogue snapshot, whatever its length,
// so typing a category ("crm", "email") finds that category's apps. The
// provider's session search matches names only.
test('composioCatalogPage answers any search from the catalogue, categories included', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const catalogClient = {
    toolkits: {
      async list() {
        return {
          items: [
            { slug: 'hubspot', name: 'HubSpot', meta: { categories: [{ id: 'crm', name: 'CRM' }] } },
            { slug: 'gmail', name: 'Gmail', meta: { categories: [{ id: 'email', name: 'Email' }] } },
          ],
        };
      },
    },
  };

  const result = await composioCatalogPage({
    projectId: 'project-1',
    q: 'crm',
    catalogClient,
    runtime: fakeRuntime({ created: session({}), calls }),
  });

  expect('toolkits' in result && result.toolkits.map((t) => t.slug)).toEqual(['hubspot']);
  expect(calls).toEqual([]);
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
    connectionLabel: 'Gmail default',
    connectionOwnerType: 'project',
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
    // Which account ran it, so the transcript can answer "whose mailbox sent
    // that" — carried from the resolved GatewayConnector (gateway.ts).
    account: { connection_id: 'connection-1', label: 'Gmail default', owner_type: 'project' },
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

test('composioCatalogPage enriches the paged catalogue with the metadata that page omits', async () => {
  // `session.toolkits()` returns no description and no categories, so every card
  // fell into the client's synthetic "Other" bucket and opening it asked for
  // `category=Other` — a category no provider has. The page then reported the
  // catalogue as unavailable while showing it.
  const calls: Array<Record<string, unknown>> = [];
  const created = session({ toolkit: { slug: 'gmail', name: 'Gmail', isNoAuth: false } });
  created.toolkits = async (options) => {
    calls.push({ type: 'toolkits', options });
    return {
      items: [
        { slug: 'gmail', name: 'Gmail', isNoAuth: false },
        { slug: 'beyond_the_metadata_cap', name: 'Uncatalogued', isNoAuth: true },
      ],
      totalPages: 1,
    };
  };

  const result = await composioCatalogPage({
    projectId: 'project-1',
    runtime: fakeRuntime({
      created,
      calls,
      catalogPage: [
        {
          slug: 'gmail',
          name: 'Gmail',
          noAuth: false,
          meta: {
            description: 'Google email',
            categories: [
              { slug: 'email', name: 'email' },
              { slug: 'productivity', name: 'productivity' },
            ],
          },
        },
      ],
    }),
  });

  if (!('items' in result)) throw new Error('expected the paged browse shape');
  const items = result.items;
  expect(items[0]).toMatchObject({
    slug: 'gmail',
    description: 'Google email',
    categories: ['email', 'productivity'],
  });
  // Past the provider's 1000-toolkit metadata cap there is nothing to enrich
  // with. The card still ships, uncategorized, rather than being dropped.
  expect(items[1]).toMatchObject({
    slug: 'beyond_the_metadata_cap',
    description: null,
    categories: [],
  });
});

test('composioCatalogPage searches one and two letters across every provider page', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const created = session();
  created.toolkits = async (options) => {
    if (options?.search && options.search.length < 3) {
      throw new Error('Search query must be at least 3 characters long');
    }
    return { items: [], totalPages: 1 };
  };
  const catalogClient = {
    toolkits: {
      async list(query: { cursor?: string }) {
        requests.push(query);
        return query.cursor
          ? {
              items: [
                {
                  slug: 'gmail',
                  name: 'Gmail',
                  meta: { description: 'Email', categories: [{ id: 'email', name: 'Email' }] },
                },
              ],
              next_cursor: null,
            }
          : {
              items: [
                { slug: 'alpha', name: 'Alpha', meta: {} },
                { slug: 'zoom', name: 'Zoom', meta: {} },
              ],
              next_cursor: 'page-2',
            };
      },
    },
  };
  const input = {
    projectId: 'project-1',
    runtime: fakeRuntime({ created }),
    catalogClient,
    limit: 1,
  };
  const first = await composioCatalogPage({ ...input, q: ' A ' });
  expect(first).toMatchObject({
    provider: 'composio',
    total: 2,
    hasMore: true,
    toolkits: [{ slug: 'alpha' }],
  });
  if (!('nextCursor' in first)) throw new Error('expected a next cursor');
  const second = await composioCatalogPage({ ...input, q: 'a', cursor: first.nextCursor });
  expect(second).toMatchObject({
    total: 2,
    hasMore: false,
    toolkits: [{ slug: 'gmail', description: 'Email', categories: ['email'], connected: false }],
  });
  expect(await composioCatalogPage({ ...input, q: 'gm' })).toMatchObject({
    total: 1,
    hasMore: false,
    toolkits: [{ slug: 'gmail' }],
  });
  expect(await composioCatalogPage({ ...input, q: 'zz' })).toMatchObject({
    total: 0,
    hasMore: false,
    toolkits: [],
  });
  expect(requests).toEqual([
    { limit: 1000, sort_by: 'usage' },
    { limit: 1000, sort_by: 'usage', cursor: 'page-2' },
  ]);
});

function identityRuntime(input: {
  displayName?: unknown;
  accountError?: Error;
  execute?: ComposioSessionLike['execute'];
  calls: Array<Record<string, unknown>>;
}): ComposioRuntime {
  const resumed = session({
    id: 'persisted-session',
    execute: async (toolSlug, args) => {
      input.calls.push({ type: 'execute', toolSlug, args });
      if (!input.execute) throw new Error('no whoami tool expected');
      return input.execute(toolSlug, args);
    },
  });
  return {
    ...fakeRuntime({ resumed, calls: input.calls }),
    connectedAccounts: {
      async get(id: string) {
        input.calls.push({ type: 'account', id });
        if (input.accountError) throw input.accountError;
        return { id, state: { val: { displayName: input.displayName } } };
      },
    },
  };
}

test('probeComposioIdentity reads the display name Composio stores on the connected account', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const identity = await probeComposioIdentity({
    app: 'gmail',
    sessionId: 'persisted-session',
    connectedAccountId: 'connected-account-1',
    runtime: identityRuntime({ displayName: '  Ops@Example.test ', calls }),
  });

  expect(identity).toBe('ops@example.test');
  expect(calls).toEqual([{ type: 'account', id: 'connected-account-1' }]);
});

test('probeComposioIdentity falls back to the toolkit whoami tool when no display name exists', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const identity = await probeComposioIdentity({
    app: 'googledrive',
    sessionId: 'persisted-session',
    connectedAccountId: 'connected-account-1',
    runtime: identityRuntime({
      calls,
      execute: async () => ({
        data: { user: { displayName: 'Ops Team', emailAddress: 'ops@example.test', me: true } },
        error: null,
        logId: 'log-1',
      }),
    }),
  });

  expect(identity).toBe('ops@example.test');
  expect(calls).toContainEqual({
    type: 'execute',
    toolSlug: 'GOOGLEDRIVE_GET_ABOUT',
    args: { fields: 'user' },
  });
});

test('probeComposioIdentity reads the primary calendar id as the Google Calendar identity', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const identity = await probeComposioIdentity({
    app: 'googlecalendar',
    sessionId: 'persisted-session',
    connectedAccountId: 'connected-account-1',
    runtime: identityRuntime({
      calls,
      execute: async () => ({
        data: { id: 'ops@example.test', summary: 'ops@example.test', timeZone: 'UTC' },
        error: null,
        logId: 'log-1',
      }),
    }),
  });

  expect(identity).toBe('ops@example.test');
  expect(calls).toContainEqual({
    type: 'execute',
    toolSlug: 'GOOGLECALENDAR_GET_CALENDAR',
    args: { calendar_id: 'primary' },
  });
});

test('probeComposioIdentity uses a login when the provider exposes no email', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const identity = await probeComposioIdentity({
    app: 'slack',
    sessionId: 'persisted-session',
    connectedAccountId: 'connected-account-1',
    runtime: identityRuntime({
      calls,
      execute: async () => ({
        data: { ok: true, user: 'ops-bot', team: 'Example', user_id: 'U123' },
        error: null,
        logId: 'log-1',
      }),
    }),
  });

  expect(identity).toBe('ops-bot');
});

test('probeComposioIdentity returns null, never throws, when every source fails', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const identity = await probeComposioIdentity({
    app: 'linear',
    sessionId: 'persisted-session',
    connectedAccountId: 'connected-account-1',
    runtime: identityRuntime({
      calls,
      accountError: new Error('composio 500'),
      execute: async () => {
        throw new Error('tool refused');
      },
    }),
  });

  expect(identity).toBeNull();
});

test('probeComposioIdentity returns null for a toolkit without an identity source', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const identity = await probeComposioIdentity({
    app: 'googledocs',
    sessionId: 'persisted-session',
    connectedAccountId: 'connected-account-1',
    runtime: identityRuntime({ calls }),
  });

  expect(identity).toBeNull();
  expect(calls.some((call) => call.type === 'execute')).toBe(false);
});

// ── Toolkits with no Composio-managed OAuth app (X, Xero, Spotify, ...) ──────
// Composio's exact refusal, captured from prod on 2026-09-26 (request
// 7029e848-757a-4d92-a9f8-771856d643c7) when a user added X.
const AUTH_CONFIG_REQUIRED =
  '400 {"error":{"message":"The following toolkits require auth configs but none exist and cannot be auto-created: twitter. Please specify them in auth_configs.","code":4300,"slug":"ToolRouterV2_BadRequest","status":400,"request_id":"7029e848-757a-4d92-a9f8-771856d643c7","suggested_fix":""}}';

/** Tool Router as it behaves live: a twitter session needs `authConfigs.twitter`. */
function routerNeedingTwitterConfig(calls: Array<Record<string, unknown>>, created = session()): ComposioRuntime {
  return {
    sessions: {
      async create(userId, config) {
        calls.push({ type: 'create', userId, config });
        const toolkits = (config?.toolkits as string[] | undefined) ?? [];
        const authConfigs = (config as { authConfigs?: Record<string, string> } | undefined)?.authConfigs;
        if (toolkits.includes('twitter') && !authConfigs?.twitter) throw new Error(AUTH_CONFIG_REQUIRED);
        return created;
      },
      async use(sessionId) {
        calls.push({ type: 'use', sessionId });
        return created;
      },
    },
  };
}

function authConfigClient(
  items: Array<{ id: string; status: 'ENABLED' | 'DISABLED'; is_composio_managed?: boolean; toolkit: { slug: string }; created_at?: string }>,
  calls: Array<Record<string, unknown>>,
  catalog: Array<Record<string, unknown>> = [],
): ComposioCatalogClient {
  return {
    toolkits: {
      async list() {
        return { items: catalog as never };
      },
    },
    authConfigs: {
      async list(query) {
        calls.push({ type: 'auth-config-list', query });
        return { items, next_cursor: null };
      },
    },
  };
}

const TWITTER_CONFIG = {
  id: 'ac_twitter',
  status: 'ENABLED' as const,
  is_composio_managed: false,
  toolkit: { slug: 'twitter' },
};

test('composioCatalogTools retries a 4300 refusal with the toolkit’s custom auth config', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tools = await composioCatalogTools({
    projectId: 'project-1',
    connectorSlug: 'x',
    toolkit: 'twitter',
    runtime: routerNeedingTwitterConfig(calls, session({ tools: [{ type: 'function', function: { name: 'TWITTER_CREATION_OF_A_POST' } }] as never })),
    catalogClient: authConfigClient([TWITTER_CONFIG], calls),
  });
  expect(tools).toHaveLength(1);
  expect(calls.map((call) => call.type)).toEqual(['create', 'auth-config-list', 'create']);
  expect(calls[1]).toMatchObject({ query: { toolkit_slug: 'twitter', is_composio_managed: false } });
  expect(calls[2]).toMatchObject({
    userId: 'kortix-catalog:project-1:x',
    config: {
      sessionPreset: 'direct_tools',
      toolkits: ['twitter'],
      authConfigs: { twitter: 'ac_twitter' },
    },
  });
});

test('composioCatalogTools answers a typed 422 when the toolkit has no auth config', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const attempt = composioCatalogTools({
    projectId: 'project-1',
    connectorSlug: 'x',
    toolkit: 'twitter',
    runtime: routerNeedingTwitterConfig(calls),
    catalogClient: authConfigClient([{ ...TWITTER_CONFIG, status: 'DISABLED' }], calls),
  });
  const error = await attempt.then(
    () => {
      throw new Error('expected a 422');
    },
    (caught: HTTPException) => caught,
  );
  expect(error.status).toBe(422);
  expect(error.message).toContain('no enabled "twitter" auth config');
  // The raw provider JSON never reaches the user.
  expect(error.message).not.toContain('ToolRouterV2_BadRequest');
  expect(await error.getResponse().json()).toMatchObject({
    status: 422,
    code: 'composio_auth_config_required',
    toolkit: 'twitter',
  });
  expect(calls.filter((call) => call.type === 'create')).toHaveLength(1);
});

test('composioCatalogTools maps an invalid toolkit refusal to 422', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const runtime = fakeRuntime({ calls });
  runtime.sessions.create = async () => {
    throw new Error('400 {"error":{"message":"Invalid toolkit slugs: anthropic.","code":4305}}');
  };
  await expect(
    composioCatalogTools({
      projectId: 'project-1',
      connectorSlug: 'claude',
      toolkit: 'anthropic',
      runtime,
      catalogClient: authConfigClient([], calls),
    }),
  ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('anthropic') });
  expect(calls.some((call) => call.type === 'auth-config-list')).toBe(false);
});

test('composioConnectUrl authorizes X through the operator’s auth config', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await composioConnectUrl({
    projectId: 'project-1',
    slug: 'x',
    app: 'twitter',
    connectionId: 'connection-x',
    stableUserId: 'kortix-connection:connection-x',
    runtime: routerNeedingTwitterConfig(calls, session({ toolkit: { slug: 'twitter', name: 'Twitter', isNoAuth: false } })),
    catalogClient: authConfigClient([TWITTER_CONFIG], calls),
  });
  expect(result).toMatchObject({ connectUrl: 'https://composio.test/connect', connected: false });
  expect(calls.filter((call) => call.type === 'create').at(-1)).toMatchObject({
    userId: 'kortix-connection:connection-x',
    config: { authConfigs: { twitter: 'ac_twitter' } },
  });
});

test('executeComposio binds the auth config and the account when no session was stored', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const created = session({
    toolkit: {
      slug: 'twitter',
      name: 'Twitter',
      isNoAuth: false,
      connection: { isActive: true, connectedAccount: { id: 'ca_x', status: 'ACTIVE' } },
    } as ToolkitItem,
  });
  const result = await executeComposio({
    projectId: 'project-1',
    connectorSlug: 'x',
    connectionId: 'connection-x',
    toolkit: 'twitter',
    toolSlug: 'TWITTER_USER_LOOKUP_ME',
    args: {},
    connectedAccountId: 'ca_x',
    runtime: routerNeedingTwitterConfig(calls, created),
    catalogClient: authConfigClient([TWITTER_CONFIG], calls),
  });
  expect(result.ok).toBe(true);
  expect(calls.filter((call) => call.type === 'create').at(-1)).toMatchObject({
    config: {
      connectedAccounts: { twitter: 'ca_x' },
      authConfigs: { twitter: 'ac_twitter' },
    },
  });
});

test('composioCatalogPage hides a toolkit Composio cannot connect in browse and category views', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const catalog = [
    { slug: 'twitter', name: 'Twitter', no_auth: false, auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: [], meta: {} },
    { slug: 'gmail', name: 'Gmail', no_auth: false, auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], meta: {} },
  ];
  const created = session();
  created.toolkits = async () => ({
    items: [
      { slug: 'twitter', name: 'Twitter', isNoAuth: false },
      { slug: 'gmail', name: 'Gmail', isNoAuth: false },
    ],
    totalPages: 1,
  });
  const runtime = fakeRuntime({
    created,
    calls,
    catalogPage: [
      { slug: 'twitter', name: 'Twitter', noAuth: false, meta: { categories: [{ slug: 'social', name: 'Social' }] } },
      { slug: 'gmail', name: 'Gmail', noAuth: false, meta: { categories: [{ slug: 'social', name: 'Social' }] } },
    ],
  });
  const catalogClient = authConfigClient([], calls, catalog);

  const browse = await composioCatalogPage({ projectId: 'project-1', runtime, catalogClient });
  if (!('items' in browse)) throw new Error('expected the paged browse shape');
  expect(browse.items.map((item) => item.slug)).toEqual(['gmail']);

  const category = await composioCatalogPage({ projectId: 'project-1', category: 'social', runtime, catalogClient });
  if (!('toolkits' in category)) throw new Error('expected the category shape');
  expect(category.toolkits.map((item) => item.slug)).toEqual(['gmail']);
  expect(category.total).toBe(1);
});
