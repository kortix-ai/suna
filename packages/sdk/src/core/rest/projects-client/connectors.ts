// Executor connectors — connector CRUD, credentials, Pipedream. Connectors are
// project-wide visible; the only access gate is the agent's `connectors`
// grant (kortix.yaml [[agents]].connectors), not anything configured here.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ─── Executor connectors ──────────────────────────────────────────────────

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
  /** Exclusive owner model for authorizations under this connector profile. */
  authorizationStrategy: ConnectorAuthorizationStrategy;
  /** Authentication shape required when a member adds a private credential. */
  requestAuthType?: ConnectorRequestAuthType;
  /** Marked sensitive — its reads gate too (require_approval by default). */
  sensitive: boolean;
  actions: ConnectorAction[];
  authSecret: string | null;
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

export interface ConnectorAuthorization {
  profile_id: string;
  connector_alias: string;
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  label: string;
  status: 'active' | 'revoked' | 'error';
  is_default: boolean;
  metadata: Record<string, unknown>;
}

/** @deprecated Use `ConnectorAuthorization`. */
export type ConnectionProfile = ConnectorAuthorization;

export interface ReconcileConnectorAuthorizationInput {
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

/** @deprecated Use `ReconcileConnectorAuthorizationInput`. */
export type ReconcileConnectionProfileInput = ReconcileConnectorAuthorizationInput;

/** Create or update the calling user's member-owned authorization. Ownership is
 * derived exclusively from the bearer token; callers cannot supply an owner. */
export interface ReconcileMemberConnectorAuthorizationInput {
  connector_alias: string;
  label: string;
  metadata?: Record<string, unknown>;
}

/** @deprecated Use `ReconcileMemberConnectorAuthorizationInput`. */
export type ReconcileMemberConnectionProfileInput = ReconcileMemberConnectorAuthorizationInput;

export interface ConnectorAuthorizationConnectInput {
  success_redirect_uri?: string;
  error_redirect_uri?: string;
}

/** @deprecated Use `ConnectorAuthorizationConnectInput`. */
export type ConnectionProfileConnectInput = ConnectorAuthorizationConnectInput;

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

export type ConnectorAuthorizationCredentialInput =
  | { value: string; kind?: 'secret' | 'connection' }
  | { oauth2: OAuth2ClientCredentials };

/** @deprecated Use `ConnectorAuthorizationCredentialInput`. */
export type ConnectionProfileCredentialInput = ConnectorAuthorizationCredentialInput;

export async function listConnectorAuthorizations(projectId: string) {
  return unwrap(
    await backendApi.get<{ profiles: ConnectorAuthorization[] }>(
      `/projects/${projectId}/connector-profiles`,
    ),
  );
}

/** @deprecated Use `listConnectorAuthorizations`. */
export const listConnectionProfiles = listConnectorAuthorizations;

/**
 * One row of the owner/admin roster. Deliberately NARROWER than
 * `ConnectorAuthorization`: it carries identity + status only. `label` and `metadata`
 * are excluded because they are a member's own annotations on a PRIVATE
 * connection and can hold personal identifiers a peer manager needn't see.
 */
export interface ConnectorAuthorizationRosterEntry {
  profile_id: string;
  connector_alias: string;
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  status: 'active' | 'revoked' | 'error';
}

/** @deprecated Use `ConnectorAuthorizationRosterEntry`. */
export type ConnectionRosterEntry = ConnectorAuthorizationRosterEntry;

/**
 * Owner/admin read-only roster: WHO has connected each connector in the project
 * and whether it still works — not just the caller's own connections. Requires
 * the connector-profiles manage capability. Never returns credentials, and never
 * a peer's private label/metadata (see ConnectorAuthorizationRosterEntry).
 */
export async function listAllConnectorAuthorizations(projectId: string) {
  return unwrap(
    await backendApi.get<{ profiles: ConnectorAuthorizationRosterEntry[] }>(
      `/projects/${projectId}/connector-profiles/all`,
    ),
  );
}

/** @deprecated Use `listAllConnectorAuthorizations`. */
export const listAllConnectionProfiles = listAllConnectorAuthorizations;

export async function reconcileConnectorAuthorization(
  projectId: string,
  input: ReconcileConnectorAuthorizationInput,
) {
  return unwrap(
    await backendApi.post<ConnectorAuthorization>(
      `/projects/${projectId}/connector-profiles`,
      input,
    ),
  );
}

/** @deprecated Use `reconcileConnectorAuthorization`. */
export const reconcileConnectionProfile = reconcileConnectorAuthorization;

export async function reconcileMemberConnectorAuthorization(
  projectId: string,
  input: ReconcileMemberConnectorAuthorizationInput,
) {
  return unwrap(
    await backendApi.post<ConnectorAuthorization>(
      `/projects/${projectId}/connector-profiles/me`,
      input,
    ),
  );
}

/** @deprecated Use `reconcileMemberConnectorAuthorization`. */
export const reconcileMemberConnectionProfile = reconcileMemberConnectorAuthorization;

export async function updateConnectorAuthorizationCredential(
  projectId: string,
  profileId: string,
  input: ConnectorAuthorizationCredentialInput,
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${profileId}/credential`,
      input,
    ),
  );
}

/** @deprecated Use `updateConnectorAuthorizationCredential`. */
export const updateConnectionProfileCredential = updateConnectorAuthorizationCredential;

function authorizationOAuth2Path(
  projectId: string,
  authorizationId: string,
  suffix: string,
): string {
  return `/projects/${projectId}/connector-profiles/${authorizationId}/oauth2/${suffix}`;
}

export async function ensureProjectConnectorAuthorization(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ profile_id: string }>(
      `/projects/${projectId}/connectors/${encodeURIComponent(slug)}/oauth2/profile`,
      {},
    ),
  );
}

/** @deprecated Use `ensureProjectConnectorAuthorization`. */
export const ensureProjectConnectorProfile = ensureProjectConnectorAuthorization;

export async function putConnectorAuthorizationOAuth2Application(
  projectId: string,
  authorizationId: string,
  input: OAuth2ApplicationInput,
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      authorizationOAuth2Path(projectId, authorizationId, 'application'),
      input,
    ),
  );
}

/** @deprecated Use `putConnectorAuthorizationOAuth2Application`. */
export const putConnectionProfileOAuth2Application = putConnectorAuthorizationOAuth2Application;

export async function getConnectorAuthorizationOAuth2Application(
  projectId: string,
  authorizationId: string,
) {
  return unwrap(
    await backendApi.get<{ application: OAuth2ApplicationView }>(
      authorizationOAuth2Path(projectId, authorizationId, 'application'),
    ),
  );
}

/** @deprecated Use `getConnectorAuthorizationOAuth2Application`. */
export const getConnectionProfileOAuth2Application = getConnectorAuthorizationOAuth2Application;

export async function discoverConnectorAuthorizationOAuth2(
  projectId: string,
  authorizationId: string,
  input: { discovery_url: string },
) {
  return unwrap(
    await backendApi.post<{ metadata: Partial<OAuth2ApplicationView> }>(
      authorizationOAuth2Path(projectId, authorizationId, 'discover'),
      input,
    ),
  );
}

/** @deprecated Use `discoverConnectorAuthorizationOAuth2`. */
export const discoverConnectionProfileOAuth2 = discoverConnectorAuthorizationOAuth2;

export async function startConnectorAuthorizationOAuth2Authorization(
  projectId: string,
  authorizationId: string,
  input: OAuth2AuthorizationStartInput,
) {
  return unwrap(
    await backendApi.post<OAuth2AuthorizationStartResult>(
      authorizationOAuth2Path(projectId, authorizationId, 'authorize'),
      input,
    ),
  );
}

/** @deprecated Use `startConnectorAuthorizationOAuth2Authorization`. */
export const startConnectionProfileOAuth2Authorization =
  startConnectorAuthorizationOAuth2Authorization;

export async function startConnectorAuthorizationOAuth2DeviceAuthorization(
  projectId: string,
  authorizationId: string,
  input: OAuth2DeviceAuthorizationStartInput,
) {
  return unwrap(
    await backendApi.post<OAuth2DeviceAuthorizationStartResult>(
      authorizationOAuth2Path(projectId, authorizationId, 'device'),
      input,
    ),
  );
}

/** @deprecated Use `startConnectorAuthorizationOAuth2DeviceAuthorization`. */
export const startConnectionProfileOAuth2DeviceAuthorization =
  startConnectorAuthorizationOAuth2DeviceAuthorization;

export async function pollConnectorAuthorizationOAuth2DeviceAuthorization(
  projectId: string,
  authorizationId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.post<OAuth2ConnectionStatus>(
      authorizationOAuth2Path(
        projectId,
        authorizationId,
        `device/${encodeURIComponent(sessionId)}`,
      ),
      {},
    ),
  );
}

/** @deprecated Use `pollConnectorAuthorizationOAuth2DeviceAuthorization`. */
export const pollConnectionProfileOAuth2DeviceAuthorization =
  pollConnectorAuthorizationOAuth2DeviceAuthorization;

export async function getConnectorAuthorizationOAuth2Status(
  projectId: string,
  authorizationId: string,
) {
  return unwrap(
    await backendApi.get<OAuth2ConnectionStatus>(
      authorizationOAuth2Path(projectId, authorizationId, 'status'),
    ),
  );
}

/** @deprecated Use `getConnectorAuthorizationOAuth2Status`. */
export const getConnectionProfileOAuth2Status = getConnectorAuthorizationOAuth2Status;

export async function revokeConnectorAuthorization(projectId: string, authorizationId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${authorizationId}/revoke`,
      {},
    ),
  );
}

