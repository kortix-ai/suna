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

export interface AdminConnector {
  slug: string;
  name: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'postman' | 'graphql' | 'http' | 'channel' | 'computer';
  platform?: 'slack' | 'email' | null;
  /** Provider icon materialized during connector synchronization. */
  iconUrl?: string | null;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  /** Credential storage model. Always `shared` — `per_user` (each member's
   *  own) was removed 2026-07-05 (docs/specs/2026-07-05-agent-first-config-
   *  unification.md §2.5). A `shared` connector with no credential set
   *  (`secretSet: false`) needs reconnecting. */
  credentialMode: 'shared';
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
  | 'none' | 'bearer' | 'basic' | 'api_key' | 'oauth1' | 'oauth2'
  | 'openid_connect' | 'mutual_tls' | 'digest' | 'hawk' | 'ntlm'
  | 'aws_v4' | 'edgegrid' | 'asap' | 'unknown';
export interface ExecutableConnectorAuth {
  type: 'none' | 'bearer' | 'basic' | 'custom' | 'oauth1';
  in: 'header' | 'query'; name: string | null; prefix: string | null;
}
export interface ConnectorAuthCandidate {
  id: string; source: string; scheme: DiscoveredAuthScheme; label: string;
  supported: boolean; requestCount: number; totalRequests: number;
  placement: 'header' | 'query' | 'cookie' | null;
  parameterName: string | null; prefix: string | null;
  parameterNames: string[]; variables: string[];
  oauth?: {
    authorizationUrl?: string; tokenUrl?: string; refreshUrl?: string;
    openIdConnectUrl?: string; protectedResourceMetadataUrl?: string; scopes: string[];
  };
  executable: ExecutableConnectorAuth | null;
}
export interface ConnectorAuthDiscovery {
  status: 'detected' | 'none' | 'ambiguous' | 'unsupported';
  recommended: ExecutableConnectorAuth | null;
  candidates: ConnectorAuthCandidate[]; warnings: string[]; totalRequests: number;
  /** The source document's own name (OpenAPI `info.title`, Postman `info.name`). */
  title: string | null;
}

export interface ConnectionProfile {
  profile_id: string;
  connector_alias: string;
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  label: string;
  status: 'active' | 'revoked' | 'error';
  is_default: boolean;
  metadata: Record<string, unknown>;
}

export interface ReconcileConnectionProfileInput {
  connector_alias: string;
  owner_type: 'agent' | 'member' | 'subject' | 'external';
  owner_id: string;
  label: string;
  metadata?: Record<string, unknown>;
}

/** Create or update the calling user's member-owned profile. Ownership is
 * derived exclusively from the bearer token; callers cannot supply an owner. */
export interface ReconcileMemberConnectionProfileInput {
  connector_alias: string;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectionProfileConnectInput {
  success_redirect_uri?: string;
  error_redirect_uri?: string;
}

export async function listConnectionProfiles(projectId: string) {
  return unwrap(
    await backendApi.get<{ profiles: ConnectionProfile[] }>(
      `/projects/${projectId}/connector-profiles`,
    ),
  );
}

export async function reconcileConnectionProfile(
  projectId: string,
  input: ReconcileConnectionProfileInput,
) {
  return unwrap(
    await backendApi.post<ConnectionProfile>(`/projects/${projectId}/connector-profiles`, input),
  );
}

export async function reconcileMemberConnectionProfile(
  projectId: string,
  input: ReconcileMemberConnectionProfileInput,
) {
  return unwrap(
    await backendApi.post<ConnectionProfile>(`/projects/${projectId}/connector-profiles/me`, input),
  );
}

export async function updateConnectionProfileCredential(
  projectId: string,
  profileId: string,
  input: { value: string; kind?: 'secret' | 'connection' },
) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${profileId}/credential`,
      input,
    ),
  );
}

export async function revokeConnectionProfile(projectId: string, profileId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${profileId}/revoke`,
      {},
    ),
  );
}

export async function activateConnectionProfile(projectId: string, profileId: string) {
  return unwrap(
    await backendApi.put<{ ok: true }>(
      `/projects/${projectId}/connector-profiles/${profileId}/activate`,
      {},
    ),
  );
}

export async function pipedreamConnectConnectionProfile(
  projectId: string,
  profileId: string,
  input: ConnectionProfileConnectInput = {},
) {
  return unwrap(
    await backendApi.post<{ token?: string; app?: string; connectUrl?: string }>(
      `/projects/${projectId}/connector-profiles/${profileId}/connect`,
      input,
    ),
  );
}

export async function pipedreamFinalizeConnectionProfile(projectId: string, profileId: string) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/projects/${projectId}/connector-profiles/${profileId}/connect/finalize`,
      {},
    ),
  );
}

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

export async function getConnectorPolicies(projectId: string, slug: string) {
  return unwrap(
    await backendApi.get<{ policies: ConnectorPolicyRule[] }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/policies`,
    ),
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

/** The editable connection config for an existing connector (kortix.yaml = source of truth). */
export interface ConnectorConfig {
  slug: string;
  provider: AdminConnector['provider'];
  platform: 'slack' | 'email' | null;
  credentialMode: 'shared';
  app: string | null;
  account: string | null;
  url: string | null;
  transport: 'http' | 'sse' | null;
  endpoint: string | null;
  baseUrl: string | null;
  spec: string | null;
  auth: {
    type: 'none' | 'bearer' | 'basic' | 'custom' | 'oauth1' | 'oauth1';
    in: 'header' | 'query';
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
    await backendApi.post<{ token?: string; app?: string; connectUrl?: string }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect`,
      {},
    ),
  );
}

export interface ConnectorDraftInput {
  slug: string;
  name?: string;
  provider: AdminConnector['provider'];
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
  auth?: {
    type?: 'none' | 'bearer' | 'basic' | 'custom' | 'oauth1';
    in?: 'header' | 'query';
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
      ok: boolean; sync?: ConnectorSyncResult; authDiscovery?: ConnectorAuthDiscovery;
    }>(
      `/executor/projects/${projectId}/connectors`,
      draft,
    ),
  );
}

export async function discoverConnectorAuth(projectId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<ConnectorAuthDiscovery>(
      `/executor/projects/${projectId}/connectors/auth-discovery`, draft,
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
    await backendApi.get<{ apps: PipedreamApp[]; nextCursor?: string; hasMore: boolean }>(
      `/executor/projects/${projectId}/pipedream/apps${qs ? `?${qs}` : ''}`,
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

export async function setConnectorCredential(projectId: string, slug: string, value: string) {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/credential`,
      { value },
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
