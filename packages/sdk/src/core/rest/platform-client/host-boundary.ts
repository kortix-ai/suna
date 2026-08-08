/**
 * Explicit Kortix API operations for host boundaries.
 *
 * Browser code normally uses the configured SDK client. Server actions,
 * anonymous pages, downloads, and streaming endpoints need request-scoped
 * tokens or non-JSON response handling. These functions keep route, header,
 * and response knowledge inside the SDK.
 */

export interface HostRequestOptions {
  /** Kortix API base URL. Both `https://host` and `https://host/v1` are valid. */
  backendUrl: string;
  accessToken?: string | null;
  signal?: AbortSignal;
  cache?: RequestCache;
  /** Framework cache metadata. Kept structural so the SDK has no Next.js dependency. */
  next?: { revalidate?: number | false; tags?: string[] };
  headers?: HeadersInit;
}

export class HostBoundaryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'HostBoundaryError';
  }
}

function apiBase(backendUrl: string): string {
  let trimmed = backendUrl;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function requestHeaders(options: HostRequestOptions, json: boolean): Headers {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (json) headers.set('Content-Type', 'application/json');
  if (options.accessToken) {
    headers.set('Authorization', `Bearer ${options.accessToken}`);
  }
  return headers;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(response: Response, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['error_description', 'error', 'message']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
  }
  if (typeof body === 'string' && body) return body;
  return response.statusText || `HTTP ${response.status}`;
}

async function requestJson<T>(
  path: string,
  options: HostRequestOptions,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const json = init?.body !== undefined;
  const response = await fetch(`${apiBase(options.backendUrl)}${path}`, {
    method: init?.method ?? 'GET',
    headers: requestHeaders(options, json),
    ...(json ? { body: JSON.stringify(init.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.next ? { next: options.next } : {}),
  } as RequestInit);
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new HostBoundaryError(errorMessage(response, body), response.status, body);
  }
  return body as T;
}

export interface PublicMarketplaceQuery {
  query?: string;
  type?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

function marketplaceQuery(input?: PublicMarketplaceQuery): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (input?.type) params.set('type', input.type);
  if (input?.source) params.set('source', input.source);
  if (input?.limit !== undefined) params.set('limit', String(input.limit));
  if (input?.offset !== undefined) params.set('offset', String(input.offset));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function listPublicMarketplaceItems<
  T = {
    items: unknown[];
    total?: number;
    hasMore?: boolean;
    loading?: boolean;
    pending?: number;
    sources?: unknown[];
  },
>(options: HostRequestOptions, query?: PublicMarketplaceQuery): Promise<T> {
  return requestJson<T>(`/marketplace/items${marketplaceQuery(query)}`, options);
}

export function listPublicMarketplaces<
  T = {
    marketplaces: unknown[];
    loading?: boolean;
    pending?: number;
    sources?: unknown[];
  },
>(options: HostRequestOptions): Promise<T> {
  return requestJson<T>('/marketplace/marketplaces', options);
}

export function getPublicMarketplaceItem<T = Record<string, unknown>>(
  id: string,
  options: HostRequestOptions,
): Promise<T> {
  return requestJson<T>(`/marketplace/items/${encodeURIComponent(id)}`, options);
}

export function getPublicMarketplaceItemFile<T = Record<string, unknown>>(
  id: string,
  path: string,
  options: HostRequestOptions,
): Promise<T> {
  return requestJson<T>(
    `/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    options,
  );
}

export function checkAccessEmail<T = Record<string, unknown>>(
  email: string,
  options: HostRequestOptions,
): Promise<T> {
  return requestJson<T>('/access/check-email', options, {
    method: 'POST',
    body: { email },
  });
}

export function submitAccessRequest(
  input: { email: string; company?: string; useCase?: string },
  options: HostRequestOptions,
): Promise<unknown> {
  return requestJson('/access/request-access', options, {
    method: 'POST',
    body: input,
  });
}

export function recordPlatformLogout(options: HostRequestOptions): Promise<unknown> {
  return requestJson('/auth/logout', options, { method: 'POST', body: {} });
}

export interface OAuthConsentRequest {
  client_name?: string;
  scopes?: unknown[];
  scope?: string;
}

export function getOAuthConsentRequest(
  requestId: string,
  options: HostRequestOptions,
): Promise<OAuthConsentRequest> {
  return requestJson(`/oauth/authorize/consent/${encodeURIComponent(requestId)}`, options);
}

export function submitOAuthConsent(
  input: { requestId: string; approved: boolean },
  options: HostRequestOptions,
): Promise<{ redirect_uri?: string }> {
  return requestJson('/oauth/authorize/consent', options, {
    method: 'POST',
    body: { request_id: input.requestId, approved: input.approved },
  });
}

export interface ConnectorSetupLinkInfo {
  project_name: string;
  slug: string;
  app: string | null;
  expires_at: string;
}

export function getConnectorSetupLink(
  token: string,
  options: HostRequestOptions,
): Promise<ConnectorSetupLinkInfo> {
  return requestJson(`/setup-links/connectors/${encodeURIComponent(token)}`, options);
}

export function startConnectorSetupLink(
  token: string,
  options: HostRequestOptions,
): Promise<{ connect_url: string }> {
  return requestJson(`/setup-links/connectors/${encodeURIComponent(token)}/start`, options, {
    method: 'POST',
    body: {},
  });
}

export interface SecretSetupLinkInfo {
  project_name: string;
  fields: Array<{
    name: string;
    label: string | null;
    description: string | null;
  }>;
  expires_at: string;
}

export function getSecretSetupLink(
  token: string,
  options: HostRequestOptions,
): Promise<SecretSetupLinkInfo> {
  return requestJson(`/setup-links/secret/${encodeURIComponent(token)}`, options);
}

export function submitSecretSetupLink(
  token: string,
  values: Record<string, string>,
  options: HostRequestOptions,
): Promise<unknown> {
  return requestJson(`/setup-links/secret/${encodeURIComponent(token)}`, options, {
    method: 'POST',
    body: { values },
  });
}

export function getPublicShareByToken<T = Record<string, unknown>>(
  token: string,
  options: HostRequestOptions,
): Promise<T> {
  return requestJson<T>(`/p/public-share/${encodeURIComponent(token)}`, options);
}

export function startSessionWithToken(
  projectId: string,
  sessionId: string,
  options: HostRequestOptions,
): Promise<unknown> {
  return requestJson(
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/start`,
    options,
    { method: 'POST', body: {} },
  );
}

export function getMaintenanceConfig<T>(options: HostRequestOptions): Promise<T> {
  return requestJson<T>('/system/maintenance', options);
}

export function setMaintenanceConfig<T>(config: T, options: HostRequestOptions): Promise<T> {
  return requestJson<T>('/system/maintenance', options, {
    method: 'PUT',
    body: config,
  });
}

export function getUserRolesWithToken<T = unknown[]>(options: HostRequestOptions): Promise<T> {
  return requestJson<T>('/user-roles', options);
}

export function submitDemoRequest(
  input: Record<string, unknown>,
  options: HostRequestOptions,
): Promise<unknown> {
  return requestJson('/system/demo-request', options, {
    method: 'POST',
    body: input,
  });
}

export interface AccountAuditExport {
  blob: Blob;
  filename: string | null;
  capped: boolean;
  rowCount: string | null;
  /** True when this page reached the end of the matching export. */
  complete?: boolean;
  /** Pass this as `cursor` to resume when complete is false. */
  nextCursor?: string | null;
}

export async function downloadAccountAudit(
  accountId: string,
  query: {
    format: 'csv' | 'jsonl';
    action?: string;
    actor?: string;
    project_id?: string;
    session_id?: string;
    actor_type?: 'human' | 'agent' | 'service_account' | 'system';
    source?: string;
    phase?: string;
    outcome?: 'success' | 'failure' | 'denied' | 'pending';
    request_id?: string;
    correlation_id?: string;
    resource_type?: string;
    since?: string;
    until?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  },
  options: HostRequestOptions,
): Promise<AccountAuditExport> {
  const params = new URLSearchParams({ format: query.format });
  if (query.action) params.set('action', query.action);
  if (query.actor) params.set('actor', query.actor);
  if (query.project_id) params.set('project_id', query.project_id);
  if (query.session_id) params.set('session_id', query.session_id);
  if (query.actor_type) params.set('actor_type', query.actor_type);
  if (query.source) params.set('source', query.source);
  if (query.phase) params.set('phase', query.phase);
  if (query.outcome) params.set('outcome', query.outcome);
  if (query.request_id) params.set('request_id', query.request_id);
  if (query.correlation_id) params.set('correlation_id', query.correlation_id);
  if (query.resource_type) params.set('resource_type', query.resource_type);
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit != null) params.set('limit', String(query.limit));
  const response = await fetch(
    `${apiBase(options.backendUrl)}/accounts/${encodeURIComponent(accountId)}/audit/export?${params}`,
    {
      headers: requestHeaders(options, false),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!response.ok) {
    const body = await parseResponseBody(response);
    throw new HostBoundaryError(errorMessage(response, body), response.status, body);
  }
  return {
    blob: await response.blob(),
    filename: response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? null,
    capped: response.headers.get('x-audit-capped') === 'true',
    rowCount: response.headers.get('x-audit-row-count'),
    complete: response.headers.get('x-audit-complete') !== 'false',
    nextCursor: response.headers.get('x-audit-next-cursor') || null,
  };
}

export async function openStressTestStream(
  input: Record<string, unknown>,
  options: HostRequestOptions,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${apiBase(options.backendUrl)}/admin/stress-test/run`, {
    method: 'POST',
    headers: requestHeaders(options, true),
    body: JSON.stringify(input),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = await parseResponseBody(response);
    throw new HostBoundaryError(errorMessage(response, body), response.status, body);
  }
  if (!response.body) {
    throw new HostBoundaryError('No response body', response.status, null);
  }
  return response.body;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildPublicTemplateUrl(backendUrl: string, shareId: string): URL | null {
  if (!UUID_PATTERN.test(shareId)) return null;
  return new URL(`templates/public/${shareId.toLowerCase()}`, `${apiBase(backendUrl)}/`);
}

export async function getPublicTemplate<T>(
  backendUrl: string,
  shareId: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = buildPublicTemplateUrl(backendUrl, shareId);
  if (!url) throw new HostBoundaryError('Invalid shareId parameter', 400, null);
  const response = await fetch(url, { signal });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new HostBoundaryError(errorMessage(response, body), response.status, body);
  }
  return body as T;
}
