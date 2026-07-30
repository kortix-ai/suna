import { createPrivateKey, createSecretKey, randomUUID } from 'node:crypto';
import { OAuth2ClientCredentialsSchema, type OAuth2ClientCredentials } from '@kortix/api-contract';
import { CompactSign } from 'jose';
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
  randomId?: () => string;
}

export async function buildPrivateKeyClientAssertion(
  config: OAuth2ClientCredentials,
  runtime: Pick<OAuth2Runtime, 'now' | 'randomId'> = {},
): Promise<string> {
  if (
    config.token_endpoint_auth_method !== 'private_key_jwt' ||
    !config.private_key ||
    !config.certificate_thumbprint
  ) {
    throw new Error('OAuth2 private_key_jwt requires a private key and certificate thumbprint');
  }
  const nowSeconds = Math.floor((runtime.now?.() ?? Date.now()) / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: config.token_url,
      iss: config.client_id,
      sub: config.client_id,
      jti: runtime.randomId?.() ?? randomUUID(),
      nbf: nowSeconds - 60,
      exp: nowSeconds + 600,
    }),
  );
  return new CompactSign(payload)
    .setProtectedHeader({
      alg: 'PS256',
      typ: 'JWT',
      'x5t#S256': config.certificate_thumbprint,
    })
    .sign(createPrivateKey(config.private_key));
}

async function buildClientSecretAssertion(
  config: OAuth2ClientCredentials,
  runtime: OAuth2Runtime,
): Promise<string> {
  const nowSeconds = Math.floor((runtime.now?.() ?? Date.now()) / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: config.token_url,
      iss: config.client_id,
      sub: config.client_id,
      jti: runtime.randomId?.() ?? randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + 300,
    }),
  );
  return new CompactSign(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(createSecretKey(Buffer.from(config.client_secret ?? '')));
}

async function tokenRequest(
  config: OAuth2ClientCredentials,
  runtime: OAuth2Runtime,
): Promise<RequestInit> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.client_id,
  });
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });

  if (config.scopes?.length) body.set('scope', config.scopes.join(' '));
  if (config.resource) body.set('resource', config.resource);
  if (config.audience) body.set('audience', config.audience);

  if (config.token_endpoint_auth_method === 'none') {
    // Public client. client_id remains in the request body.
  } else if (config.token_endpoint_auth_method === 'client_secret_basic') {
    headers.set(
      'authorization',
      `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`,
    );
  } else if (config.token_endpoint_auth_method === 'client_secret_post') {
    body.set('client_secret', config.client_secret ?? '');
  } else if (config.token_endpoint_auth_method === 'client_secret_jwt') {
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set('client_assertion', await buildClientSecretAssertion(config, runtime));
  } else {
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set('client_assertion', await buildPrivateKeyClientAssertion(config, runtime));
  }

  return { method: 'POST', headers, body };
}

export async function acquireOAuth2ClientCredentialsToken(
  config: OAuth2ClientCredentials,
  runtime: OAuth2Runtime = {},
): Promise<OAuth2AccessToken> {
  const now = runtime.now?.() ?? Date.now();
  const request = await tokenRequest(config, runtime);
  const response = runtime.fetchImpl
    ? await runtime.fetchImpl(config.token_url, request)
    : await safeEgressFetch(config.token_url, request);
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