/** @deprecated Use `revokeConnectorAuthorization`. */
export const revokeConnectionProfile = revokeConnectorAuthorization;

export async function activateConnectorAuthorization(projectId: string, authorizationId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${authorizationId}/activate`,
      {},
    ),
  );
}

/** @deprecated Use `activateConnectorAuthorization`. */
export const activateConnectionProfile = activateConnectorAuthorization;

/**
 * Make this the DEFAULT connection for its owner scope — the one a session uses
 * when it doesn't name a connection explicitly. Defaults are per-owner: one for
 * the project (team-shared) and one per member, so this only displaces the
 * previous default within the same scope.
 */
export async function setDefaultConnectorAuthorization(projectId: string, authorizationId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${authorizationId}/default`,
      {},
    ),
  );
}

/** @deprecated Use `setDefaultConnectorAuthorization`. */
export const setDefaultConnectionProfile = setDefaultConnectorAuthorization;

export async function pipedreamConnectConnectorAuthorization(
  projectId: string,
  authorizationId: string,
  input: ConnectorAuthorizationConnectInput = {},
) {
  return unwrap(
    await backendApi.post<{
      token?: string;
      app?: string;
      connectUrl?: string;
    }>(`/projects/${projectId}/connector-profiles/${authorizationId}/connect`, input),
  );
}

