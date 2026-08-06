// Connectors — connector CRUD, credentials, Pipedream. Connectors are
// project-wide visible; the only access gate is the agent's `connectors`
// grant (kortix.yaml [[agents]].connectors), not anything configured here.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ─── Connectors ────────────────────────────────────────────────────────────

export interface ConnectorAction {
  path: string;
  name: string;
  description: string;
  risk: 'read' | 'write' | 'destructive';
  inputSchema: Record<string, unknown> | null;
}

export type ConnectorAuthorizationStrategy = 'project' | 'user';

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
  /** Project secret identifier bound as this connector's credential source. */
  secretIdentifier?: string | null;
  /** Where the connector currently obtains its server-side credential. */
  credentialSource?: 'none' | 'stored' | 'project_secret' | 'platform';
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
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
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
  /** `project` = a TEAM-shared connection (several per connector, distinguished
   *  by `label`), which takes no `owner_id`. Every other owner type needs one. */
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
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

export async function listConnections(projectId: string) {
  return unwrap(
    await backendApi.get<{ connections: Connection[] }>(`/projects/${projectId}/connections`),
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
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  status: 'active' | 'revoked' | 'error';
}

/**
 * Owner/admin read-only roster: WHO has connected each connector in the project
 * and whether it still works — not just the caller's own connections. Requires
 * the connections manage capability. Never returns credentials, and never
 * a peer's private label or metadata (see `ConnectionRoster`).
 */
export async function listAllConnections(projectId: string) {
  return unwrap(
    await backendApi.get<{ connections: ConnectionRoster[] }>(
      `/projects/${projectId}/connections/all`,
    ),
  );
}

export async function reconcileConnection(
  projectId: string,
  input: ReconcileConnectionInput,
) {
  return unwrap(await backendApi.post<Connection>(`/projects/${projectId}/connections`, input));
}

export async function reconcileMemberConnection(
  projectId: string,
  input: ReconcileMemberConnectionInput,
) {
  return unwrap(
    await backendApi.post<Connection>(`/projects/${projectId}/connections/me`, input),
  );
}

export async function updateConnectionCredential(
  projectId: string,
  connectionId: string,
  input: ConnectionCredentialInput,
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connections/${connectionId}/credential`,
      input,
    ),
  );
}

function connectionOAuth2Path(
  projectId: string,
  connectionId: string,
  suffix: string,
): string {
  return `/projects/${projectId}/connections/${connectionId}/oauth2/${suffix}`;
}

export async function ensureProjectConnectorConnection(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ connection_id: string }>(
      `/projects/${projectId}/connectors/${encodeURIComponent(slug)}/oauth2/connection`,
      {},
    ),
  );
}

export async function putConnectionOAuth2Application(
  projectId: string,
  connectionId: string,
  input: OAuth2ApplicationInput,
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      connectionOAuth2Path(projectId, connectionId, 'application'),
      input,
    ),
  );
}

export async function getConnectionOAuth2Application(
  projectId: string,
  connectionId: string,
) {
  return unwrap(
    await backendApi.get<{ application: OAuth2ApplicationView }>(
      connectionOAuth2Path(projectId, connectionId, 'application'),
    ),
  );
}

export async function discoverConnectionOAuth2(
  projectId: string,
  connectionId: string,
  input: { discovery_url: string },
) {
  return unwrap(
    await backendApi.post<{ metadata: Partial<OAuth2ApplicationView> }>(
      connectionOAuth2Path(projectId, connectionId, 'discover'),
      input,
    ),
  );
}

export async function startConnectionOAuth2Authorization(
  projectId: string,
  connectionId: string,
  input: OAuth2AuthorizationStartInput,
) {
  return unwrap(
    await backendApi.post<OAuth2AuthorizationStartResult>(
      connectionOAuth2Path(projectId, connectionId, 'authorize'),
      input,
    ),
  );
}

export async function startConnectionOAuth2DeviceAuthorization(
  projectId: string,
  connectionId: string,
  input: OAuth2DeviceAuthorizationStartInput,
) {
  return unwrap(
    await backendApi.post<OAuth2DeviceAuthorizationStartResult>(
      connectionOAuth2Path(projectId, connectionId, 'device'),
      input,
    ),
  );
}

export async function pollConnectionOAuth2DeviceAuthorization(
  projectId: string,
  connectionId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.post<OAuth2ConnectionStatus>(
      connectionOAuth2Path(
        projectId,
        connectionId,
        `device/${encodeURIComponent(sessionId)}`,
      ),
      {},
    ),
  );
}

export async function getConnectionOAuth2Status(
  projectId: string,
  connectionId: string,
) {
  return unwrap(
    await backendApi.get<OAuth2ConnectionStatus>(
      connectionOAuth2Path(projectId, connectionId, 'status'),
    ),
  );
}

export async function revokeConnection(projectId: string, connectionId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connections/${connectionId}/revoke`,
      {},
    ),
  );
}

