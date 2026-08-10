// Connectors — connector CRUD, credentials, Pipedream. Connectors are
// workspace-wide visible; the only access gate is the agent's `connectors`
// grant (kortix.yaml [[agents]].connectors), not anything configured here.

import { backendApi } from '../../http/api-client';
import { ApiError } from '../../http/api/errors';
import { authenticatedFetch } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { unwrap } from './shared';

// ─── Connectors ────────────────────────────────────────────────────────────

export interface ConnectorAction {
  path: string;
  name: string;
  description: string;
  risk: 'read' | 'write' | 'destructive';
  inputSchema: Record<string, unknown> | null;
}

/** One connector as exposed by the callable workspace catalog. */
export interface ConnectorCatalogEntry {
  slug: string;
  name: string;
  provider: string;
  status: string;
  actions: ConnectorAction[];
}

/** One callable connector action, identified by `<connector>.<action>`. */
export interface ConnectorTool {
  tool: string;
  connector: string;
  action: string;
  risk: ConnectorAction['risk'];
  description: string;
  inputSchema: ConnectorAction['inputSchema'];
}

export interface ConnectorCallResult<T = unknown> {
  ok: boolean;
  data?: T;
  risk?: ConnectorAction['risk'];
  status?: string;
  reason?: string;
  execution_id?: string | null;
  retryable?: boolean;
  approval_url?: string | null;
  approval_summary?: string | null;
  approval_instructions?: string | null;
}

export interface ConnectorAttachmentUploadInput {
  filename: string;
  contentType: string;
  contentDisposition?: 'attachment' | 'inline';
  contentId?: string;
}

export interface ConnectorAttachmentUploadResult {
  attachment_id: string;
  filename: string;
  content_type: string;
  content_disposition: 'attachment' | 'inline';
  content_id?: string;
  size: number;
  expires_at: string;
}

function connectorGatewayPath(workspaceId: string | undefined, suffix: string): string {
  return workspaceId
    ? `/connectors/workspaces/${encodeURIComponent(workspaceId)}/${suffix}`
    : `/connectors/${suffix}`;
}

export async function getConnectorCatalog(workspaceId?: string): Promise<ConnectorCatalogEntry[]> {
  const result = unwrap(
    await backendApi.get<{ connectors?: ConnectorCatalogEntry[] }>(
      connectorGatewayPath(workspaceId, 'catalog'),
    ),
  );
  return result.connectors ?? [];
}

export async function listConnectorTools(workspaceId?: string): Promise<ConnectorTool[]> {
  const tools: ConnectorTool[] = [];
  for (const connector of await getConnectorCatalog(workspaceId)) {
    for (const action of connector.actions) {
      tools.push({
        tool: `${connector.slug}.${action.path}`,
        connector: connector.slug,
        action: action.path,
        risk: action.risk,
        description: action.description || action.name,
        inputSchema: action.inputSchema,
      });
    }
  }
  return tools;
}

export async function searchConnectorTools(
  workspaceId: string | undefined,
  query = '',
  options: { limit?: number } = {},
): Promise<ConnectorTool[]> {
  const normalized = query.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const exact: ConnectorTool[] = [];
  const tokenMatches: ConnectorTool[] = [];
  for (const tool of await listConnectorTools(workspaceId)) {
    const haystack = `${tool.tool} ${tool.description}`.toLowerCase();
    if (!normalized || haystack.includes(normalized)) exact.push(tool);
    else if (tokens.every((token) => haystack.includes(token))) tokenMatches.push(tool);
  }
  return [...exact, ...tokenMatches].slice(0, options.limit ?? 20);
}

export async function describeConnectorTool(
  workspaceId: string | undefined,
  tool: string,
): Promise<ConnectorTool | null> {
  return (await listConnectorTools(workspaceId)).find((candidate) => candidate.tool === tool) ?? null;
}

function parseConnectorTool(tool: string): { connector: string; action: string } {
  const separator = tool.indexOf('.');
  const connector = separator < 0 ? '' : tool.slice(0, separator).trim();
  const action = separator < 0 ? '' : tool.slice(separator + 1).trim();
  if (!connector || !action) {
    throw new Error('tool must use the connector.action format');
  }
  return { connector, action };
}