/** @deprecated Use `pipedreamConnectConnectorAuthorization`. */
export const pipedreamConnectConnectionProfile = pipedreamConnectConnectorAuthorization;

export async function pipedreamFinalizeConnectorAuthorization(
  projectId: string,
  authorizationId: string,
) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/projects/${projectId}/connector-profiles/${authorizationId}/connect/finalize`,
      {},
    ),
  );
}

/** @deprecated Use `pipedreamFinalizeConnectorAuthorization`. */
export const pipedreamFinalizeConnectionProfile = pipedreamFinalizeConnectorAuthorization;

export async function listConnectors(projectId: string) {
  return unwrap(
    // Background read fired at workspace mount (project-home tiles, sidebar
    // setup checklist) — never global-toast; callers render their own state.
    await backendApi.get<ConnectorsResponse>(`/executor/projects/${projectId}/connectors`, {
      showErrors: false,
    }),
  );
}

export async function syncConnectors(projectId: string) {
  return unwrap(
    await backendApi.post<ConnectorSyncResult>(
      `/executor/projects/${projectId}/connectors/sync`,
      {},
    ),
  );
}

/** `shared` is the only credential mode (`per_user` removed 2026-07-05) — kept
 *  for back-compat callers, restricted to a no-op on the API side. */
export async function setConnectorCredentialMode(projectId: string, slug: string, mode: 'shared') {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/credential-mode`,
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
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/authorization-strategy`,
      { authorization_strategy: authorizationStrategy },
    ),
  );
}

/** Toggle a connector's `sensitive` flag — sensitive connectors gate reads too
 *  (every action defaults to require_approval unless a policy opens it). */
export async function setConnectorSensitive(projectId: string, slug: string, sensitive: boolean) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/sensitive`,
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
    }>(`/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/policies`),
  );
}

export async function setConnectorPolicies(
  projectId: string,
  slug: string,
  policies: ConnectorPolicyRule[],
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/policies`,
      { policies },
    ),
  );
}

/**
 * @deprecated Policies apply to a connector profile, not one authorization.
 * Use `getConnectorPolicies(projectId, slug)`.
 */
export async function getConnectionPolicies(
  _projectId: string,
  _authorizationId: string,
): Promise<{ policies: ConnectorPolicyRule[] }> {
  throw new Error(
    'Authorization-specific policies were removed. Use getConnectorPolicies(projectId, slug).',
  );
}

/**
 * @deprecated Policies apply to a connector profile, not one authorization.
 * Use `setConnectorPolicies(projectId, slug, policies)`.
 */
export async function setConnectionPolicies(
  _projectId: string,
  _authorizationId: string,
  _policies: ConnectorPolicyRule[],
): Promise<{ ok: boolean }> {
  throw new Error(
    'Authorization-specific policies were removed. Use setConnectorPolicies(projectId, slug, policies).',
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
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/config`,
    ),
  );
}

