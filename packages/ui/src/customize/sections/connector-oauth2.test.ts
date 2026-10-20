import { describe, expect, test } from 'bun:test';
import {
  type OAuth2ApplicationForm,
  type OAuth2CredentialForm,
  buildOAuth2ApplicationInput,
  buildOAuth2CredentialInput,
  createConnectorWithOptionalOAuth2,
  mergeOAuth2DiscoveryMetadata,
  oauth2ApplicationFormValid,
  oauth2CredentialFormValid,
} from './connector-oauth2';

const SECRET_FORM: OAuth2CredentialForm = {
  tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
  clientId: 'client-id',
  authMethod: 'client_secret_post',
  clientSecret: 'client-secret',
  privateKey: '',
  certificateThumbprint: '',
  scopes: 'https://graph.microsoft.com/.default',
  resource: '',
  audience: '',
};

describe('buildOAuth2CredentialInput', () => {
  test('normalizes a Microsoft client-secret configuration', () => {
    expect(
      buildOAuth2CredentialInput({
        tokenUrl: ' https://login.microsoftonline.com/tenant/oauth2/v2.0/token ',
        clientId: ' client-id ',
        authMethod: 'client_secret_post',
        clientSecret: 'client-secret',
        privateKey: '',
        certificateThumbprint: '',
        scopes: 'https://graph.microsoft.com/.default\nopenid  profile',
        resource: '',
        audience: '',
      }),
    ).toEqual({
      oauth2: {
        type: 'oauth2_client_credentials',
        token_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
        client_id: 'client-id',
        token_endpoint_auth_method: 'client_secret_post',
        client_secret: 'client-secret',
        scopes: ['https://graph.microsoft.com/.default', 'openid', 'profile'],
      },
    });
  });

  test('builds a certificate assertion configuration without secret fields', () => {
    const result = buildOAuth2CredentialInput({
      tokenUrl: 'https://login.example.com/token',
      clientId: 'client-id',
      authMethod: 'private_key_jwt',
      clientSecret: '',
      privateKey: 'private-key',
      certificateThumbprint: 'thumbprint',
      scopes: '',
      resource: 'https://tenant.sharepoint.com',
      audience: 'https://api.example.com',
    });

    expect(result).toEqual({
      oauth2: {
        type: 'oauth2_client_credentials',
        token_url: 'https://login.example.com/token',
        client_id: 'client-id',
        token_endpoint_auth_method: 'private_key_jwt',
        private_key: 'private-key',
        certificate_thumbprint: 'thumbprint',
        resource: 'https://tenant.sharepoint.com',
        audience: 'https://api.example.com',
      },
    });
  });

  test('builds HTTP Basic token authentication', () => {
    expect(
      buildOAuth2CredentialInput({
        ...SECRET_FORM,
        authMethod: 'client_secret_basic',
      }),
    ).toEqual({
      oauth2: {
        type: 'oauth2_client_credentials',
        token_url: SECRET_FORM.tokenUrl,
        client_id: 'client-id',
        token_endpoint_auth_method: 'client_secret_basic',
        client_secret: 'client-secret',
        scopes: ['https://graph.microsoft.com/.default'],
      },
    });
  });
});

describe('oauth2CredentialFormValid', () => {
  test('requires the token URL, client ID, and selected client authentication', () => {
    expect(oauth2CredentialFormValid(SECRET_FORM)).toBe(true);
    expect(oauth2CredentialFormValid({ ...SECRET_FORM, clientSecret: '' })).toBe(false);
    expect(
      oauth2CredentialFormValid({
        ...SECRET_FORM,
        authMethod: 'private_key_jwt',
        clientSecret: '',
        privateKey: 'private-key',
        certificateThumbprint: 'thumbprint',
      }),
    ).toBe(true);
  });

  test('supports public clients and client secret JWT', () => {
    expect(
      oauth2CredentialFormValid({
        ...SECRET_FORM,
        authMethod: 'none',
        clientSecret: '',
      }),
    ).toBe(true);
    expect(
      oauth2CredentialFormValid({
        ...SECRET_FORM,
        authMethod: 'client_secret_jwt',
      }),
    ).toBe(true);
  });

  test('does not require a certificate thumbprint for private key JWT', () => {
    expect(
      oauth2CredentialFormValid({
        ...SECRET_FORM,
        authMethod: 'private_key_jwt',
        clientSecret: '',
        privateKey: 'private-key',
        certificateThumbprint: '',
      }),
    ).toBe(true);
  });
});

