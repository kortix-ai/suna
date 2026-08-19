/**
 * Authorization discovery for a protected resource — the MCP authorization
 * chain (MCP spec 2025-06-18 §Authorization):
 *
 *   probe the resource → `WWW-Authenticate: Bearer resource_metadata="…"`
 *   → RFC 9728 protected resource metadata → `authorization_servers[0]`
 *   → RFC 8414 / OIDC authorization-server metadata → endpoints,
 *     `registration_endpoint` (RFC 7591), supported auth methods, PKCE.
 *
 * Every step is best-effort with a documented fallback, so a partially
 * compliant server still yields whatever can be filled in and a list of
 * warnings that explain what could not. Nothing here stores state or retains
 * credentials; it interprets metadata only.
 */
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import {
  type AuthorizationServerMetadata,
  type OAuth2LifecycleRuntime,
  boundedJson,
  fetchAuthorizationServerMetadata,
  httpsMetadataUrl,
  providerFetch,
} from './oauth2-lifecycle';

export type ProtectedResourceProvider = 'mcp' | 'http' | 'graphql';

export interface ProtectedResourceOAuth2Discovery {
  /** The URL that was probed (the connector's MCP URL / base URL / endpoint). */
  resource_url: string;
  /** False when the resource answered the unauthenticated probe with 2xx. */
  requires_authorization: boolean;
  /** RFC 8707 resource indicator: PRM `resource`, else the probed URL. */
  resource?: string;
  resource_name?: string;
  protected_resource_metadata_url?: string;
  /** Issuer of the authorization server that was resolved. */
  authorization_server?: string;
  /** Endpoints ready to be saved as the connection's OAuth2 application. */
  metadata?: Partial<OAuth2ApplicationInput>;
  /** RFC 7591 endpoint when the server supports dynamic client registration. */
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  /** Scopes to request: `WWW-Authenticate scope`, else PRM, else AS-wide. */
  scopes: string[];
  warnings: string[];
}

interface ChallengeHints {
  resourceMetadataUrl?: string;
  scopes?: string[];
}

function parseChallenge(value: string | null): ChallengeHints {
  const raw = value?.trim() ?? '';
  if (!/^bearer\b/i.test(raw)) return {};
  const resourceMetadataUrl = httpsMetadataUrl(
    raw.match(/(?:^|[\s,])resource_metadata\s*=\s*"([^"]+)"/i)?.[1],
  );
  const scope = raw.match(/(?:^|[\s,])scope\s*=\s*"([^"]*)"/i)?.[1];
  const scopes = scope?.split(/\s+/).filter(Boolean);
  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scopes?.length ? { scopes } : {}),
  };
}

async function probe(
  resourceUrl: string,
  provider: ProtectedResourceProvider,
  runtime: OAuth2LifecycleRuntime,
): Promise<Response> {
  if (provider === 'mcp') {
    return providerFetch(
      resourceUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      runtime,
    );
  }
  return providerFetch(
    resourceUrl,
    { method: 'GET', headers: { accept: 'application/json, */*' } },
    runtime,
  );
}

function wellKnown(base: URL, suffix: string, pathInsertion: boolean): string {
  const path = base.pathname.replace(/\/+$/, '');
  return pathInsertion && path
    ? `${base.origin}/.well-known/${suffix}${path}`
    : `${base.origin}/.well-known/${suffix}`;
}

/** RFC 9728 §3: the well-known PRM location, with the resource path inserted. */
function protectedResourceMetadataCandidates(resourceUrl: URL): string[] {
  const withPath = wellKnown(resourceUrl, 'oauth-protected-resource', true);
  const root = wellKnown(resourceUrl, 'oauth-protected-resource', false);
  return withPath === root ? [root] : [withPath, root];
}

/** MCP spec discovery order for an issuer: RFC 8414 path-insertion, then OIDC
 * path-insertion, then OIDC path-appending; root forms when the issuer has no
 * path. */
export function authorizationServerMetadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

