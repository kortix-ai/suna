/**
 * RFC 7591 dynamic client registration. Kortix registers itself as an OAuth2
 * client with a third-party authorization server so the user never has to
 * create an app, copy a client_id, or paste a secret. Registration happens
 * once per connection; the issued client lives (encrypted) in the
 * connection's OAuth2 application.
 */
import type { OAuth2TokenEndpointAuthMethod } from '@kortix/api-contract';
import { oauth2ApplicationTypeFor } from './oauth2-issuer';
import {
  type OAuth2LifecycleRuntime,
  boundedJson,
  httpsMetadataUrl,
  providerFetch,
  safeError,
} from './oauth2-lifecycle';

export const KORTIX_OAUTH2_CLIENT_NAME = 'Kortix';
export const KORTIX_OAUTH2_CLIENT_URI = 'https://kortix.com';

/** Confidential first — Kortix is a server and can keep a secret — then public. */
const AUTH_METHOD_PREFERENCE: OAuth2TokenEndpointAuthMethod[] = [
  'client_secret_basic',
  'client_secret_post',
  'none',
];

export function selectTokenEndpointAuthMethod(
  supported: string[] | undefined,
): OAuth2TokenEndpointAuthMethod {
  // RFC 8414 §2: absent means client_secret_basic.
  if (!supported) return 'client_secret_basic';
  return AUTH_METHOD_PREFERENCE.find((method) => supported.includes(method)) ?? 'none';
}

export interface RegisteredOAuth2Client {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method: OAuth2TokenEndpointAuthMethod;
  registration_access_token?: string;
  registration_client_uri?: string;
}

function isSupportedAuthMethod(value: unknown): value is OAuth2TokenEndpointAuthMethod {
  return AUTH_METHOD_PREFERENCE.includes(value as OAuth2TokenEndpointAuthMethod);
}

export async function registerOAuth2Client(
  input: {
    registrationEndpoint: string;
    redirectUri: string;
    scopes?: string[];
    tokenEndpointAuthMethodsSupported?: string[];
    clientName?: string;
  },
  runtime: OAuth2LifecycleRuntime = {},
): Promise<RegisteredOAuth2Client> {
  const requested = selectTokenEndpointAuthMethod(input.tokenEndpointAuthMethodsSupported);
  const body = {
    client_name: input.clientName?.trim() || KORTIX_OAUTH2_CLIENT_NAME,
    client_uri: KORTIX_OAUTH2_CLIENT_URI,
    redirect_uris: [input.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // SEP-837: without this an OIDC-based server rejects a loopback redirect
    // URI, which is exactly the self-hosted Kortix case.
    application_type: oauth2ApplicationTypeFor(input.redirectUri),
    token_endpoint_auth_method: requested,
    ...(input.scopes?.length ? { scope: input.scopes.join(' ') } : {}),
  };
  const response = await providerFetch(
    input.registrationEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
    runtime,
  );
  const payload = await boundedJson(response);
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(
      `OAuth2 client registration failed (${response.status}): ${safeError(payload)}`,
    );
  }
  if (typeof payload.client_id !== 'string' || !payload.client_id.trim()) {
    throw new Error('OAuth2 client registration response has no client_id');
  }
  const issuedMethod = isSupportedAuthMethod(payload.token_endpoint_auth_method)
    ? payload.token_endpoint_auth_method
    : requested;
  const clientSecret =
    typeof payload.client_secret === 'string' && payload.client_secret
      ? payload.client_secret
      : undefined;
  if (issuedMethod !== 'none' && !clientSecret) {
    throw new Error(
      `OAuth2 client registration issued ${issuedMethod} without a client_secret`,
    );
  }
  return {
    client_id: payload.client_id.trim(),
    ...(issuedMethod !== 'none' && clientSecret ? { client_secret: clientSecret } : {}),
    token_endpoint_auth_method: issuedMethod,
    ...(typeof payload.registration_access_token === 'string' && payload.registration_access_token
      ? { registration_access_token: payload.registration_access_token }
      : {}),
    ...(httpsMetadataUrl(payload.registration_client_uri)
      ? { registration_client_uri: httpsMetadataUrl(payload.registration_client_uri) }
      : {}),
  };
}
