import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  activateConnectionProfile,
  createConnector,
  discoverConnectorAuth,
  discoverConnectionProfileOAuth2,
  deleteConnector,
  getConnectStatus,
  getDiscoverIntegration,
  getConnectorConfig,
  getConnectorPolicies,
  getConnectionProfileOAuth2Application,
  getConnectionProfileOAuth2Status,
  ensureProjectConnectorProfile,
  listConnectionProfiles,
  listConnectors,
  listDiscoverIntegrations,
  listPipedreamApps,
  pipedreamConnect,
  pipedreamConnectConnectionProfile,
  pipedreamFinalize,
  pipedreamFinalizeConnectionProfile,
  pollConnectionProfileOAuth2DeviceAuthorization,
  putConnectionProfileOAuth2Application,
  reconcileConnectionProfile,
  reconcileMemberConnectionProfile,
  revokeConnectionProfile,
  setConnectorCredential,
  setConnectorCredentialMode,
  setConnectorName,
  setConnectorPolicies,
  setConnectorSensitive,
  syncConnectors,
  startConnectionProfileOAuth2Authorization,
  startConnectionProfileOAuth2DeviceAuthorization,
  updateConnectionProfileCredential,
} from './connectors';

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

test('native OAuth2 lifecycle methods use profile-scoped generic routes', async () => {
  nextResponse = { status: 200, body: { profile_id: 'profile-1' } };
  await ensureProjectConnectorProfile('P1', 'generic-api');
  expect(last()).toMatchObject({ method: 'POST' });
  expect(last().url).toContain('/projects/P1/connectors/generic-api/oauth2/profile');

  nextResponse = { status: 200, body: { ok: true } };
  const application = {
    authorization_url: 'https://identity.example.com/authorize',
    token_url: 'https://identity.example.com/token',
    client_id: 'client-123',
    token_endpoint_auth_method: 'none' as const,
    scopes: ['read'],
  };
  await putConnectionProfileOAuth2Application('P1', 'profile-1', application);
  expect(last()).toMatchObject({ method: 'PUT', body: application });
  expect(last().url).toContain('/projects/P1/connector-profiles/profile-1/oauth2/application');

  nextResponse = {
    status: 200,
    body: { application: { ...application, has_client_secret: false } },
  };
  await getConnectionProfileOAuth2Application('P1', 'profile-1');
  expect(last().method).toBe('GET');

  nextResponse = {
    status: 200,
    body: { metadata: { token_url: application.token_url } },
  };
  await discoverConnectionProfileOAuth2('P1', 'profile-1', {
    discovery_url: 'https://identity.example.com/.well-known/oauth-authorization-server',
  });
  expect(last().method).toBe('POST');

  nextResponse = {
    status: 200,
    body: { authorization_url: application.authorization_url },
  };
  await startConnectionProfileOAuth2Authorization('P1', 'profile-1', {
    success_redirect_uri: 'https://dev.kortix.com/projects/P1',
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
  await startConnectionProfileOAuth2DeviceAuthorization('P1', 'profile-1', {});
  expect(last().url).toContain('/oauth2/device');

  nextResponse = { status: 200, body: { status: 'pending' } };
  await pollConnectionProfileOAuth2DeviceAuthorization('P1', 'profile-1', 'session-1');
  expect(last().url).toContain('/oauth2/device/session-1');

  nextResponse = { status: 200, body: { status: 'active', scopes: ['read'] } };
  await getConnectionProfileOAuth2Status('P1', 'profile-1');
  expect(last().url).toContain('/oauth2/status');
});

const postmanDraftTypecheck: import('./connectors').ConnectorDraftInput = {
  slug: 'hubspot',
  provider: 'postman',
  spec: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
};
void postmanDraftTypecheck;

test('listConnectors GETs the project connectors list', async () => {
  nextResponse = { status: 200, body: { connectors: [] } };
  const result = await listConnectors('P1');
  expect(last().url).toContain('/executor/projects/P1/connectors');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ connectors: [] });
});

test('listConnectors throws on a failed response', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listConnectors('P1')).rejects.toBeTruthy();
});