export async function activateConnection(projectId: string, connectionId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connections/${connectionId}/activate`,
      {},
    ),
  );
}

/**
 * Make this the DEFAULT connection for its owner scope — the one a session uses
 * when it doesn't name a connection explicitly. Defaults are per-owner: one for
 * the project (team-shared) and one per member, so this only displaces the
 * previous default within the same scope.
 */
export async function setDefaultConnection(projectId: string, connectionId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connections/${connectionId}/default`,
      {},
    ),
  );
}

export async function pipedreamConnectConnection(
  projectId: string,
  connectionId: string,
  input: ConnectionConnectInput = {},
) {
  return unwrap(
    await backendApi.post<{
      token?: string;
      app?: string;
      connectUrl?: string;
    }>(`/projects/${projectId}/connections/${connectionId}/connect`, input),
  );
}

export async function pipedreamFinalizeConnection(
  projectId: string,
  connectionId: string,
) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/projects/${projectId}/connections/${connectionId}/connect/finalize`,
      {},
    ),
  );
}

export async function listConnectors(projectId: string) {
  return unwrap(
    // Background read fired at workspace mount (project-home tiles, sidebar
    // setup checklist) — never global-toast; callers render their own state.
    await backendApi.get<ConnectorsResponse>(`/connectors/projects/${projectId}/connectors`, {
      showErrors: false,
    }),
  );
}

export async function syncConnectors(projectId: string) {
  return unwrap(
    await backendApi.post<ConnectorSyncResult>(
      `/connectors/projects/${projectId}/connectors/sync`,
      {},
    ),
  );
}

/** `shared` is the only credential mode (`per_user` removed 2026-07-05) — kept
 *  for back-compat callers, restricted to a no-op on the API side. */
export async function setConnectorCredentialMode(projectId: string, slug: string, mode: 'shared') {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/credential-mode`,
      { mode },
    ),
  );
}

export async function setConnectorAuthorizationStrategy(
  projectId: string,
  slug: string,
  authorizationStrategy: ConnectorAuthorizationStrategy,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/authorization-strategy`,
      { authorization_strategy: authorizationStrategy },
    ),
  );
}

/** Toggle a connector's `sensitive` flag — sensitive connectors gate reads too
 *  (every action defaults to require_approval unless a policy opens it). */
export async function setConnectorSensitive(projectId: string, slug: string, sensitive: boolean) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/sensitive`,
      { sensitive },
    ),
  );
}

export type ConnectorPolicyAction = 'always_run' | 'require_approval' | 'block';
export interface ConnectorPolicyRule {
  match: string;
  action: ConnectorPolicyAction;
}

/** Which policy scope decided an action. Project rules win and cannot be overridden here. */
export type ConnectorPolicySource = 'project' | 'connector' | 'risk_default' | 'allow_all';