const AUTHORIZATION_CODE_FORM: OAuth2ApplicationForm = {
  grant: 'authorization_code',
  discoveryUrl: '',
  authorizationUrl: 'https://identity.example.com/authorize',
  tokenUrl: 'https://identity.example.com/token',
  deviceAuthorizationUrl: '',
  revocationUrl: 'https://identity.example.com/revoke',
  clientId: 'client-id',
  authMethod: 'client_secret_basic',
  clientSecret: 'client-secret',
  privateKey: '',
  scopes: 'openid profile',
  resource: '',
  audience: 'https://api.example.com',
};

describe('OAuth2 application form', () => {
  test('builds a provider-independent delegated application', () => {
    expect(buildOAuth2ApplicationInput(AUTHORIZATION_CODE_FORM)).toEqual({
      authorization_url: 'https://identity.example.com/authorize',
      token_url: 'https://identity.example.com/token',
      revocation_url: 'https://identity.example.com/revoke',
      client_id: 'client-id',
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret: 'client-secret',
      scopes: ['openid', 'profile'],
      audience: 'https://api.example.com',
    });
  });

  test('validates Authorization Code, Device Authorization, and discovery', () => {
    expect(oauth2ApplicationFormValid(AUTHORIZATION_CODE_FORM)).toBe(true);
    expect(
      oauth2ApplicationFormValid({
        ...AUTHORIZATION_CODE_FORM,
        grant: 'device_authorization',
        authorizationUrl: '',
        deviceAuthorizationUrl: 'https://identity.example.com/device',
      }),
    ).toBe(true);
    expect(
      oauth2ApplicationFormValid({
        ...AUTHORIZATION_CODE_FORM,
        discoveryUrl: 'https://identity.example.com/.well-known/openid-configuration',
        authorizationUrl: '',
        tokenUrl: '',
      }),
    ).toBe(true);
  });

  test('merges discovered endpoints without replacing explicit values', () => {
    expect(
      mergeOAuth2DiscoveryMetadata(AUTHORIZATION_CODE_FORM, {
        authorization_url: 'https://discovered.example.com/authorize',
        token_url: 'https://discovered.example.com/token',
        device_authorization_url: 'https://discovered.example.com/device',
        revocation_url: 'https://discovered.example.com/revoke',
      }),
    ).toMatchObject({
      authorizationUrl: AUTHORIZATION_CODE_FORM.authorizationUrl,
      tokenUrl: AUTHORIZATION_CODE_FORM.tokenUrl,
      deviceAuthorizationUrl: 'https://discovered.example.com/device',
      revocationUrl: AUTHORIZATION_CODE_FORM.revocationUrl,
    });
  });
});