test('listConnectors is a silent background read — a 403 never hits the global error sink', async () => {
  // Fired at workspace mount (project-home tiles, sidebar setup checklist);
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
  expect(last().url).toContain('/executor/projects/P1/connectors/sync');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result).toEqual({ synced: 2, errors: [] });
});

test('setConnectorCredentialMode PUTs { mode }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorCredentialMode('P1', 'slack', 'shared');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/credential-mode');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ mode: 'shared' });
});

test('setConnectorSensitive PUTs { sensitive }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorSensitive('P1', 'slack', true);
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/sensitive');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ sensitive: true });
});

test('getConnectorPolicies GETs the policies list', async () => {
  nextResponse = {
    status: 200,
    body: { policies: [{ match: '*', action: 'require_approval' }] },
  };
  const result = await getConnectorPolicies('P1', 'slack');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/policies');
  expect(last().method).toBe('GET');
  expect(result.policies).toHaveLength(1);
});

test('getConnectorPolicies surfaces the effective scope that decided each tool', async () => {
  // Project rules are evaluated before connector rules and CANNOT be overridden
  // (see the executor's resolveEffectiveAction). Without `effective`, an editor
  // renders a connector rule the runtime is actually ignoring.
  nextResponse = {
    status: 200,
    body: {
      policies: [{ match: 'send_email', action: 'always_run' }],
      effective: [
        { path: 'send_email', action: 'block', source: 'project' },
        { path: 'list_labels', action: 'always_run', source: 'connector' },
      ],
      project_policies: [{ match: 'gmail.send_email', action: 'block' }],
      default_mode: 'risk',
    },
  };
  const result = await getConnectorPolicies('P1', 'gmail');
  const overruled = result.effective?.find((e) => e.path === 'send_email');
  expect(overruled?.source).toBe('project');
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
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/policies');
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
    `/executor/projects/P1/connectors/${encodeURIComponent('my app/v1')}/config`,
  );
  expect(last().url).not.toContain('my app/v1');
  expect(last().method).toBe('GET');
  expect(result.slug).toBe('my app/v1');
});

test('setConnectorName PUTs { name }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorName('P1', 'slack', 'Team Slack');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/name');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ name: 'Team Slack' });
});

test('pipedreamConnect POSTs an empty body to the connect endpoint', async () => {
  nextResponse = {
    status: 200,
    body: { connectUrl: 'https://pipedream.com/connect/x' },
  };
  const result = await pipedreamConnect('P1', 'github');
  expect(last().url).toContain('/executor/projects/P1/connectors/github/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.connectUrl).toContain('pipedream.com');
});

test('createConnector POSTs the draft as the raw body', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  const draft = {
    slug: 'my-http',
    provider: 'http' as const,
    url: 'https://example.com',
  };
  await createConnector('P1', draft);
  expect(last().url).toContain('/executor/projects/P1/connectors');
  expect(last().url).not.toContain('/connectors/');
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
  expect(last().url).toContain('/executor/projects/P1/connectors/auth-discovery');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(draft);
});

test('deleteConnector DELETEs the connector by slug', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteConnector('P1', 'slack');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack');
  expect(last().method).toBe('DELETE');
});

test('listPipedreamApps GETs with no query string when no optional params are given', async () => {
  nextResponse = { status: 200, body: { apps: [], hasMore: false } };
  await listPipedreamApps('P1');
  expect(last().url).toContain('/executor/projects/P1/pipedream/apps');
  expect(last().url).not.toContain('?');
  expect(last().method).toBe('GET');
});

test('listPipedreamApps GETs with q + cursor as query params when given', async () => {
  nextResponse = {
    status: 200,
    body: { apps: [], nextCursor: 'c2', hasMore: true },
  };
  const result = await listPipedreamApps('P1', 'slack', 'c1');
  expect(last().url).toContain('/executor/projects/P1/pipedream/apps?');
  expect(last().url).toContain('q=slack');
  expect(last().url).toContain('cursor=c1');
  expect(result.nextCursor).toBe('c2');
});

test('listDiscoverIntegrations GETs a searchable cursor page', async () => {
  nextResponse = { status: 200, body: { items: [], total: 0, hasMore: false } };
  await listDiscoverIntegrations('P1', 'notion admin', '48');
  expect(last().url).toContain('/executor/projects/P1/discover/integrations?');
  expect(last().url).toContain('q=notion+admin');
  expect(last().url).toContain('cursor=48');
  expect(last().method).toBe('GET');
});

