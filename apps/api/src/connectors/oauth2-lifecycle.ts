import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import {
  createHash,
  createPrivateKey,
  createSecretKey,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { CompactSign } from 'jose';
import { safeEgressFetch } from '../shared/ssrf-guard';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface OAuth2LifecycleRuntime {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  randomBytes?: (length: number) => Buffer;
  randomId?: () => string;
}

export interface OAuth2TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at: number;
  scopes: string[];
}

async function clientAssertion(
  application: OAuth2ApplicationInput,
  audience: string,
  runtime: OAuth2LifecycleRuntime,
): Promise<string> {
  const now = Math.floor((runtime.now?.() ?? Date.now()) / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: audience,
      iss: application.client_id,
      sub: application.client_id,
      jti: runtime.randomId?.() ?? randomUUID(),
      iat: now,
      exp: now + 300,
    }),
  );
  if (application.token_endpoint_auth_method === 'client_secret_jwt') {
    return new CompactSign(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(createSecretKey(Buffer.from(application.client_secret ?? '')));
  }
  return new CompactSign(payload)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .sign(createPrivateKey(application.private_key ?? ''));
}

async function applyClientAuthentication(
  application: OAuth2ApplicationInput,
  endpoint: string,
  body: URLSearchParams,
  headers: Headers,
  runtime: OAuth2LifecycleRuntime,
): Promise<void> {
  body.set('client_id', application.client_id);
  switch (application.token_endpoint_auth_method) {
    case 'none':
      return;
    case 'client_secret_basic':
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${application.client_id}:${application.client_secret ?? ''}`).toString('base64')}`,
      );
      return;
    case 'client_secret_post':
      body.set('client_secret', application.client_secret ?? '');
      return;
    case 'client_secret_jwt':
    case 'private_key_jwt':
      body.set('client_assertion_type', ASSERTION_TYPE);
      body.set('client_assertion', await clientAssertion(application, endpoint, runtime));
  }
}

async function providerFetch(
  url: string,
  init: RequestInit,
  runtime: OAuth2LifecycleRuntime,
): Promise<Response> {
  if (runtime.fetchImpl) return runtime.fetchImpl(url, init);
  return safeEgressFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new Error('OAuth2 provider response is too large');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error('OAuth2 provider response is too large');
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeError(payload: Record<string, unknown>): string {
  return typeof payload.error === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(payload.error)
    ? payload.error
    : 'provider_error';
}

function endpoint(application: OAuth2ApplicationInput, key: keyof OAuth2ApplicationInput): string {
  const value = application[key];
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    throw new Error(`OAuth2 ${String(key)} is not configured`);
  }
  return value;
}

function tokenSet(
  payload: Record<string, unknown>,
  application: OAuth2ApplicationInput,
  now: number,
  priorRefreshToken?: string,
): OAuth2TokenSet {
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('OAuth2 token response has no access_token');
  }
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(0, payload.expires_in)
      : 300;
  return {
    access_token: payload.access_token,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refresh_token: payload.refresh_token }
      : priorRefreshToken
        ? { refresh_token: priorRefreshToken }
        : {}),
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    expires_at: now + expiresIn * 1000,
    scopes:
      typeof payload.scope === 'string'
        ? payload.scope.split(/\s+/).filter(Boolean)
        : (application.scopes ?? []),
  };
}

async function tokenRequest(
  application: OAuth2ApplicationInput,
  body: URLSearchParams,
  runtime: OAuth2LifecycleRuntime,
  priorRefreshToken?: string,
): Promise<OAuth2TokenSet> {
  const tokenUrl = endpoint(application, 'token_url');
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  await applyClientAuthentication(application, tokenUrl, body, headers, runtime);
  for (const [key, value] of Object.entries(application.token_params ?? {})) body.set(key, value);
  if (application.resource) body.set('resource', application.resource);
  if (application.audience) body.set('audience', application.audience);
  const response = await providerFetch(
    tokenUrl,
    { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) },
    runtime,
  );
  const payload = await boundedJson(response);
  if (!response.ok) {
    throw new Error(`OAuth2 token request failed (${response.status}): ${safeError(payload)}`);
  }
  return tokenSet(payload, application, runtime.now?.() ?? Date.now(), priorRefreshToken);
}