export async function callConnector<T = unknown>(
  workspaceId: string | undefined,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ConnectorCallResult<T>> {
  const { connector, action } = parseConnectorTool(tool);
  return unwrap(
    await backendApi.post<ConnectorCallResult<T>>(
      connectorGatewayPath(workspaceId, 'call'),
      { connector, action, args },
    ),
  );
}

function connectorResponseMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>;
    for (const key of ['reason', 'error', 'message', 'detail']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
  }
  return `HTTP ${status}`;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export async function uploadConnectorAttachment(
  workspaceId: string | undefined,
  content: Uint8Array | ArrayBuffer | Blob,
  input: ConnectorAttachmentUploadInput,
): Promise<ConnectorAttachmentUploadResult> {
  const filename = input.filename.trim();
  const contentType = input.contentType.trim();
  if (!filename) throw new Error('filename is required');
  if (!contentType) throw new Error('contentType is required');

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-Kortix-Attachment-Filename': encodeURIComponent(filename),
    'X-Kortix-Attachment-Disposition': input.contentDisposition ?? 'attachment',
  };
  if (input.contentId?.trim()) {
    headers['X-Kortix-Attachment-Content-Id'] = encodeURIComponent(input.contentId.trim());
  }

  const backendUrl = trimTrailingSlashes(platformConfig().backendUrl);
  const endpoint = connectorGatewayPath(workspaceId, 'attachments');
  const response = await authenticatedFetch(
    `${backendUrl}${endpoint}`,
    { method: 'POST', headers, body: content as BodyInit },
    { timeoutMs: 60_000 },
  );
  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  if (!response.ok) {
    throw new ApiError(connectorResponseMessage(body, response.status), {
      status: response.status,
      code:
        body && typeof body === 'object'
          ? String((body as Record<string, unknown>).code ?? response.status)
          : String(response.status),
      details: body,
      response,
      endpoint,
    });
  }
  return body as ConnectorAttachmentUploadResult;
}

export type ConnectorAuthorizationStrategy = 'workspace' | 'user';

export interface AdminConnector {
  slug: string;
  name: string;
  provider:
    | 'pipedream'
    | 'mcp'
    | 'openapi'
    | 'postman'
    | 'graphql'
    | 'http'
    | 'channel'
    | 'computer';
  platform?: 'slack' | 'email' | null;
  /** Provider icon materialized during connector synchronization. */
  iconUrl?: string | null;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  /** Credential storage model. Always `shared` — `per_user` (each member's
   *  own) was removed 2026-07-05 (docs/specs/2026-07-05-agent-first-config-
   *  unification.md §2.5). A `shared` connector with no credential set
   *  (`secretSet: false`) needs reconnecting. */
  credentialMode: 'shared';
  /** Exclusive owner model for connections under this connector. */
  authorizationStrategy: ConnectorAuthorizationStrategy;
  /** Authentication shape required when a member adds a private credential. */
  requestAuthType?: ConnectorRequestAuthType;
  /** Marked sensitive — its reads gate too (require_approval by default). */
  sensitive: boolean;
  actions: ConnectorAction[];
  authSecret: string | null;
  /** Workspace secret identifier bound as this connector's credential source. */
  secretIdentifier?: string | null;
  /** Where the connector currently obtains its server-side credential. */
  credentialSource?: 'none' | 'stored' | 'workspace_secret' | 'platform';
  secretSet: boolean;
}

export interface ConnectorsResponse {
  connectors: AdminConnector[];
}

export interface ConnectorSyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

export type DiscoveredAuthScheme =
  | 'none'
  | 'bearer'
  | 'basic'
  | 'api_key'
  | 'oauth1'
  | 'oauth2'
  | 'openid_connect'
  | 'mutual_tls'
  | 'digest'
  | 'hawk'
  | 'ntlm'
  | 'aws_v4'
  | 'edgegrid'
  | 'asap'
  | 'unknown';
export type ConnectorRequestAuthType =
  | 'none'
  | 'bearer'
  | 'basic'
  | 'custom'
  | 'api_key'
  | 'oauth1'
  | 'hmac'
  | 'aws_sigv4'
  | 'mtls';
