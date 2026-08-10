import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  activateConnection,
  createConnector,
  deleteConnector,
  discoverConnectionOAuth2,
  discoverConnectorAuth,
  ensureWorkspaceConnectorConnection,
  getConnectStatus,
  getConnectionPolicies,
  getConnectionOAuth2Application,
  getConnectionOAuth2Status,
  getConnectorConfig,
  getConnectorPolicies,
  getDiscoverConnector,
  listAllConnections,
  listConnections,
  listConnectors,
  listDiscoverConnectors,
  listPipedreamApps,
  pipedreamConnect,
  pipedreamConnectConnection,
  pipedreamFinalize,
  pipedreamFinalizeConnection,
  pollConnectionOAuth2DeviceAuthorization,
  putConnectionOAuth2Application,
  reconcileConnection,
  reconcileMemberConnection,
  revokeConnection,
  setConnectionPolicies,
  setConnectorAuthorizationStrategy,
  setConnectorCredential,
  setConnectorCredentialMode,
  setConnectorSecretBinding,
  setConnectorName,
  setConnectorPolicies,
  setConnectorSensitive,
  setDefaultConnection,
  startConnectionOAuth2Authorization,
  startConnectionOAuth2DeviceAuthorization,
  syncConnectors,
  updateConnectionCredential,
} from './connectors';

const canonicalConnectionType: import('./connectors').Connection = {
  connection_id: 'connection-new',
  connector_alias: 'gmail',
  owner_type: 'workspace',
  owner_id: null,
  label: 'New Gmail',
  status: 'active',
  is_default: true,
  metadata: {},
};
void canonicalConnectionType;

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'tok',
});
const last = () => calls[calls.length - 1];

test('connection APIs expose only connection identifiers', async () => {
  nextResponse = {
    status: 200,
    body: {
      connections: [
        {
          connection_id: 'connection-1',
          connector_alias: 'gmail',
          owner_type: 'workspace',
          owner_id: null,
          label: 'Gmail',
          status: 'active',
          is_default: true,
          metadata: {},
        },
      ],
    },
  };
  expect((await listConnections('P1')).connections[0]?.connection_id).toBe('connection-1');
  expect(listAllConnections).toBeDefined();
  expect(reconcileConnection).toBeDefined();
  expect(reconcileMemberConnection).toBeDefined();
});

test('native OAuth2 lifecycle methods use connection-scoped generic routes', async () => {
  nextResponse = { status: 200, body: { connection_id: 'connection-1' } };
  await ensureWorkspaceConnectorConnection('P1', 'generic-api');
  expect(last()).toMatchObject({ method: 'POST' });
  expect(last().url).toContain('/workspaces/P1/connectors/generic-api/oauth2/connection');

  nextResponse = { status: 200, body: { ok: true } };
  const application = {
    authorization_url: 'https://identity.example.com/authorize',
    token_url: 'https://identity.example.com/token',
    client_id: 'client-123',
    token_endpoint_auth_method: 'none' as const,
    scopes: ['read'],
  };
  await putConnectionOAuth2Application('P1', 'connection-1', application);
  expect(last()).toMatchObject({ method: 'PUT', body: application });
  expect(last().url).toContain('/workspaces/P1/connections/connection-1/oauth2/application');

  nextResponse = {
    status: 200,
    body: { application: { ...application, has_client_secret: false } },
  };
  await getConnectionOAuth2Application('P1', 'connection-1');
  expect(last().method).toBe('GET');

  nextResponse = {
    status: 200,
    body: { metadata: { token_url: application.token_url } },
  };
  await discoverConnectionOAuth2('P1', 'connection-1', {
    discovery_url: 'https://identity.example.com/.well-known/oauth-authorization-server',
  });
  expect(last().method).toBe('POST');

  nextResponse = {
    status: 200,
    body: { authorization_url: application.authorization_url },
  };
  await startConnectionOAuth2Authorization('P1', 'connection-1', {
    success_redirect_uri: 'https://dev.kortix.com/workspaces/P1',
  });
  expect(last().url).toContain('/oauth2/authorize');

  nextResponse = {
    status: 200,
    body: {
      session_id: 'session-1',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://identity.example.com/device',
      expires_at: '2026-07-25T12:00:00.000Z',
      interval_seconds: 5,
    },
  };
  await startConnectionOAuth2DeviceAuthorization('P1', 'connection-1', {});
  expect(last().url).toContain('/oauth2/device');

  nextResponse = { status: 200, body: { status: 'pending' } };
  await pollConnectionOAuth2DeviceAuthorization('P1', 'connection-1', 'session-1');
  expect(last().url).toContain('/oauth2/device/session-1');

  nextResponse = { status: 200, body: { status: 'active', scopes: ['read'] } };
  await getConnectionOAuth2Status('P1', 'connection-1');
  expect(last().url).toContain('/oauth2/status');
});