describe('createConnectorWithOptionalOAuth2', () => {
  test('creates the connector before it stores the OAuth2 credential', async () => {
    const calls: string[] = [];
    let createdDraft: unknown;
    await createConnectorWithOptionalOAuth2(
      'project-1',
      { slug: 'sharepoint', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      SECRET_FORM,
      {
        createConnector: async (_projectId, draft) => {
          calls.push('create');
          createdDraft = draft;
          return { ok: true };
        },
        deleteConnector: async () => {
          calls.push('delete');
        },
        setConnectorCredential: async (_projectId, slug, credential) => {
          const method =
            'oauth2' in credential ? credential.oauth2.token_endpoint_auth_method : 'static';
          calls.push(`credential:${slug}:${method}`);
        },
      },
    );

    expect(calls).toEqual(['create', 'credential:sharepoint:client_secret_post']);
    expect(createdDraft).toMatchObject({ slug: 'sharepoint', create_only: true });
  });

  test('does not create a credential when OAuth2 is not selected', async () => {
    let credentialCalls = 0;
    await createConnectorWithOptionalOAuth2(
      'project-1',
      { slug: 'public-api', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      null,
      {
        createConnector: async () => ({ ok: true }),
        deleteConnector: async () => undefined,
        setConnectorCredential: async () => {
          credentialCalls += 1;
        },
      },
    );

    expect(credentialCalls).toBe(0);
  });

  test('deletes the connector when OAuth2 credential validation fails', async () => {
    const calls: string[] = [];
    const credentialError = new Error('invalid_client');

    await expect(
      createConnectorWithOptionalOAuth2(
        'project-1',
        { slug: 'sharepoint', provider: 'openapi', spec: 'https://example.com/openapi.json' },
        SECRET_FORM,
        {
          createConnector: async () => {
            calls.push('create');
            return { ok: true };
          },
          deleteConnector: async () => {
            calls.push('delete');
          },
          setConnectorCredential: async () => {
            calls.push('credential');
            throw credentialError;
          },
        },
      ),
    ).rejects.toBe(credentialError);

    expect(calls).toEqual(['create', 'credential', 'delete']);
  });

  // The connector exists once the create returns, even when its first sync
  // failed. The page opens on it, so the app credential typed into the form
  // is stored too: Retry after a fixed spec then runs with it.
  test('stores the OAuth2 credential when the first sync fails, and keeps the sync error', async () => {
    const calls: string[] = [];

    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      { slug: 'sharepoint', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      SECRET_FORM,
      {
        createConnector: async () => {
          calls.push('create');
          return {
            ok: true,
            sync: {
              synced: 0,
              errors: [{ slug: 'sharepoint', error: 'sandbox unavailable' }],
            },
          };
        },
        deleteConnector: async () => {
          calls.push('delete');
        },
        setConnectorCredential: async () => {
          calls.push('credential');
        },
      },
    );

    expect(result).toEqual({
      syncError: 'sandbox unavailable',
      credentialStored: true,
      signInPending: false,
    });
    expect(calls).toEqual(['create', 'credential']);
  });

  // An MCP server answers its first tools/list with 401 or 403 until someone
  // signs in. That is the sign-in still to do, not a failed connector, but
  // only when the connector has an auth scheme to sign in with.
  const mcpDraft = { slug: 'linear-mcp', provider: 'mcp' as const, url: 'https://mcp.example.com' };
  // What the create returns when the server's WWW-Authenticate named Bearer.
  const bearerDiscovered = {
    status: 'detected' as const,
    recommended: {
      type: 'bearer' as const,
      in: 'header' as const,
      name: 'Authorization',
      prefix: 'Bearer',
    },
    candidates: [],
    warnings: [],
    totalRequests: 1,
    title: null,
  };
  const syncFails = (error: string) => ({
    synced: 1,
    errors: [{ slug: 'linear-mcp', error }],
  });
  const answers401 = (
    calls: string[],
    options: { discovered?: boolean; resync?: ReturnType<typeof syncFails> } = {},
  ) => ({
    createConnector: async () => {
      calls.push('create');
      return {
        ok: true,
        sync: syncFails('MCP tools/list failed: HTTP 401'),
        ...(options.discovered === false ? {} : { authDiscovery: bearerDiscovered }),
      };
    },
    deleteConnector: async () => {
      calls.push('delete');
    },
    // Storing a credential re-syncs an MCP connector; the PUT returns that sync.
    setConnectorCredential: async (_projectId: string, slug: string) => {
      calls.push(`credential:${slug}`);
      return { ok: true, sync: options.resync ?? { synced: 1, errors: [] } };
    },
  });

  test('an MCP 401 with no credential to store is a pending sign-in, not a sync error', async () => {
    const calls: string[] = [];
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      mcpDraft,
      null,
      answers401(calls),
    );

    expect(result).toEqual({ syncError: null, credentialStored: false, signInPending: true });
    expect(calls).toEqual(['create']);
  });

  test('an auth scheme picked in the form counts the same as a discovered one', async () => {
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      { ...mcpDraft, auth: { type: 'bearer' } },
      null,
      answers401([], { discovered: false }),
    );

    expect(result).toEqual({ syncError: null, credentialStored: false, signInPending: true });
  });

  // No WWW-Authenticate challenge and no auth picked: the connector sends no
  // credential, so no account sign-in can fix the 401. It stays the error.
  test('an MCP 401 on a connector with no auth scheme stays a sync error', async () => {
    const calls: string[] = [];
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      mcpDraft,
      null,
      answers401(calls, { discovered: false }),
    );

    expect(result).toEqual({
      syncError: 'MCP tools/list failed: HTTP 401',
      credentialStored: false,
      signInPending: false,
    });
  });

  test('an auth scheme of none is no auth scheme', async () => {
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      { ...mcpDraft, auth: { type: 'none' } },
      null,
      answers401([]),
    );

    expect(result.signInPending).toBe(false);
    expect(result.syncError).toBe('MCP tools/list failed: HTTP 401');
  });

  test('an MCP 401 still stores the OAuth2 app credential, which is the sign-in', async () => {
    const calls: string[] = [];
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      mcpDraft,
      SECRET_FORM,
      answers401(calls),
    );

    expect(result).toEqual({ syncError: null, credentialStored: true, signInPending: false });
    expect(calls).toEqual(['create', 'credential:linear-mcp']);
  });

  // The server can refuse the client-credentials token too (it takes only a
  // user sign-in, or the token's audience is wrong). Then "connected" is false.
  test('the re-sync after the credential still fails: that failure is the sync error', async () => {
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      mcpDraft,
      SECRET_FORM,
      answers401([], { resync: syncFails('MCP tools/list failed: HTTP 401') }),
    );

    expect(result).toEqual({
      syncError: 'MCP tools/list failed: HTTP 401',
      credentialStored: true,
      signInPending: false,
    });
  });

  test('a 403 counts as the same pending sign-in', async () => {
    const calls: string[] = [];
    const deps = answers401(calls);
    const result = await createConnectorWithOptionalOAuth2('project-1', mcpDraft, null, {
      ...deps,
      createConnector: async () => ({
        ok: true,
        sync: syncFails('HTTP 403 Forbidden'),
        authDiscovery: bearerDiscovered,
      }),
    });

    expect(result).toEqual({ syncError: null, credentialStored: false, signInPending: true });
  });

  test('a 401 from a provider that is not MCP stays a sync error; the credential is stored', async () => {
    const calls: string[] = [];
    const deps = answers401(calls);
    const result = await createConnectorWithOptionalOAuth2(
      'project-1',
      { slug: 'linear-mcp', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      SECRET_FORM,
      // Storing a credential does not re-sync a connector that is not MCP.
      {
        ...deps,
        setConnectorCredential: async (_projectId: string, slug: string) => {
          calls.push(`credential:${slug}`);
          return { ok: true };
        },
      },
    );

    expect(result).toEqual({
      syncError: 'MCP tools/list failed: HTTP 401',
      credentialStored: true,
      signInPending: false,
    });
    expect(calls).toEqual(['create', 'credential:linear-mcp']);
  });

  test('does not delete an existing connector when create-only mode rejects a duplicate', async () => {
    const calls: string[] = [];
    const conflict = new Error('Connector already exists');

    await expect(
      createConnectorWithOptionalOAuth2(
        'project-1',
        { slug: 'sharepoint', provider: 'openapi', spec: 'https://example.com/openapi.json' },
        SECRET_FORM,
        {
          createConnector: async () => {
            calls.push('create');
            throw conflict;
          },
          deleteConnector: async () => {
            calls.push('delete');
          },
          setConnectorCredential: async () => {
            calls.push('credential');
          },
        },
      ),
    ).rejects.toBe(conflict);

    expect(calls).toEqual(['create']);
  });
});