export interface ExecutableConnectorAuth {
  type: ConnectorRequestAuthType;
  in: 'header' | 'query' | 'cookie';
  name: string | null;
  prefix: string | null;
}
export interface ConnectorAuthCandidate {
  id: string;
  source: string;
  scheme: DiscoveredAuthScheme;
  label: string;
  supported: boolean;
  requestCount: number;
  totalRequests: number;
  placement: 'header' | 'query' | 'cookie' | null;
  parameterName: string | null;
  prefix: string | null;
  parameterNames: string[];
  variables: string[];
  oauth?: {
    authorizationUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;
    openIdConnectUrl?: string;
    protectedResourceMetadataUrl?: string;
    scopes: string[];
  };
  executable: ExecutableConnectorAuth | null;
}
export interface ConnectorAuthDiscovery {
  status: 'detected' | 'none' | 'ambiguous' | 'unsupported';
  recommended: ExecutableConnectorAuth | null;
  candidates: ConnectorAuthCandidate[];
  warnings: string[];
  totalRequests: number;
  /** The source document's own name (OpenAPI `info.title`, Postman `info.name`). */
  title: string | null;
}

interface ConnectionFields {
  connector_alias: string;
  owner_type: 'workspace' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  label: string;
  status: 'active' | 'revoked' | 'error';
  is_default: boolean;
  metadata: Record<string, unknown>;
}

export interface Connection extends ConnectionFields {
  connection_id: string;
}

export interface ReconcileConnectionInput {
  connector_alias: string;
  /** `workspace` = a TEAM-shared connection (several per connector, distinguished
   *  by `label`), which takes no `owner_id`. Every other owner type needs one. */
  owner_type: 'workspace' | 'agent' | 'member' | 'subject' | 'external';
  owner_id?: string;
  /** Distinguishes several connections on one connector for the same owner
   *  ("Support", "Sales", "Work"). Reconciling the same label updates in place. */
  label: string;
  metadata?: Record<string, unknown>;
}

/** Create or update the calling user's member-owned connection. Ownership is
 * derived exclusively from the bearer token; callers cannot supply an owner. */