test('connection methods use the canonical connection route contract', async () => {
  nextResponse = { status: 200, body: { connections: [] } };
  await listConnections('P1');
  expect(last().url).toContain('/workspaces/P1/connections');

  nextResponse = {
    status: 200,
    body: {
      connection_id: 'connection-1',
      connector_alias: 'gmail',
      owner_type: 'workspace',
      owner_id: null,
      label: 'Workspace Gmail',
      status: 'active',
      is_default: true,
      metadata: {},
    },
  };
  await reconcileConnection('P1', {
    connector_alias: 'gmail',
    owner_type: 'workspace',
    label: 'Workspace Gmail',
  });
  expect(last()).toMatchObject({ method: 'POST' });

  nextResponse = { status: 200, body: { ok: true } };
  await updateConnectionCredential('P1', 'connection-1', {
    value: 'secret-value',
  });
  expect(last().url).toContain('/connections/connection-1/credential');
  await revokeConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/revoke');
  await activateConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/activate');
  await setDefaultConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/default');

  nextResponse = { status: 200, body: { connection_id: 'connection-1' } };
  await ensureWorkspaceConnectorConnection('P1', 'gmail');
  expect(last().url).toContain('/connectors/gmail/oauth2/connection');

  nextResponse = { status: 200, body: { token: 'connect-token' } };
  await pipedreamConnectConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/connect');

  nextResponse = { status: 200, body: { connected: true } };
  await pipedreamFinalizeConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/connect/finalize');
});

test('deprecated authorization policy methods fail before widening policy scope', async () => {
  await expect(getConnectionPolicies('P1', 'authorization-1')).rejects.toThrow(
    'Use getConnectorPolicies(workspaceId, slug)',
  );
  await expect(
    setConnectionPolicies('P1', 'authorization-1', [{ match: 'send_email', action: 'block' }]),
  ).rejects.toThrow('Use setConnectorPolicies(workspaceId, slug, policies)');
  expect(calls).toHaveLength(0);
});

const postmanDraftTypecheck: import('./connectors').ConnectorDraftInput = {
  slug: 'hubspot',
  provider: 'postman',
  spec: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
  authorization_strategy: 'user',
};
void postmanDraftTypecheck;

test('listConnectors GETs the workspace connectors list', async () => {
  nextResponse = {
    status: 200,
    body: {
      connectors: [
        {
          slug: 'signed-api',
          name: 'Signed API',
          provider: 'http',
          status: 'active',
          credentialMode: 'shared',
          authorizationStrategy: 'user',
          requestAuthType: 'hmac',
          sensitive: false,
          actions: [],
          authSecret: 'credential',
          secretSet: false,
        },
      ],
    },
  };
  const result = await listConnectors('P1');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors');
  expect(last().method).toBe('GET');
  expect(result.connectors[0]?.requestAuthType).toBe('hmac');
});

test('listConnectors throws on a failed response', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listConnectors('P1')).rejects.toBeTruthy();
});

test('setConnectorSecretBinding sends one explicit workspace secret identifier', async () => {
  nextResponse = { status: 200, body: { ok: true } };

  await setConnectorSecretBinding('P1', 'signed-api', 'SIGNING_KEY');

  expect(last()).toEqual({
    url: 'http://test.local/connectors/workspaces/P1/connectors/signed-api/secret-binding',
    method: 'PUT',
    body: { secret_identifier: 'SIGNING_KEY' },
  });
});

test('setConnectorSecretBinding clears a binding with null', async () => {
  nextResponse = { status: 200, body: { ok: true } };

  await setConnectorSecretBinding('P1', 'signed-api', null);

  expect(last()?.body).toEqual({ secret_identifier: null });
});

test('listConnectors is a silent background read — a 403 never hits the global error sink', async () => {
  // Fired at workspace mount (workspace-home tiles, sidebar setup checklist);
  // callers render their own state, never a global toast.
  const onError = mock(() => {});
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError,
  });
  try {
    nextResponse = { status: 403, body: { error: 'forbidden' } };
    await expect(listConnectors('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({
      backendUrl: 'http://test.local',
      getToken: async () => 'tok',
    });
  }
});