test('getDiscoverIntegration GETs detail by encoded catalogue id', async () => {
  nextResponse = {
    status: 200,
    body: { item: { id: 'openapi/1forge-com' }, variants: [] },
  };
  const result = await getDiscoverIntegration('P1', 'openapi/1forge-com');
  expect(last().url).toContain('/executor/projects/P1/discover/integrations/detail?');
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
  expect(last().url).toContain('/executor/connect-status');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ configured: true, provider: 'pipedream' });
});

test('setConnectorCredential PUTs { value }', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setConnectorCredential('P1', 'slack', 'sekret');
  expect(last().url).toContain('/executor/projects/P1/connectors/slack/credential');
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
  expect(last().url).toContain('/executor/projects/P1/connectors/sharepoint/credential');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ oauth2 });
});

test('pipedreamFinalize POSTs an empty body to the connect/finalize endpoint', async () => {
  nextResponse = { status: 200, body: { connected: true, accountId: 'acc_1' } };
  const result = await pipedreamFinalize('P1', 'github');
  expect(last().url).toContain('/executor/projects/P1/connectors/github/connect/finalize');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result).toEqual({ connected: true, accountId: 'acc_1' });
});

test('connection profile lifecycle uses the typed project profile routes', async () => {
  nextResponse = { status: 200, body: { profiles: [] } };
  await listConnectionProfiles('P1');
  expect(last().url).toContain('/projects/P1/connector-profiles');
  expect(last().method).toBe('GET');

  nextResponse = {
    status: 201,
    body: {
      profile_id: 'profile-1',
      connector_alias: 'veyris',
      owner_type: 'external',
      owner_id: 'thread-1',
      label: 'Thread 1',
      status: 'active',
      is_default: false,
      metadata: {},
    },
  };
  await reconcileConnectionProfile('P1', {
    connector_alias: 'veyris',
    owner_type: 'external',
    owner_id: 'thread-1',
    label: 'Thread 1',
  });
  expect(last().method).toBe('POST');
  expect(last().body).not.toHaveProperty('credential');

  nextResponse = { status: 200, body: { ok: true } };
  await updateConnectionProfileCredential('P1', 'profile-1', {
    value: 'capability',
  });
  expect(last().url).toContain('/connector-profiles/profile-1/credential');
  expect(last().body).toEqual({ value: 'capability' });
  await updateConnectionProfileCredential('P1', 'profile-1', {
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
  await revokeConnectionProfile('P1', 'profile-1');
  expect(last().url).toContain('/connector-profiles/profile-1/revoke');
  await activateConnectionProfile('P1', 'profile-1');
  expect(last().url).toContain('/connector-profiles/profile-1/activate');
});

test('member profile creation is owner-scoped by the API and never accepts an owner id', async () => {
  nextResponse = {
    status: 201,
    body: {
      profile_id: 'profile-member',
      connector_alias: 'gmail',
      owner_type: 'member',
      owner_id: 'user-from-token',
      label: 'My Gmail',
      status: 'active',
      is_default: false,
      metadata: {},
    },
  };
  await reconcileMemberConnectionProfile('P1', {
    connector_alias: 'gmail',
    label: 'My Gmail',
  });
  expect(last().url).toContain('/projects/P1/connector-profiles/me');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ connector_alias: 'gmail', label: 'My Gmail' });
});

test('profile-specific Pipedream connect and finalize bind the OAuth identity to the profile', async () => {
  nextResponse = {
    status: 200,
    body: { connectUrl: 'https://pipedream.test/connect' },
  };
  await pipedreamConnectConnectionProfile('P1', 'profile-member', {
    success_redirect_uri: 'kortix://connected',
  });
  expect(last().url).toContain('/projects/P1/connector-profiles/profile-member/connect');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ success_redirect_uri: 'kortix://connected' });

  nextResponse = {
    status: 200,
    body: { connected: true, accountId: 'acc-member' },
  };
  await pipedreamFinalizeConnectionProfile('P1', 'profile-member');
  expect(last().url).toContain('/projects/P1/connector-profiles/profile-member/connect/finalize');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
});