export interface ReconcileMemberConnectionInput {
  connector_alias: string;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectionConnectInput {
  success_redirect_uri?: string;
  error_redirect_uri?: string;
}

export interface OAuth2ClientCredentials {
  type: 'oauth2_client_credentials';
  token_url: string;
  client_id: string;
  token_endpoint_auth_method:
    | 'none'
    | 'client_secret_post'
    | 'client_secret_basic'
    | 'client_secret_jwt'
    | 'private_key_jwt';
  client_secret?: string;
  private_key?: string;
  certificate_thumbprint?: string;
  scopes?: string[];
  resource?: string;
  audience?: string;
}

export type OAuth2TokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'client_secret_jwt'
  | 'private_key_jwt';

export interface OAuth2ApplicationInput {
  discovery_url?: string;
  authorization_url?: string;
  token_url?: string;
  device_authorization_url?: string;
  revocation_url?: string;
  client_id: string;
  token_endpoint_auth_method: OAuth2TokenEndpointAuthMethod;
  client_secret?: string;
  private_key?: string;
  scopes?: string[];
  resource?: string;
  audience?: string;
  authorization_params?: Record<string, string>;
  token_params?: Record<string, string>;
}

export interface OAuth2ApplicationView
  extends Omit<OAuth2ApplicationInput, 'client_secret' | 'private_key'> {
  has_client_secret: boolean;
  has_private_key: boolean;
}

export interface OAuth2AuthorizationStartInput {
  scopes?: string[];
  success_redirect_uri?: string;
  error_redirect_uri?: string;
}

export interface OAuth2AuthorizationStartResult {
  authorization_url: string;
  expires_at: string;
}

export interface OAuth2DeviceAuthorizationStartInput {
  scopes?: string[];
}

export interface OAuth2DeviceAuthorizationStartResult {
  session_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_at: string;
  interval_seconds: number;
}

export interface OAuth2ConnectionStatus {
  status: 'not_configured' | 'ready' | 'pending' | 'active' | 'error' | 'revoked';
  expires_at?: string | null;
  scopes?: string[];
  error_code?: string | null;
}

export type ConnectionCredentialInput =
  | { value: string; kind?: 'secret' | 'connection' }
  | { oauth2: OAuth2ClientCredentials };

export async function listConnections(workspaceId: string) {
  return unwrap(
    await backendApi.get<{ connections: Connection[] }>(`/workspaces/${workspaceId}/connections`),
  );
}

/**
 * One row of the owner/admin roster. Deliberately NARROWER than
 * `Connection`: it carries identity and status only. `label` and `metadata`
 * are excluded because they are a member's own annotations on a PRIVATE
 * connection and can hold personal identifiers a peer manager needn't see.
 */
export interface ConnectionRoster {
  connection_id: string;
  connector_alias: string;
  owner_type: 'workspace' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  status: 'active' | 'revoked' | 'error';
}

/**
 * Owner/admin read-only roster: WHO has connected each connector in the workspace
 * and whether it still works — not just the caller's own connections. Requires
 * the connections manage capability. Never returns credentials, and never
 * a peer's private label or metadata (see `ConnectionRoster`).
 */
export async function listAllConnections(workspaceId: string) {
  return unwrap(
    await backendApi.get<{ connections: ConnectionRoster[] }>(
      `/workspaces/${workspaceId}/connections/all`,
    ),
  );
}

export async function reconcileConnection(
  workspaceId: string,
  input: ReconcileConnectionInput,
) {
  return unwrap(await backendApi.post<Connection>(`/workspaces/${workspaceId}/connections`, input));
}

export async function reconcileMemberConnection(
  workspaceId: string,
  input: ReconcileMemberConnectionInput,
) {
  return unwrap(
    await backendApi.post<Connection>(`/workspaces/${workspaceId}/connections/me`, input),
  );
}

export async function updateConnectionCredential(
  workspaceId: string,
  connectionId: string,
  input: ConnectionCredentialInput,
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/workspaces/${workspaceId}/connections/${connectionId}/credential`,
      input,
    ),
  );
}

function connectionOAuth2Path(
  workspaceId: string,
  connectionId: string,
  suffix: string,
): string {
  return `/workspaces/${workspaceId}/connections/${connectionId}/oauth2/${suffix}`;
}

export async function ensureWorkspaceConnectorConnection(workspaceId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ connection_id: string }>(
      `/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/oauth2/connection`,
      {},
    ),
  );
}

/** @deprecated Use `ensureWorkspaceConnectorConnection`. */
export const ensureWorkspaceConnectorProfile = ensureWorkspaceConnectorConnection;

export async function putConnectionOAuth2Application(
  workspaceId: string,
  connectionId: string,
  input: OAuth2ApplicationInput,
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      connectionOAuth2Path(workspaceId, connectionId, 'application'),
      input,
    ),
  );
}

export async function getConnectionOAuth2Application(
  workspaceId: string,
  connectionId: string,
) {
  return unwrap(
    await backendApi.get<{ application: OAuth2ApplicationView }>(
      connectionOAuth2Path(workspaceId, connectionId, 'application'),
    ),
  );
}

export async function discoverConnectionOAuth2(
  workspaceId: string,
  connectionId: string,
  input: { discovery_url: string },
) {
  return unwrap(
    await backendApi.post<{ metadata: Partial<OAuth2ApplicationView> }>(
      connectionOAuth2Path(workspaceId, connectionId, 'discover'),
      input,
    ),
  );
}

export async function startConnectionOAuth2Authorization(
  workspaceId: string,
  connectionId: string,
  input: OAuth2AuthorizationStartInput,
) {
  return unwrap(
    await backendApi.post<OAuth2AuthorizationStartResult>(
      connectionOAuth2Path(workspaceId, connectionId, 'authorize'),
      input,
    ),
  );
}

export async function startConnectionOAuth2DeviceAuthorization(
  workspaceId: string,
  connectionId: string,
  input: OAuth2DeviceAuthorizationStartInput,
) {
  return unwrap(
    await backendApi.post<OAuth2DeviceAuthorizationStartResult>(
      connectionOAuth2Path(workspaceId, connectionId, 'device'),
      input,
    ),
  );
}

export async function pollConnectionOAuth2DeviceAuthorization(
  workspaceId: string,
  connectionId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.post<OAuth2ConnectionStatus>(
      connectionOAuth2Path(
        workspaceId,
        connectionId,
        `device/${encodeURIComponent(sessionId)}`,
      ),
      {},
    ),
  );
}

export async function getConnectionOAuth2Status(
  workspaceId: string,
  connectionId: string,
) {
  return unwrap(
    await backendApi.get<OAuth2ConnectionStatus>(
      connectionOAuth2Path(workspaceId, connectionId, 'status'),
    ),
  );
}

export async function revokeConnection(workspaceId: string, connectionId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/workspaces/${workspaceId}/connections/${connectionId}/revoke`,
      {},
    ),
  );
}