test('syncConnectors POSTs an empty body to the sync endpoint', async () => {
  nextResponse = { status: 200, body: { synced: 2, errors: [] } };
  const result = await syncConnectors('P1');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/sync');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result).toEqual({ synced: 2, errors: [] });
});

test('setConnectorCredentialMode PUTs { mode }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorCredentialMode('P1', 'slack', 'shared');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack/credential-mode');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ mode: 'shared' });
});

test('setConnectorAuthorizationStrategy PUTs one exclusive strategy', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorAuthorizationStrategy('P1', 'gmail-read', 'user');
  expect(last().url).toContain(
    '/connectors/workspaces/P1/connectors/gmail-read/authorization-strategy',
  );
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ authorization_strategy: 'user' });
});

test('setConnectorSensitive PUTs { sensitive }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorSensitive('P1', 'slack', true);
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack/sensitive');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ sensitive: true });
});

test('getConnectorPolicies GETs the policies list', async () => {
  nextResponse = {
    status: 200,
    body: { policies: [{ match: '*', action: 'require_approval' }] },
  };
  const result = await getConnectorPolicies('P1', 'slack');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack/policies');
  expect(last().method).toBe('GET');
  expect(result.policies).toHaveLength(1);
});

test('getConnectorPolicies surfaces the effective scope that decided each tool', async () => {
  // Workspace rules are evaluated before connector rules and CANNOT be overridden
  // (see the connector's resolveEffectiveAction). Without `effective`, an editor
  // renders a connector rule the runtime is actually ignoring.
  nextResponse = {
    status: 200,
    body: {
      policies: [{ match: 'send_email', action: 'always_run' }],
      effective: [
        { path: 'send_email', action: 'block', source: 'workspace' },
        { path: 'list_labels', action: 'always_run', source: 'connector' },
      ],
      workspace_policies: [{ match: 'gmail.send_email', action: 'block' }],
      default_mode: 'risk',
    },
  };
  const result = await getConnectorPolicies('P1', 'gmail');
  const overruled = result.effective?.find((e) => e.path === 'send_email');
  expect(overruled?.source).toBe('workspace');
  expect(overruled?.action).toBe('block');
  expect(result.effective?.find((e) => e.path === 'list_labels')?.source).toBe('connector');
  expect(result.default_mode).toBe('risk');
});

test('getConnectorPolicies tolerates a server that omits the effective block', async () => {
  // Older servers return only `policies`; the editor must not crash on them.
  nextResponse = { status: 200, body: { policies: [] } };
  const result = await getConnectorPolicies('P1', 'slack');
  expect(result.effective).toBeUndefined();
});

test('setConnectorPolicies PUTs { policies }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const policies = [{ match: 'send_message', action: 'block' as const }];
  await setConnectorPolicies('P1', 'slack', policies);
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack/policies');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ policies });
});

test('getConnectorConfig GETs the config, url-encoding a slug with special characters', async () => {
  nextResponse = {
    status: 200,
    body: {
      slug: 'my app/v1',
      provider: 'mcp',
      platform: null,
      credentialMode: 'shared',
      app: null,
      account: null,
      url: null,
      transport: 'http',
      endpoint: null,
      baseUrl: null,
      spec: null,
      auth: { type: 'none', in: 'header', name: null, prefix: null },
    },
  };
  const result = await getConnectorConfig('P1', 'my app/v1');
  expect(last().url).toContain(
    `/connectors/workspaces/P1/connectors/${encodeURIComponent('my app/v1')}/config`,
  );
  expect(last().url).not.toContain('my app/v1');
  expect(last().method).toBe('GET');
  expect(result.slug).toBe('my app/v1');
});

test('computer connector config exposes its assigned machine ids', async () => {
  const tunnelIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  nextResponse = {
    status: 200,
    body: {
      slug: 'studio-computers',
      name: 'Studio computers',
      provider: 'computer',
      platform: null,
      credentialMode: 'shared',
      authorizationStrategy: 'workspace',
      app: null,
      account: null,
      url: null,
      transport: null,
      endpoint: null,
      baseUrl: null,
      spec: null,
      tunnelIds,
      auth: { type: 'none', in: 'header', name: null, prefix: null },
      headers: {},
    },
  };
  const result = await getConnectorConfig('P1', 'studio-computers');
  expect(result.tunnelIds).toEqual(tunnelIds);
});

test('setConnectorName PUTs { name }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorName('P1', 'slack', 'Team Slack');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack/name');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ name: 'Team Slack' });
});

