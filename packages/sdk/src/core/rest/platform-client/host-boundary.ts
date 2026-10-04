/**
 * Explicit Kortix API operations for host boundaries.
 *
 * Browser code normally uses the configured SDK client. Server actions,
 * anonymous pages, downloads, and streaming endpoints need request-scoped
 * tokens or non-JSON response handling. These functions keep route, header,
 * and response knowledge inside the SDK.
 */

import { auditFilterQuery } from '../projects-client/audit-filter';
import { platformApiBase } from './shared';

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
  const response = await fetch(`${platformApiBase(options.backendUrl)}${path}`, {
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
  client_id?: string;
  client_name?: string;
  /** `confidential` (server app) or `public` (browser/native, PKCE only). */
  client_type?: 'confidential' | 'public' | string;
  scopes?: unknown[];
  scope?: string;
  /** True when this user already approved this client for every requested scope — approve without asking. */
  remembered?: boolean;
  /** True when the client registered itself (RFC 7591, e.g. an MCP client) — no account vouches for it. */
  self_registered?: boolean;
  /** Where approval sends the browser: the redirect host, or a native app's scheme (`cursor:`). */
  redirect_to?: string;
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
  /** The project the link belongs to. Absent on older servers. */
  project_id?: string;
  project_name: string;
  /** The name the agent suggested for the new account, or `null`. Absent on older servers. */
  label?: string | null;
  /** Whose account the agent meant the link to create. Absent on older servers. */
  owner?: 'me' | 'project';
  slug: string;
  app: string | null;
  /**
   * The connector's display name ("Google Calendar"), so a card can name the
   * app before it is opened. Optional: servers older than this field omit it.
   */
  name?: string | null;
  /** The app's logo. `null` when the catalog has none; absent on older servers. */
  icon_url?: string | null;
  /**
   * An account landed on this connector after the link was minted: the ask is
   * settled, and a card that reloads shows it as done. `false` for a link
   * nobody has completed, even when the connector already had an account.
   * Absent on older servers and for links minted before they recorded when.
   */
  connected?: boolean;
  expires_at: string;
}

export function getConnectorSetupLink(
  token: string,
  options: HostRequestOptions,
): Promise<ConnectorSetupLinkInfo> {
  return requestJson(`/setup-links/connectors/${encodeURIComponent(token)}`, options);
}

/**
 * What `POST /setup-links/connectors/:token/start` answers.
 *
 * `connect_url` is `null` when there is nothing to authorize: the toolkit
 * needs no auth, or the slot already holds an active account, which the
 * provider reuses rather than re-authorizing. `connected` is then `true`, and
 * `already_connected` tells the two apart. Neither case is an error.
 */
export interface ConnectorSetupLinkStart {
  connect_url: string | null;
  connected?: boolean;
  already_connected?: boolean;
}

/** What `POST /setup-links/connectors/:token/finalize` answers. */
export interface ConnectorSetupLinkFinalize {
  connected: boolean;
  /**
   * Who the account was authorized as: an email, a login, or a display name.
   * `null` (or absent, on older servers) when the provider exposes none.
   */
  connected_as?: string | null;
  /** The account finalized, when the call named one (`connectionId`). */
  connection_id?: string;
  /** That account's name, when the call named one. */
  label?: string;
}

/** Name ONE account the link's dialog created, so the session is told about it. */
export interface FinalizeConnectorSetupLinkInput {
  connectionId?: string;
}

export function startConnectorSetupLink(
  token: string,
  options: HostRequestOptions,
): Promise<ConnectorSetupLinkStart> {
  return requestJson(`/setup-links/connectors/${encodeURIComponent(token)}/start`, options, {
    method: 'POST',
    body: {},
  });
}

/**
 * Persist the connection the hosted Pipedream page just made, and tell the
 * session that asked for it. The hosted page cannot call back into us, so the
 * client that opened it polls this until `connected` is true. Idempotent: a
 * repeat call on an already-connected connector returns `true` without
 * re-notifying the session.
 */
export function finalizeConnectorSetupLink(
  token: string,
  options: HostRequestOptions,
  input: FinalizeConnectorSetupLinkInput = {},
): Promise<ConnectorSetupLinkFinalize> {
  return requestJson(`/setup-links/connectors/${encodeURIComponent(token)}/finalize`, options, {
    method: 'POST',
    body: input.connectionId ? { connection_id: input.connectionId } : {},
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
  /** The person whose session asked for the values, when that is a member of
   *  the project's account; the form may keep the values to them. Absent on
   *  older servers and for links an automation minted. */
  requester?: { label: string | null } | null;
}

export function getSecretSetupLink(
  token: string,
  options: HostRequestOptions,
): Promise<SecretSetupLinkInfo> {
  return requestJson(`/setup-links/secret/${encodeURIComponent(token)}`, options);
}

/**
 * Why a saved secret never reaches the session that requested it:
 * `agent_grant` — outside the session agent's `secrets` grant (a person with
 * project access can widen it); `session_allowlist` — outside the session's
 * create-time allowlist (fixed; start a new session).
 */
export type SecretWithheldReason = 'agent_grant' | 'session_allowlist';

export interface SecretSetupLinkWithheld {
  name: string;
  reason: SecretWithheldReason;
}

/** What `POST /setup-links/secret/:token` answers. */
export interface SecretSetupLinkSubmitResult {
  ok: boolean;
  /** Names whose values were saved. */
  saved: string[];
  /**
   * The requesting session's agent. Present only with `withheld`, and absent
   * on servers older than this field.
   */
  agent?: string;
  /**
   * Saved names the requesting session will not receive. The value IS saved;
   * a person must widen the grant before the agent can read it.
   */
  withheld?: SecretSetupLinkWithheld[];
}

export function submitSecretSetupLink(
  token: string,
  values: Record<string, string>,
  options: HostRequestOptions,
  /** `only_requester`: only the person who asked may use the values (see
   *  `SecretSetupLinkInfo.requester`). Omitted = everyone in the project. */
  audience?: { only_requester?: boolean },
): Promise<SecretSetupLinkSubmitResult> {
  return requestJson(`/setup-links/secret/${encodeURIComponent(token)}`, options, {
    method: 'POST',
    body: { values, ...(audience?.only_requester ? { only_requester: true } : {}) },
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
  query: Parameters<typeof auditFilterQuery>[0] & { format: 'csv' | 'jsonl' },
  options: HostRequestOptions,
): Promise<AccountAuditExport> {
  const response = await fetch(
    `${platformApiBase(options.backendUrl)}/accounts/${encodeURIComponent(accountId)}/audit/export?${auditFilterQuery(query)}`,
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
  const response = await fetch(`${platformApiBase(options.backendUrl)}/admin/stress-test/run`, {
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
  return new URL(`templates/public/${shareId.toLowerCase()}`, `${platformApiBase(backendUrl)}/`);
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