export async function activateConnection(workspaceId: string, connectionId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/workspaces/${workspaceId}/connections/${connectionId}/activate`,
      {},
    ),
  );
}

/**
 * Make this the DEFAULT connection for its owner scope — the one a session uses
 * when it doesn't name a connection explicitly. Defaults are per-owner: one for
 * the workspace (team-shared) and one per member, so this only displaces the
 * previous default within the same scope.
 */
export async function setDefaultConnection(workspaceId: string, connectionId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/workspaces/${workspaceId}/connections/${connectionId}/default`,
      {},
    ),
  );
}

export async function pipedreamConnectConnection(
  workspaceId: string,
  connectionId: string,
  input: ConnectionConnectInput = {},
) {
  return unwrap(
    await backendApi.post<{
      token?: string;
      app?: string;
      connectUrl?: string;
    }>(`/workspaces/${workspaceId}/connections/${connectionId}/connect`, input),
  );
}

export async function pipedreamFinalizeConnection(
  workspaceId: string,
  connectionId: string,
) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/workspaces/${workspaceId}/connections/${connectionId}/connect/finalize`,
      {},
    ),
  );
}

export async function listConnectors(workspaceId: string) {
  return unwrap(
    // Background read fired at workspace mount (workspace-home tiles, sidebar
    // setup checklist) — never global-toast; callers render their own state.
    await backendApi.get<ConnectorsResponse>(`/connectors/workspaces/${workspaceId}/connectors`, {
      showErrors: false,
    }),
  );
}

export async function syncConnectors(workspaceId: string) {
  return unwrap(
    await backendApi.post<ConnectorSyncResult>(
      `/connectors/workspaces/${workspaceId}/connectors/sync`,
      {},
    ),
  );
}

/** `shared` is the only credential mode (`per_user` removed 2026-07-05) — kept
 *  for back-compat callers, restricted to a no-op on the API side. */
export async function setConnectorCredentialMode(workspaceId: string, slug: string, mode: 'shared') {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/credential-mode`,
      { mode },
    ),
  );
}

export async function setConnectorAuthorizationStrategy(
  workspaceId: string,
  slug: string,
  authorizationStrategy: ConnectorAuthorizationStrategy,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/authorization-strategy`,
      { authorization_strategy: authorizationStrategy },
    ),
  );
}

/** Toggle a connector's `sensitive` flag — sensitive connectors gate reads too
 *  (every action defaults to require_approval unless a policy opens it). */
export async function setConnectorSensitive(workspaceId: string, slug: string, sensitive: boolean) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/sensitive`,
      { sensitive },
    ),
  );
}

export type ConnectorPolicyAction = 'always_run' | 'require_approval' | 'block';
export interface ConnectorPolicyRule {
  match: string;
  action: ConnectorPolicyAction;
}

/** Which policy scope decided an action. Workspace rules win and cannot be overridden here. */
export type ConnectorPolicySource = 'workspace' | 'connector' | 'risk_default' | 'allow_all';

export interface ConnectorEffectivePolicy {
  /** Connector-relative tool path, e.g. `send_email`. */
  path: string;
  action: ConnectorPolicyAction;
  source: ConnectorPolicySource;
}

export async function getConnectorPolicies(workspaceId: string, slug: string) {
  return unwrap(
    await backendApi.get<{
      policies: ConnectorPolicyRule[];
      /**
       * Resolved per tool through the same function the call gate uses. Present
       * so an editor can show WHICH scope decided — without it a connector rule
       * that a workspace-scope rule silently overrules still renders as if it applied.
       * Older servers omit this; treat as empty.
       */
      effective?: ConnectorEffectivePolicy[];
      /** Workspace-scope rules, which are evaluated first and win. */
      workspace_policies?: ConnectorPolicyRule[];
      default_mode?: 'risk' | 'allow_all';
    }>(`/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/policies`),
  );
}

