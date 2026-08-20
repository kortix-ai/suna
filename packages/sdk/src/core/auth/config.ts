/**
 * Discovery — the ONE unauthenticated Kortix call this module makes.
 *
 * `GET {backendUrl}/auth/config` answers "where do I sign in against this
 * deployment?": the browser-reachable GoTrue origin, the publishable anon key,
 * and which sign-in methods and social providers the deployment enables. It is
 * public, cacheable, and identical for every caller, so no `Authorization`
 * header is ever attached.
 */

import { authErrorFromResponse, KortixAuthError, readResponseBody, type AuthFetch } from './errors';

/** A sign-in method the deployment enables. */
export type KortixAuthMethod = 'magic' | 'password';

/** The deployment's auth configuration, mapped to camelCase at the boundary. */
export interface KortixAuthConfig {
  /** Always `'supabase'` today. A union member so a future provider is additive. */
  provider: 'supabase';
  /** Browser-reachable GoTrue ORIGIN — no `/auth/v1` suffix, no trailing slash. */
  url: string;
  /** The publishable anon key, sent as the `apikey` header on every GoTrue call. */
  anonKey: string;
  methods: KortixAuthMethod[];
  /** Social providers, lowercased (`['google']`). Empty when none are enabled. */
  providers: string[];
  signupsEnabled: boolean;
}

export interface FetchKortixAuthConfigOptions {
  /** Kortix API base. Both `https://api.kortix.com` and `.../v1` are valid. */
  backendUrl: string;
  fetch?: AuthFetch;
  signal?: AbortSignal;
}

const AUTH_CONFIG_ROUTE = 'GET /v1/auth/config';

/** Both `https://host` and `https://host/v1` are documented `backendUrl`s.
 *  Same rule as `core/rest/platform-client/host-boundary.ts`. */
function apiBase(backendUrl: string): string {
  let trimmed = backendUrl;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function stripTrailingSlash(value: string): string {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

/**
 * Read the deployment's auth configuration.
 *
 * Throws `KortixAuthError` with a code the caller can branch on:
 * `auth_config_unsupported` (404 — the deployment predates the route),
 * `auth_config_unavailable` (503 — the deployment has no publishable key or no
 * browser-reachable GoTrue), `auth_config_unsupported_provider`, or
 * `auth_config_invalid`.
 */
export async function fetchKortixAuthConfig(
  options: FetchKortixAuthConfigOptions,
): Promise<KortixAuthConfig> {
  const fetchImpl: AuthFetch = options.fetch ?? fetch;
  const url = `${apiBase(options.backendUrl)}/auth/config`;

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const body = await readResponseBody(response);

  if (response.status === 404) {
    throw new KortixAuthError(
      `${AUTH_CONFIG_ROUTE} is not available on ${url} — this Kortix deployment predates SDK auth discovery. Pass \`config\` to createKortixAuth to skip discovery.`,
      { status: 404, code: 'auth_config_unsupported', body },
    );
  }

  if (!response.ok) {
    throw authErrorFromResponse(response, body, `${AUTH_CONFIG_ROUTE} failed`);
  }

  return mapAuthConfig(body);
}

/** Map the snake_case wire payload to the camelCase public type. */
function mapAuthConfig(body: unknown): KortixAuthConfig {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  const provider = record.provider;
  if (provider !== 'supabase') {
    throw new KortixAuthError(
      `Unsupported auth provider ${JSON.stringify(provider)} — this @kortix/sdk build only signs in against 'supabase'. Upgrade the SDK.`,
      { status: 200, code: 'auth_config_unsupported_provider', body },
    );
  }

  const url = typeof record.url === 'string' ? stripTrailingSlash(record.url) : '';
  const anonKey = typeof record.anon_key === 'string' ? record.anon_key : '';
  if (!url || !anonKey) {
    throw new KortixAuthError(
      `${AUTH_CONFIG_ROUTE} returned no ${url ? 'anon_key' : 'url'}`,
      { status: 200, code: 'auth_config_invalid', body },
    );
  }

  const methods = Array.isArray(record.methods)
    ? record.methods.filter((value): value is KortixAuthMethod =>
        value === 'magic' || value === 'password',
      )
    : [];

  const providers = Array.isArray(record.providers)
    ? record.providers.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    provider: 'supabase',
    url,
    anonKey,
    methods: methods.length > 0 ? methods : ['magic', 'password'],
    providers,
    signupsEnabled: typeof record.signups_enabled === 'boolean' ? record.signups_enabled : true,
  };
}