test('pipedreamConnect POSTs an empty body to the connect endpoint', async () => {
  nextResponse = {
    status: 200,
    body: { connectUrl: 'https://pipedream.com/connect/x' },
  };
  const result = await pipedreamConnect('P1', 'github');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/github/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.connectUrl).toContain('pipedream.com');
});

test('createConnector POSTs the draft as the raw body', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const draft: import('./connectors').ConnectorDraftInput = {
    slug: 'my-http',
    provider: 'http' as const,
    url: 'https://example.com',
    create_only: true,
  };
  await createConnector('P1', draft);
  expect(last().url).toContain('/connectors/workspaces/P1/connectors');
  expect(last().url).not.toContain('/executor/');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(draft);
});

test('createConnector sends a Computers profile machine allowlist', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const draft: import('./connectors').ConnectorDraftInput = {
    slug: 'studio-computers',
    name: 'Studio computers',
    provider: 'computer',
    tunnel_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    create_only: true,
  };
  await createConnector('P1', draft);
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(draft);
});

test('discoverConnectorAuth POSTs a draft to the auth-discovery endpoint', async () => {
  const discovery: import('./connectors').ConnectorAuthDiscovery = {
    status: 'detected',
    recommended: {
      type: 'bearer',
      in: 'header',
      name: 'Authorization',
      prefix: 'Bearer',
    },
    candidates: [],
    warnings: [],
    totalRequests: 10,
    title: 'HubSpot',
  };
  nextResponse = { status: 200, body: discovery };
  const draft = {
    slug: 'hubspot',
    provider: 'postman' as const,
    spec: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
  };
  expect(await discoverConnectorAuth('P1', draft)).toEqual(discovery);
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/auth-discovery');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(draft);
});

test('deleteConnector DELETEs the connector by slug', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteConnector('P1', 'slack');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack');
  expect(last().method).toBe('DELETE');
});

test('listPipedreamApps GETs with no query string when no optional params are given', async () => {
  nextResponse = { status: 200, body: { apps: [], hasMore: false } };
  await listPipedreamApps('P1');
  expect(last().url).toContain('/connectors/workspaces/P1/pipedream/apps');
  expect(last().url).not.toContain('?');
  expect(last().method).toBe('GET');
});

test('listPipedreamApps GETs with q + cursor as query params when given', async () => {
  nextResponse = {
    status: 200,
    body: { apps: [], nextCursor: 'c2', hasMore: true },
  };
  const result = await listPipedreamApps('P1', 'slack', 'c1');
  expect(last().url).toContain('/connectors/workspaces/P1/pipedream/apps?');
  expect(last().url).toContain('q=slack');
  expect(last().url).toContain('cursor=c1');
  expect(result.nextCursor).toBe('c2');
});

test('listPipedreamApps surfaces the catalogue total the API reports', async () => {
  // The browse UI states "Showing 192 of 2,713" against this number. Without
  // it a paged surface can only ever quote what it has already fetched, which
  // reads as a catalogue of 192.
  nextResponse = {
    status: 200,
    body: { apps: [], total: 2713, nextCursor: 'c2', hasMore: true },
  };
  const result = await listPipedreamApps('P1');
  expect(result.total).toBe(2713);
});

test('listPipedreamApps tolerates an API build that reports no total', async () => {
  // The field is additive, so an older deployment omits it. Callers fall back
  // to the loaded count; what must not happen is a throw or a `NaN`.
  nextResponse = { status: 200, body: { apps: [], hasMore: false } };
  const result = await listPipedreamApps('P1');
  expect(result.total).toBeUndefined();
});

test('listDiscoverConnectors GETs a searchable cursor page', async () => {
  nextResponse = { status: 200, body: { items: [], total: 0, hasMore: false } };
  await listDiscoverConnectors('P1', 'notion admin', '48');
  expect(last().url).toContain('/connectors/workspaces/P1/discover/connectors?');
  expect(last().url).toContain('q=notion+admin');
  expect(last().url).toContain('cursor=48');
  expect(last().method).toBe('GET');
});

test('getDiscoverConnector GETs detail by encoded catalogue id', async () => {
  nextResponse = {
    status: 200,
    body: { item: { id: 'openapi/1forge-com' }, variants: [] },
  };
  const result = await getDiscoverConnector('P1', 'openapi/1forge-com');
  expect(last().url).toContain('/connectors/workspaces/P1/discover/connectors/detail?');
  expect(last().url).toContain('id=openapi%2F1forge-com');
  expect(last().method).toBe('GET');
  expect(result.item.id).toBe('openapi/1forge-com');
});