export async function setConnectorPolicies(
  workspaceId: string,
  slug: string,
  policies: ConnectorPolicyRule[],
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/policies`,
      { policies },
    ),
  );
}

/**
 * @deprecated Policies apply to a connector, not one connection.
 * Use `getConnectorPolicies(workspaceId, slug)`.
 */
export async function getConnectionPolicies(
  _workspaceId: string,
  _connectionId: string,
): Promise<{ policies: ConnectorPolicyRule[] }> {
  throw new Error(
    'Connection-specific policies were removed. Use getConnectorPolicies(workspaceId, slug).',
  );
}

/**
 * @deprecated Policies apply to a connector, not one connection.
 * Use `setConnectorPolicies(workspaceId, slug, policies)`.
 */
export async function setConnectionPolicies(
  _workspaceId: string,
  _connectionId: string,
  _policies: ConnectorPolicyRule[],
): Promise<{ ok: boolean }> {
  throw new Error(
    'Connection-specific policies were removed. Use setConnectorPolicies(workspaceId, slug, policies).',
  );
}

/** The editable connection config for an existing connector (kortix.yaml = source of truth). */
export interface ConnectorConfig {
  slug: string;
  name: string;
  provider: AdminConnector['provider'];
  platform: 'slack' | 'email' | null;
  credentialMode: 'shared';
  authorizationStrategy: ConnectorAuthorizationStrategy;
  app: string | null;
  account: string | null;
  url: string | null;
  transport: 'http' | 'sse' | null;
  endpoint: string | null;
  baseUrl: string | null;
  spec: string | null;
  /** Machine ids assigned to a Computers connector profile. */
  tunnelIds?: string[];
  auth: {
    type: ConnectorRequestAuthType;
    in: 'header' | 'query' | 'cookie';
    name: string | null;
    prefix: string | null;
  };
  /** Static request headers sent on EVERY call this connector makes — an
   *  ordered map of header name → value (`{ Accept: 'application/json' }`);
   *  `{}` when none are declared. NOT secrets: stored in kortix.yaml in
   *  plaintext, like `baseUrl`. The credential (see `auth`) always wins if a
   *  header here has the same name. */
  headers: Record<string, string>;
}

export async function getConnectorConfig(workspaceId: string, slug: string) {
  return unwrap(
    await backendApi.get<ConnectorConfig>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/config`,
    ),
  );
}

export async function setConnectorName(workspaceId: string, slug: string, name: string) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/name`,
      { name },
    ),
  );
}

export async function pipedreamConnect(workspaceId: string, slug: string) {
  return unwrap(
    await backendApi.post<{
      token?: string;
      app?: string;
      connectUrl?: string;
    }>(`/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/connect`, {}),
  );
}

export interface ConnectorDraftInput {
  slug: string;
  name?: string;
  provider: AdminConnector['provider'];
  /** Refuse to update an existing slug. The API returns HTTP 409 on conflict. */
  create_only?: boolean;
  platform?: 'slack' | 'email';
  app?: string;
  account?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  baseUrl?: string;
  spec?: string;
  /** Account-owned machine ids assigned to a Computers connector profile. */
  tunnel_ids?: string[];
  /** Credential storage mode. `shared` is the only mode (`per_user` was
   *  removed 2026-07-05). */
  credential?: 'shared';
  authorization_strategy?: ConnectorAuthorizationStrategy;
  auth?: {
    type?: ConnectorRequestAuthType;
    in?: 'header' | 'query' | 'cookie';
    name?: string;
    prefix?: string;
  };
  /** Static request headers, an ordered map of header name → value. Omit to
   *  keep whatever the connector already declares; send `{}` to clear them.
   *  Names must be RFC 7230 tokens (`^[A-Za-z0-9!#$%&'*+.^_\`|~-]+$`, max 128
   *  chars), values may not contain CR/LF (max 2048 chars), at most 32 entries.
   *  NOT secrets — they are committed to kortix.yaml in plaintext. */
  headers?: Record<string, string>;
}

export async function createConnector(workspaceId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<{
      ok: boolean;
      sync?: ConnectorSyncResult;
      authDiscovery?: ConnectorAuthDiscovery;
    }>(`/connectors/workspaces/${workspaceId}/connectors`, draft),
  );
}

export async function discoverConnectorAuth(workspaceId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<ConnectorAuthDiscovery>(
      `/connectors/workspaces/${workspaceId}/connectors/auth-discovery`,
      draft,
    ),
  );
}