export async function setConnectorName(projectId: string, slug: string, name: string) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/name`,
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
    }>(`/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect`, {}),
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
    }>(`/executor/projects/${projectId}/connectors`, draft),
  );
}

export async function discoverConnectorAuth(projectId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<ConnectorAuthDiscovery>(
      `/executor/projects/${projectId}/connectors/auth-discovery`,
      draft,
    ),
  );
}

export async function deleteConnector(projectId: string, slug: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}`,
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
    }>(`/executor/projects/${projectId}/pipedream/apps${qs ? `?${qs}` : ''}`),
  );
}

export interface ComposioStatus {
  configured: boolean;
  provider: 'composio' | null;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  authRequired: boolean;
  toolsCount: number | null;
  categories: string[];
  mcpUrl: string | null;
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string;
  authRequired: boolean;
}

export interface ComposioToolkitsPage {
  toolkits: ComposioToolkit[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ComposioToolsPage {
  tools: ComposioTool[];
  nextCursor?: string;
  hasMore: boolean;
}

export async function getComposioStatus(): Promise<ComposioStatus> {
  return unwrap(await backendApi.get<ComposioStatus>('/executor/composio/status'));
}

export async function listComposioToolkits(
  projectId: string,
  q?: string,
  cursor?: string,
): Promise<ComposioToolkitsPage> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<ComposioToolkitsPage>(
      `/executor/projects/${projectId}/composio/toolkits${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function listComposioTools(
  projectId: string,
  toolkitSlug: string,
  q?: string,
  cursor?: string,
): Promise<ComposioToolsPage> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<ComposioToolsPage>(
      `/executor/projects/${projectId}/composio/toolkits/${encodeURIComponent(toolkitSlug)}/tools${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function connectComposioToolkit(
  projectId: string,
  toolkitSlug: string,
  input: { connectorSlug: string; name: string },
): Promise<{
  ok: true;
  connectorSlug: string;
  connected: boolean;
  authorizationUrl: string | null;
  sync: ConnectorSyncResult;
}> {
  return unwrap(
    await backendApi.post<{
      ok: true;
      connectorSlug: string;
      connected: boolean;
      authorizationUrl: string | null;
      sync: ConnectorSyncResult;
    }>(
      `/executor/projects/${projectId}/composio/toolkits/${encodeURIComponent(toolkitSlug)}/connect`,
      input,
    ),
  );
}

export type DiscoverIntegrationKind = 'openapi' | 'mcp' | 'graphql' | 'cli';

export interface DiscoverIntegration {
  id: string;
  kind: DiscoverIntegrationKind;
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

export interface DiscoverIntegrationVariant {
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

export interface DiscoverIntegrationsPage {
  items: DiscoverIntegration[];
  total: number;
  nextCursor?: string;
  hasMore: boolean;
}

export interface DiscoverIntegrationDetail {
  item: DiscoverIntegration;
  variants: DiscoverIntegrationVariant[];
}

export async function listDiscoverIntegrations(projectId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<DiscoverIntegrationsPage>(
      `/executor/projects/${projectId}/discover/integrations${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function getDiscoverIntegration(projectId: string, id: string) {
  const params = new URLSearchParams({ id });
  return unwrap(
    await backendApi.get<DiscoverIntegrationDetail>(
      `/executor/projects/${projectId}/discover/integrations/detail?${params.toString()}`,
    ),
  );
}

/**
 * Deployment-wide flag: is the easy-connect (Pipedream) provider configured?
 * Lets the UI hide/disable the Easy Connect surface instead of surfacing it and
 * failing with a 501 once opened (e.g. self-host without Pipedream credentials).
 */
export async function getConnectStatus() {
  return unwrap(
    await backendApi.get<{ configured: boolean; provider: string | null }>(
      '/executor/connect-status',
    ),
  );
}

export async function setConnectorCredential(
  projectId: string,
  slug: string,
  credential: string | ConnectorAuthorizationCredentialInput,
) {
  const input = typeof credential === 'string' ? { value: credential } : credential;
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/credential`,
      input,
    ),
  );
}

export async function pipedreamFinalize(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect/finalize`,
      {},
    ),
  );
}