export function buildOAuth2AuthorizationRequest(
  application: OAuth2ApplicationInput,
  input: {
    callbackUrl: string;
    scopes?: string[];
    authorizationParams?: Record<string, string>;
    now?: () => number;
    randomBytes?: (length: number) => Buffer;
  },
): {
  authorizationUrl: string;
  state: string;
  stateHash: string;
  pkceVerifier: string;
  expiresAt: number;
} {
  const authorizationUrl = endpoint(application, 'authorization_url');
  const bytes = input.randomBytes ?? randomBytes;
  const state = bytes(32).toString('base64url');
  const pkceVerifier = bytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(pkceVerifier).digest('base64url');
  const url = new URL(authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', application.client_id);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const scopes = input.scopes ?? application.scopes;
  if (scopes?.length) url.searchParams.set('scope', scopes.join(' '));
  for (const [key, value] of Object.entries(application.authorization_params ?? {})) {
    url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(input.authorizationParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return {
    authorizationUrl: url.href,
    state,
    stateHash: createHash('sha256').update(state).digest('hex'),
    pkceVerifier,
    expiresAt: (input.now?.() ?? Date.now()) + 10 * 60_000,
  };
}

export async function exchangeOAuth2AuthorizationCode(
  application: OAuth2ApplicationInput,
  input: { code: string; callbackUrl: string; pkceVerifier: string },
  runtime: OAuth2LifecycleRuntime = {},
): Promise<OAuth2TokenSet> {
  return tokenRequest(
    application,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.callbackUrl,
      code_verifier: input.pkceVerifier,
    }),
    runtime,
  );
}

export async function refreshOAuth2Token(
  application: OAuth2ApplicationInput,
  refreshToken: string,
  runtime: OAuth2LifecycleRuntime = {},
): Promise<OAuth2TokenSet> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (application.scopes?.length) body.set('scope', application.scopes.join(' '));
  return tokenRequest(application, body, runtime, refreshToken);
}

export async function startOAuth2DeviceAuthorization(
  application: OAuth2ApplicationInput,
  runtime: OAuth2LifecycleRuntime = {},
): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
}> {
  const deviceUrl = endpoint(application, 'device_authorization_url');
  const body = new URLSearchParams();
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  await applyClientAuthentication(application, deviceUrl, body, headers, runtime);
  if (application.scopes?.length) body.set('scope', application.scopes.join(' '));
  const response = await providerFetch(deviceUrl, { method: 'POST', headers, body }, runtime);
  const payload = await boundedJson(response);
  if (!response.ok) {
    throw new Error(
      `OAuth2 device authorization failed (${response.status}): ${safeError(payload)}`,
    );
  }
  if (
    typeof payload.device_code !== 'string' ||
    typeof payload.user_code !== 'string' ||
    typeof payload.verification_uri !== 'string'
  ) {
    throw new Error('OAuth2 device response is incomplete');
  }
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(1, payload.expires_in)
      : 600;
  const interval =
    typeof payload.interval === 'number' && Number.isFinite(payload.interval)
      ? Math.max(1, Math.min(300, payload.interval))
      : 5;
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    ...(typeof payload.verification_uri_complete === 'string'
      ? { verificationUriComplete: payload.verification_uri_complete }
      : {}),
    expiresAt: (runtime.now?.() ?? Date.now()) + expiresIn * 1000,
    intervalSeconds: interval,
  };
}

export async function pollOAuth2DeviceAuthorization(
  application: OAuth2ApplicationInput,
  deviceCode: string,
  runtime: OAuth2LifecycleRuntime = {},
): Promise<
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'active'; token: OAuth2TokenSet }
> {
  const tokenUrl = endpoint(application, 'token_url');
  const body = new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode });
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  await applyClientAuthentication(application, tokenUrl, body, headers, runtime);
  const response = await providerFetch(tokenUrl, { method: 'POST', headers, body }, runtime);
  const payload = await boundedJson(response);
  if (response.ok) {
    return {
      status: 'active',
      token: tokenSet(payload, application, runtime.now?.() ?? Date.now()),
    };
  }
  const error = safeError(payload);
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down' };
  if (error === 'expired_token') return { status: 'expired' };
  if (error === 'access_denied') return { status: 'denied' };
  throw new Error(`OAuth2 token request failed (${response.status}): ${error}`);
}

export async function revokeOAuth2Token(
  application: OAuth2ApplicationInput,
  token: string,
  tokenTypeHint: 'access_token' | 'refresh_token',
  runtime: OAuth2LifecycleRuntime = {},
): Promise<void> {
  const revocationUrl = endpoint(application, 'revocation_url');
  const body = new URLSearchParams({ token, token_type_hint: tokenTypeHint });
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  await applyClientAuthentication(application, revocationUrl, body, headers, runtime);
  const response = await providerFetch(revocationUrl, { method: 'POST', headers, body }, runtime);
  if (!response.ok) {
    const payload = await boundedJson(response);
    throw new Error(`OAuth2 revocation failed (${response.status}): ${safeError(payload)}`);
  }
}

function httpsMetadataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverOAuth2Metadata(
  discoveryUrl: string,
  runtime: OAuth2LifecycleRuntime = {},
): Promise<Partial<OAuth2ApplicationInput>> {
  const response = await providerFetch(
    discoveryUrl,
    { method: 'GET', headers: { accept: 'application/json' } },
    runtime,
  );
  const payload = await boundedJson(response);
  if (!response.ok) {
    throw new Error(`OAuth2 discovery failed (${response.status}): ${safeError(payload)}`);
  }
  return {
    discovery_url: discoveryUrl,
    authorization_url: httpsMetadataUrl(payload.authorization_endpoint),
    token_url: httpsMetadataUrl(payload.token_endpoint),
    device_authorization_url: httpsMetadataUrl(payload.device_authorization_endpoint),
    revocation_url: httpsMetadataUrl(payload.revocation_endpoint),
    scopes: Array.isArray(payload.scopes_supported)
      ? payload.scopes_supported.filter((scope): scope is string => typeof scope === 'string')
      : undefined,
  };
}
