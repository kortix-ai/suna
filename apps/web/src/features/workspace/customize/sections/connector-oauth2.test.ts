import { describe, expect, test } from 'bun:test';
import {
  buildOAuth2ApplicationInput,
  buildOAuth2CredentialInput,
  createConnectorWithOptionalOAuth2,
  mergeOAuth2DiscoveryMetadata,
  oauth2ApplicationFormValid,
  oauth2CredentialFormValid,
  type OAuth2ApplicationForm,
  type OAuth2CredentialForm,
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
    await createConnectorWithOptionalOAuth2(
      'project-1',
      { slug: 'sharepoint', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      SECRET_FORM,
      {
        createConnector: async () => {
          calls.push('create');
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
  });

  test('does not create a credential when OAuth2 is not selected', async () => {
    let credentialCalls = 0;
    await createConnectorWithOptionalOAuth2(
      'project-1',
      { slug: 'public-api', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      null,
      {
        createConnector: async () => undefined,
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
});