export async function deleteConnector(workspaceId: string, slug: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}`,
    ),
  );
}

export interface PipedreamApp {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  /** Pipedream is surfaced only as an explicit managed-OAuth alternative. */
  authType: 'oauth';
  categories: string[];
}

export async function listPipedreamApps(workspaceId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<{
      apps: PipedreamApp[];
      /** The catalogue's size for this query, across every page. Optional
       *  because API builds before it was forwarded omit it — callers fall
       *  back to what they have loaded rather than quoting a total they cannot
       *  back up. */
      total?: number;
      nextCursor?: string;
      hasMore: boolean;
    }>(`/connectors/workspaces/${workspaceId}/pipedream/apps${qs ? `?${qs}` : ''}`),
  );
}

export type DiscoverConnectorKind = 'openapi' | 'mcp' | 'graphql' | 'cli';

export interface DiscoverConnector {
  id: string;
  kind: DiscoverConnectorKind;
  slug: string;
  name: string;
  description: string | null;
  url: string | null;
  icon: string | null;
  domain: string;
  categories: string[];
  feeds: string[];
  popularity: number | null;
}

export interface DiscoverConnectorTemplate {
  provider: 'openapi' | 'postman' | 'mcp' | 'graphql';
  spec?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  auth?: {
    type: 'none' | 'bearer' | 'basic' | 'custom';
    in: 'header' | 'query';
    name: string | null;
    prefix: string | null;
  };
}

export interface DiscoverConnectorVariant {
  id: string;
  kind: 'openapi' | 'postman' | 'mcp' | 'graphql' | 'http' | 'cli';
  name: string;
  url: string | null;
  docs: string | null;
  description: string | null;
  transports: string[];
  requiresAuth: boolean;
  command: string | null;
  connector: DiscoverConnectorTemplate | null;
}

export interface DiscoverConnectorsPage {
  items: DiscoverConnector[];
  total: number;
  nextCursor?: string;
  hasMore: boolean;
}

export interface DiscoverConnectorDetail {
  item: DiscoverConnector;
  variants: DiscoverConnectorVariant[];
}

/** @deprecated Use `DiscoverConnectorKind`. */
export type DiscoverIntegrationKind = DiscoverConnectorKind;
/** @deprecated Use `DiscoverConnector`. */
export type DiscoverIntegration = DiscoverConnector;
/** @deprecated Use `DiscoverConnectorTemplate`. */
export type DiscoverIntegrationTemplate = DiscoverConnectorTemplate;
/** @deprecated Use `DiscoverConnectorVariant`. */
export type DiscoverIntegrationVariant = DiscoverConnectorVariant;
/** @deprecated Use `DiscoverConnectorsPage`. */
export type DiscoverIntegrationsPage = DiscoverConnectorsPage;
/** @deprecated Use `DiscoverConnectorDetail`. */
export type DiscoverIntegrationDetail = DiscoverConnectorDetail;

export async function listDiscoverConnectors(workspaceId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<DiscoverConnectorsPage>(
      `/connectors/workspaces/${workspaceId}/discover/connectors${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function getDiscoverConnector(workspaceId: string, id: string) {
  const params = new URLSearchParams({ id });
  return unwrap(
    await backendApi.get<DiscoverConnectorDetail>(
      `/connectors/workspaces/${workspaceId}/discover/connectors/detail?${params.toString()}`,
    ),
  );
}

/** @deprecated Use `listDiscoverConnectors`. */
export const listDiscoverIntegrations = listDiscoverConnectors;
/** @deprecated Use `getDiscoverConnector`. */
export const getDiscoverIntegration = getDiscoverConnector;

/**
 * Deployment-wide flag: is the easy-connect (Pipedream) provider configured?
 * Lets the UI hide/disable the Easy Connect surface instead of surfacing it and
 * failing with a 501 once opened (e.g. self-host without Pipedream credentials).
 */
export async function getConnectStatus() {
  return unwrap(
    await backendApi.get<{ configured: boolean; provider: string | null }>(
      '/connectors/connect-status',
    ),
  );
}

export async function setConnectorCredential(
  workspaceId: string,
  slug: string,
  credential: string | ConnectionCredentialInput,
) {
  const input = typeof credential === 'string' ? { value: credential } : credential;
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/credential`,
      input,
    ),
  );
}

export async function setConnectorSecretBinding(
  workspaceId: string,
  slug: string,
  secretIdentifier: string | null,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/secret-binding`,
      { secret_identifier: secretIdentifier },
    ),
  );
}

export async function pipedreamFinalize(workspaceId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}/connect/finalize`,
      {},
    ),
  );
}