test('getConnectStatus GETs the deployment-wide connect-status endpoint', async () => {
  nextResponse = {
    status: 200,
    body: { configured: true, provider: 'pipedream' },
  };
  const result = await getConnectStatus();
  expect(last().url).toContain('/connectors/connect-status');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ configured: true, provider: 'pipedream' });
});

test('setConnectorCredential PUTs { value }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorCredential('P1', 'slack', 'sekret');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/slack/credential');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ value: 'sekret' });
});

test('setConnectorCredential PUTs a native OAuth2 client-credentials configuration', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const oauth2 = {
    type: 'oauth2_client_credentials' as const,
    token_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    client_id: 'client-id',
    token_endpoint_auth_method: 'client_secret_post' as const,
    client_secret: 'client-secret',
    scopes: ['https://graph.microsoft.com/.default'],
  };
  await setConnectorCredential('P1', 'sharepoint', { oauth2 });
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/sharepoint/credential');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ oauth2 });
});

test('pipedreamFinalize POSTs an empty body to the connect/finalize endpoint', async () => {
  nextResponse = { status: 200, body: { connected: true, accountId: 'acc_1' } };
  const result = await pipedreamFinalize('P1', 'github');
  expect(last().url).toContain('/connectors/workspaces/P1/connectors/github/connect/finalize');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result).toEqual({ connected: true, accountId: 'acc_1' });
});

test('connection lifecycle uses the typed workspace connection routes', async () => {
  nextResponse = { status: 200, body: { connections: [] } };
  await listConnections('P1');
  expect(last().url).toContain('/workspaces/P1/connections');
  expect(last().method).toBe('GET');

  nextResponse = {
    status: 201,
    body: {
      connection_id: 'connection-1',
      connector_alias: 'veyris',
      owner_type: 'external',
      owner_id: 'thread-1',
      label: 'Thread 1',
      status: 'active',
      is_default: false,
      metadata: {},
    },
  };
  await reconcileConnection('P1', {
    connector_alias: 'veyris',
    owner_type: 'external',
    owner_id: 'thread-1',
    label: 'Thread 1',
  });
  expect(last().method).toBe('POST');
  expect(last().body).not.toHaveProperty('credential');

  nextResponse = { status: 200, body: { ok: true } };
  await updateConnectionCredential('P1', 'connection-1', {
    value: 'capability',
  });
  expect(last().url).toContain('/connections/connection-1/credential');
  expect(last().body).toEqual({ value: 'capability' });
  await updateConnectionCredential('P1', 'connection-1', {
    oauth2: {
      type: 'oauth2_client_credentials',
      token_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      client_id: 'client-id',
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 'client-secret',
      scopes: ['https://graph.microsoft.com/.default'],
    },
  });
  expect(last().body).toHaveProperty('oauth2.type', 'oauth2_client_credentials');
  await revokeConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/revoke');
  await activateConnection('P1', 'connection-1');
  expect(last().url).toContain('/connections/connection-1/activate');
});

test('member connection creation is owner-scoped by the API and never accepts an owner id', async () => {
  nextResponse = {
    status: 201,
    body: {
      connection_id: 'connection-member',
      connector_alias: 'gmail',
      owner_type: 'member',
      owner_id: 'user-from-token',
      label: 'My Gmail',
      status: 'active',
      is_default: false,
      metadata: {},
    },
  };
  await reconcileMemberConnection('P1', {
    connector_alias: 'gmail',
    label: 'My Gmail',
  });
  expect(last().url).toContain('/workspaces/P1/connections/me');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ connector_alias: 'gmail', label: 'My Gmail' });
});

test('connection-specific Pipedream connect and finalize bind the OAuth identity to the connection', async () => {
  nextResponse = {
    status: 200,
    body: { connectUrl: 'https://pipedream.test/connect' },
  };
  await pipedreamConnectConnection('P1', 'connection-member', {
    success_redirect_uri: 'kortix://connected',
  });
  expect(last().url).toContain('/workspaces/P1/connections/connection-member/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ success_redirect_uri: 'kortix://connected' });

  nextResponse = {
    status: 200,
    body: { connected: true, accountId: 'acc-member' },
  };
  await pipedreamFinalizeConnection('P1', 'connection-member');
  expect(last().url).toContain('/workspaces/P1/connections/connection-member/connect/finalize');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
});