export interface ConnectorEffectivePolicy {
  /** Connector-relative tool path, e.g. `send_email`. */
  path: string;
  action: ConnectorPolicyAction;
  source: ConnectorPolicySource;
}

export async function getConnectorPolicies(projectId: string, slug: string) {
  return unwrap(
    await backendApi.get<{
      policies: ConnectorPolicyRule[];
      /**
       * Resolved per tool through the same function the call gate uses. Present
       * so an editor can show WHICH scope decided — without it a connector rule
       * that a project-scope rule silently overrules still renders as if it applied.
       * Older servers omit this; treat as empty.
       */
      effective?: ConnectorEffectivePolicy[];
      /** Project-scope rules, which are evaluated first and win. */
      project_policies?: ConnectorPolicyRule[];
      default_mode?: 'risk' | 'allow_all';
    }>(`/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/policies`),
  );
}

export async function setConnectorPolicies(
  projectId: string,
  slug: string,
  policies: ConnectorPolicyRule[],
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/policies`,
      { policies },
    ),
  );
}

/**
 * @deprecated Policies apply to a connector, not one connection.
 * Use `getConnectorPolicies(projectId, slug)`.
 */
export async function getConnectionPolicies(
  _projectId: string,
  _connectionId: string,
): Promise<{ policies: ConnectorPolicyRule[] }> {
  throw new Error(
    'Connection-specific policies were removed. Use getConnectorPolicies(projectId, slug).',
  );
}

/**
 * @deprecated Policies apply to a connector, not one connection.
 * Use `setConnectorPolicies(projectId, slug, policies)`.
 */
export async function setConnectionPolicies(
  _projectId: string,
  _connectionId: string,
  _policies: ConnectorPolicyRule[],
): Promise<{ ok: boolean }> {
  throw new Error(
    'Connection-specific policies were removed. Use setConnectorPolicies(projectId, slug, policies).',
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

export async function getConnectorConfig(projectId: string, slug: string) {
  return unwrap(
    await backendApi.get<ConnectorConfig>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/config`,
    ),
  );
}

export async function setConnectorName(projectId: string, slug: string, name: string) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/name`,
      { name },
    ),
  );
}

export async function pipedreamConnect(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{
      token?: string;
      app?: string;
      connectUrl?: string;
    }>(`/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect`, {}),
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

export async function createConnector(projectId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<{
      ok: boolean;
      sync?: ConnectorSyncResult;
      authDiscovery?: ConnectorAuthDiscovery;
    }>(`/connectors/projects/${projectId}/connectors`, draft),
  );
}

export async function discoverConnectorAuth(projectId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<ConnectorAuthDiscovery>(
      `/connectors/projects/${projectId}/connectors/auth-discovery`,
      draft,
    ),
  );
}

export async function deleteConnector(projectId: string, slug: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}`,
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

export async function listPipedreamApps(projectId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<{
      apps: PipedreamApp[];
      nextCursor?: string;
      hasMore: boolean;
    }>(`/connectors/projects/${projectId}/pipedream/apps${qs ? `?${qs}` : ''}`),
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

export async function listDiscoverConnectors(projectId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<DiscoverConnectorsPage>(
      `/connectors/projects/${projectId}/discover/connectors${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function getDiscoverConnector(projectId: string, id: string) {
  const params = new URLSearchParams({ id });
  return unwrap(
    await backendApi.get<DiscoverConnectorDetail>(
      `/connectors/projects/${projectId}/discover/connectors/detail?${params.toString()}`,
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
  projectId: string,
  slug: string,
  credential: string | ConnectionCredentialInput,
) {
  const input = typeof credential === 'string' ? { value: credential } : credential;
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/credential`,
      input,
    ),
  );
}

export async function setConnectorSecretBinding(
  projectId: string,
  slug: string,
  secretIdentifier: string | null,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/secret-binding`,
      { secret_identifier: secretIdentifier },
    ),
  );
}

export async function pipedreamFinalize(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect/finalize`,
      {},
    ),
  );
}
