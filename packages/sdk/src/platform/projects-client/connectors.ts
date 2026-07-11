// Executor connectors — connector CRUD, credentials, Pipedream. Connectors are
// project-wide visible; the only access gate is the agent's `connectors`
// grant (kortix.yaml [[agents]].connectors), not anything configured here.

import { backendApi } from '../api-client';
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
  provider: 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http' | 'channel' | 'computer';
  platform?: 'slack' | 'email' | null;
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
    await backendApi.post<ConnectorSyncResult>(`/executor/projects/${projectId}/connectors/sync`, {}),
  );
}

/** `shared` is the only credential mode (`per_user` removed 2026-07-05) — kept
 *  for back-compat callers, restricted to a no-op on the API side. */
export async function setConnectorCredentialMode(
  projectId: string,
  slug: string,
  mode: 'shared',
) {
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

export async function setConnectorPolicies(projectId: string, slug: string, policies: ConnectorPolicyRule[]) {
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
  auth: { type: 'none' | 'bearer' | 'basic' | 'custom' | 'oauth1' | 'oauth1'; in: 'header' | 'query'; name: string | null; prefix: string | null };
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
}

export async function createConnector(projectId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/connectors`,
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

/**
 * Deployment-wide flag: is the easy-connect (Pipedream) provider configured?
 * Lets the UI hide/disable the Easy Connect surface instead of surfacing it and
 * failing with a 501 once opened (e.g. self-host without Pipedream credentials).
 */
export async function getConnectStatus() {
  return unwrap(
    await backendApi.get<{ configured: boolean; provider: string | null }>(
      `/executor/connect-status`,
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
