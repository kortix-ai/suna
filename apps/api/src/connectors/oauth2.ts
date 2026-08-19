import {
  OAUTH2_RESERVED_TOKEN_PARAMETER_NAMES,
  type OAuth2ClientCredentials,
  OAuth2ClientCredentialsSchema,
} from '@kortix/api-contract';
import {
  type AuthorizationServer,
  type Client,
  type ClientAuth,
  ClientSecretBasic,
  ClientSecretJwt,
  ClientSecretPost,
  None,
  PrivateKeyJwt,
  clientCredentialsGrantRequest,
  customFetch,
  modifyAssertion,
} from 'oauth4webapi';
import { safeEgressFetch } from '../shared/ssrf-guard';

export interface OAuth2AccessToken {
  access_token: string;
  token_type: string;
  expires_at: number;
  scopes: string[];
}

interface StoredOAuth2Credential {
  kind: 'oauth2_client_credentials';
  version: 1;
  config: OAuth2ClientCredentials;
  token: OAuth2AccessToken | null;
}

interface OAuth2Runtime {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

const OAUTH2_RESERVED_TOKEN_PARAMETERS = new Set<string>(OAUTH2_RESERVED_TOKEN_PARAMETER_NAMES);

async function importPs256PrivateKey(pem: string): Promise<CryptoKey> {
  const match = pem
    .trim()
    .match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----$/);
  const encoded = match?.[1];
  if (!encoded) throw new Error('OAuth2 private_key_jwt requires a PKCS#8 PEM private key');
  const bytes = new Uint8Array(Buffer.from(encoded.replace(/\s+/g, ''), 'base64'));
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

async function clientAuthentication(config: OAuth2ClientCredentials): Promise<ClientAuth> {
  switch (config.token_endpoint_auth_method) {
    case 'none':
      return None();
    case 'client_secret_basic':
      return ClientSecretBasic(config.client_secret ?? '');
    case 'client_secret_post':
      return ClientSecretPost(config.client_secret ?? '');
    case 'client_secret_jwt':
      return ClientSecretJwt(config.client_secret ?? '', {
        [modifyAssertion](header, payload) {
          header.typ = 'JWT';
          payload.aud = config.token_url;
        },
      });
    case 'private_key_jwt': {
      if (!config.private_key) throw new Error('OAuth2 private_key_jwt requires a private key');
      const key = await importPs256PrivateKey(config.private_key);
      return PrivateKeyJwt(key, {
        [modifyAssertion](header, payload) {
          header.typ = 'JWT';
          if (config.certificate_thumbprint) {
            header['x5t#S256'] = config.certificate_thumbprint;
          }
          payload.aud = config.token_url;
        },
      });
    }
  }
}

export async function acquireOAuth2ClientCredentialsToken(
  config: OAuth2ClientCredentials,
  runtime: OAuth2Runtime = {},
): Promise<OAuth2AccessToken> {
  const now = runtime.now?.() ?? Date.now();
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(config.token_params ?? {})) {
    // The API schema rejects these names. Keep this defensive filter because
    // stored credentials can predate schema changes or originate outside the
    // current HTTP boundary.
    if (!OAUTH2_RESERVED_TOKEN_PARAMETERS.has(key)) parameters.set(key, value);
  }
  if (config.scopes?.length) parameters.set('scope', config.scopes.join(' '));
  if (config.resource) parameters.set('resource', config.resource);
  if (config.audience) parameters.set('audience', config.audience);

  const authorizationServer: AuthorizationServer = {
    issuer: config.token_url,
    token_endpoint: config.token_url,
  };
  const client: Client = { client_id: config.client_id };
  const fetchImpl = runtime.fetchImpl ?? safeEgressFetch;
  const response = await clientCredentialsGrantRequest(
    authorizationServer,
    client,
    await clientAuthentication(config),
    parameters,
    {
      [customFetch]: (input, init) => fetchImpl(input, init as RequestInit),
    },
  );
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const code =
      typeof payload.error === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(payload.error)
        ? payload.error
        : 'token_endpoint_error';
    throw new Error(`OAuth2 token request failed (${response.status}): ${code}`);
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('OAuth2 token response has no access_token');
  }
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(0, payload.expires_in)
      : 300;
  return {
    access_token: payload.access_token,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    expires_at: now + expiresIn * 1000,
    scopes:
      typeof payload.scope === 'string'
        ? payload.scope.split(/\s+/).filter(Boolean)
        : (config.scopes ?? []),
  };
}

export function oauth2TokenIsFresh(
  token: Pick<OAuth2AccessToken, 'expires_at'> | null | undefined,
  now = Date.now(),
): boolean {
  return !!token && token.expires_at - now > 60_000;
}

export function createStoredOAuth2Credential(
  config: OAuth2ClientCredentials,
  token: OAuth2AccessToken | null = null,
): string {
  return JSON.stringify({
    kind: 'oauth2_client_credentials',
    version: 1,
    config,
    token,
  } satisfies StoredOAuth2Credential);
}

function parseStoredOAuth2Credential(value: string): StoredOAuth2Credential | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind !== 'oauth2_client_credentials' || parsed.version !== 1) return null;
    const config = OAuth2ClientCredentialsSchema.safeParse(parsed.config);
    if (!config.success) return null;
    const token =
      parsed.token &&
      typeof parsed.token === 'object' &&
      typeof (parsed.token as Record<string, unknown>).access_token === 'string' &&
      typeof (parsed.token as Record<string, unknown>).expires_at === 'number'
        ? (parsed.token as unknown as OAuth2AccessToken)
        : null;
    return {
      kind: 'oauth2_client_credentials',
      version: 1,
      config: config.data,
      token,
    };
  } catch {
    return null;
  }
}

export async function resolveStoredOAuth2Credential(
  value: string,
  runtime: {
    now?: () => number;
    acquire?: (config: OAuth2ClientCredentials) => Promise<OAuth2AccessToken>;
  } = {},
): Promise<{ accessToken: string; updatedValue: string | null }> {
  const stored = parseStoredOAuth2Credential(value);
  if (!stored) throw new Error('Invalid stored OAuth2 credential');
  const now = runtime.now?.() ?? Date.now();
  if (oauth2TokenIsFresh(stored.token, now)) {
    return { accessToken: stored.token!.access_token, updatedValue: null };
  }
  const token = runtime.acquire
    ? await runtime.acquire(stored.config)
    : await acquireOAuth2ClientCredentialsToken(stored.config);
  return {
    accessToken: token.access_token,
    updatedValue: createStoredOAuth2Credential(stored.config, token),
  };
}