interface ProtectedResourceMetadata {
  url: string;
  resource?: string;
  resource_name?: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

async function fetchProtectedResourceMetadata(
  url: string,
  runtime: OAuth2LifecycleRuntime,
): Promise<ProtectedResourceMetadata | null> {
  let response: Response;
  try {
    response = await providerFetch(
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      runtime,
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload = await boundedJson(response);
  const servers = Array.isArray(payload.authorization_servers)
    ? payload.authorization_servers
        .map((value: unknown) => httpsMetadataUrl(value))
        .filter((value): value is string => !!value)
    : [];
  if (servers.length === 0) return null;
  return {
    url,
    ...(httpsMetadataUrl(payload.resource) ? { resource: httpsMetadataUrl(payload.resource) } : {}),
    ...(typeof payload.resource_name === 'string' && payload.resource_name.trim()
      ? { resource_name: payload.resource_name.trim().slice(0, 256) }
      : {}),
    authorization_servers: servers,
    ...(Array.isArray(payload.scopes_supported)
      ? {
          scopes_supported: payload.scopes_supported.filter(
            (scope: unknown): scope is string => typeof scope === 'string',
          ),
        }
      : {}),
  };
}

async function resolveAuthorizationServer(
  issuer: string,
  runtime: OAuth2LifecycleRuntime,
): Promise<AuthorizationServerMetadata | null> {
  for (const candidate of authorizationServerMetadataCandidates(issuer)) {
    try {
      const metadata = await fetchAuthorizationServerMetadata(candidate, runtime);
      if (metadata.application.token_url || metadata.application.authorization_url) {
        return metadata;
      }
    } catch {
      /* try the next documented location */
    }
  }
  return null;
}

export async function discoverProtectedResourceOAuth2(
  input: { resourceUrl: string; provider: ProtectedResourceProvider },
  runtime: OAuth2LifecycleRuntime = {},
): Promise<ProtectedResourceOAuth2Discovery> {
  const resourceUrl = new URL(input.resourceUrl);
  const warnings: string[] = [];
  const response = await probe(input.resourceUrl, input.provider, runtime);
  if (response.ok) {
    return {
      resource_url: input.resourceUrl,
      requires_authorization: false,
      scopes: [],
      warnings,
    };
  }
  if (response.status !== 401 && response.status !== 403) {
    warnings.push(
      `The server answered the unauthenticated probe with HTTP ${response.status}; it may not use OAuth.`,
    );
  }
  const hints = parseChallenge(response.headers.get('www-authenticate'));

  const prmCandidates = [
    ...(hints.resourceMetadataUrl ? [hints.resourceMetadataUrl] : []),
    ...protectedResourceMetadataCandidates(resourceUrl),
  ];
  let prm: ProtectedResourceMetadata | null = null;
  for (const candidate of [...new Set(prmCandidates)]) {
    prm = await fetchProtectedResourceMetadata(candidate, runtime);
    if (prm) break;
  }

  let authorizationServer: AuthorizationServerMetadata | null = null;
  let issuer: string | undefined;
  if (prm) {
    for (const candidate of prm.authorization_servers) {
      authorizationServer = await resolveAuthorizationServer(candidate, runtime);
      if (authorizationServer) {
        issuer = candidate;
        break;
      }
    }
    if (!authorizationServer) {
      warnings.push(
        'Protected resource metadata names an authorization server whose metadata could not be read.',
      );
    }
  } else {
    warnings.push(
      'No protected resource metadata (RFC 9728) was published; tried the authorization server at the resource origin instead.',
    );
    authorizationServer = await resolveAuthorizationServer(resourceUrl.origin, runtime);
    if (authorizationServer) issuer = authorizationServer.issuer ?? resourceUrl.origin;
  }

  const resource = prm?.resource ?? input.resourceUrl;
  const scopes =
    hints.scopes ??
    prm?.scopes_supported ??
    authorizationServer?.scopes_supported ??
    [];

  if (!authorizationServer) {
    warnings.push(
      'No authorization server metadata could be discovered. Enter the OAuth2 endpoints manually.',
    );
    return {
      resource_url: input.resourceUrl,
      requires_authorization: true,
      resource,
      ...(prm?.resource_name ? { resource_name: prm.resource_name } : {}),
      ...(prm ? { protected_resource_metadata_url: prm.url } : {}),
      scopes,
      warnings,
    };
  }

  const metadata: Partial<OAuth2ApplicationInput> = {
    ...authorizationServer.application,
    resource,
  };
  for (const key of Object.keys(metadata) as (keyof OAuth2ApplicationInput)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  if (!authorizationServer.registration_endpoint) {
    warnings.push(
      'The authorization server does not advertise dynamic client registration (RFC 7591); a pre-registered client_id is required.',
    );
  }

  return {
    resource_url: input.resourceUrl,
    requires_authorization: true,
    resource,
    ...(prm?.resource_name ? { resource_name: prm.resource_name } : {}),
    ...(prm ? { protected_resource_metadata_url: prm.url } : {}),
    ...(issuer ? { authorization_server: issuer } : {}),
    metadata,
    ...(authorizationServer.registration_endpoint
      ? { registration_endpoint: authorizationServer.registration_endpoint }
      : {}),
    ...(authorizationServer.token_endpoint_auth_methods_supported
      ? {
          token_endpoint_auth_methods_supported:
            authorizationServer.token_endpoint_auth_methods_supported,
        }
      : {}),
    ...(authorizationServer.code_challenge_methods_supported
      ? { code_challenge_methods_supported: authorizationServer.code_challenge_methods_supported }
      : {}),
    scopes,
    warnings,
  };
}
