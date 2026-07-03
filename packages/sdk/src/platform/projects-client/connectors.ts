// Executor connectors — connector CRUD, sharing, credentials, Pipedream.

import { backendApi } from '../api-client';
import { unwrap, type ConnectorSharing } from './shared';

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
  /** Credential storage model — one shared project credential vs each member's own. */
  credentialMode: 'shared' | 'per_user';
  /** Marked sensitive — its reads gate too (require_approval by default). */
  sensitive: boolean;
  actions: ConnectorAction[];
  authSecret: string | null;
  sharing: ConnectorSharing | null;
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
    await backendApi.get<ConnectorsResponse>(`/executor/projects/${projectId}/connectors`),
  );
}

export async function syncConnectors(projectId: string) {
  return unwrap(
    await backendApi.post<ConnectorSyncResult>(`/executor/projects/${projectId}/connectors/sync`, {}),
  );
}

export async function setConnectorSharing(
  projectId: string,
  slug: string,
  intent: ConnectorSharing,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/sharing`,
      intent,
    ),
  );
}

export async function setConnectorCredentialMode(
  projectId: string,
  slug: string,
  mode: 'shared' | 'per_user',
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

/** The editable connection config for an existing connector (kortix.toml = source of truth). */
export interface ConnectorConfig {
  slug: string;
  provider: AdminConnector['provider'];
  platform: 'slack' | 'email' | null;
  credentialMode: 'shared' | 'per_user';
  app: string | null;
  account: string | null;
  url: string | null;
  transport: 'http' | 'sse' | null;
  endpoint: string | null;
  baseUrl: string | null;
  spec: string | null;
  auth: { type: 'none' | 'bearer' | 'basic' | 'custom'; in: 'header' | 'query'; name: string | null; prefix: string | null };
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
  /** Credential storage mode. */
  credential?: 'shared' | 'per_user';
  /** Access — who can use it (applied after create). */
  sharing?: ConnectorSharing;
  auth?: {
    type?: 'none' | 'bearer' | 'basic' | 'custom';
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
