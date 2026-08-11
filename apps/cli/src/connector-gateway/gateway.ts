/**
 * The Connector's data plane, shared by both faces of `kortix connectors`:
 *   - the CLI subcommands (`kortix connectors call …`)
 *   - the stdio MCP server (`kortix connectors mcp`)
 * plus the `@kortix/sdk` Workspace client, which this module uses directly.
 *
 * Two Workspace surfaces live here:
 *   1. `@kortix/sdk`'s Workspace Connector data plane — runs connector tool calls.
 *      It acts as the launching user via KORTIX_CLI_TOKEN. The gateway resolves
 *      third-party credentials server-side. No secret touches the sandbox.
 *   2. The Workspace-scoped API adapter — used for connector management
 *      (add/remove) and setup-link minting (connect / request_secret). Resolved
 *      through the same sandbox env-token host the rest of the CLI uses
 *      (`KORTIX_CLI_TOKEN` + `KORTIX_WORKSPACE_ID`).
 */
import type { ConnectorCallResult, Kortix } from '@kortix/sdk';
import { loadAuth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { kortixFromAuth } from '../api/sdk.ts';
import { resolveWorkspaceId } from '../workspace-link.ts';
import { CliError } from './io.ts';

/**
 * The Connector gateway client — runs tool calls as the launching user.
 *
 * Resolves auth from ONE place (`activeHost()` via loadAuth), so it works
 * identically:
 *   - in-sandbox: `KORTIX_CLI_TOKEN` + `KORTIX_API_URL` are
 *     injected and win;
 *   - on a laptop: falls back to the host you `kortix login`'d.
 * The workspace comes from KORTIX_WORKSPACE_ID / `.kortix/link.json` / `--workspace`.
 * When a workspace is known we hit the Workspace-explicit gateway routes (which
 * accept a plain user token), so `kortix connectors` is the SAME locally and in
 * the cloud. Without a workspace we fall back to the legacy flat routes, which
 * need a scoped session token (the in-sandbox case).
 */
export type ConnectorClient = Kortix['connectors'];

export function connectorClient(workspaceOverride?: string): ConnectorClient {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — run `kortix login` (or set KORTIX_CLI_TOKEN in a sandbox).',
      'MISSING_ENV',
    );
  }
  const workspaceId = resolveWorkspaceId(workspaceOverride);
  const kortix = kortixFromAuth(auth);
  return workspaceId ? kortix.workspace(workspaceId).connectors : kortix.connectors;
}

/**
 * The Workspace-scoped Kortix API client (NOT the gateway) — for connector
 * management + setup-link minting. Resolves the sandbox env-token host
 * (`activeHost()` in api/config.ts) + KORTIX_WORKSPACE_ID.
 */
export function connectorWorkspaceContext(workspaceOverride?: string): {
  client: ApiClient;
  workspaceId: string;
} {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — KORTIX_CLI_TOKEN is missing.',
      'MISSING_ENV',
    );
  }
  const workspaceId = resolveWorkspaceId(workspaceOverride);
  if (!workspaceId) throw new CliError('KORTIX_WORKSPACE_ID not set.', 'MISSING_ENV');
  return { client: clientFromAuth(auth), workspaceId };
}

/**
 * Make one connector request. A gated call returns its approval URL immediately.
 * The API records the decision and sends a durable callback into the session
 * when the human responds. The CLI never holds or polls an HTTP request.
 */
export async function callWithApprovalHandoff<T = unknown>(
  client: ConnectorClient,
  connector: string,
  action: string,
  args: Record<string, unknown>,
): Promise<ConnectorCallResult<T>> {
  return client.call<T>(`${connector}.${action}`, args);
}

export interface ConnectLinkResult {
  url: string;
  slug: string;
  app: string | null;
  expires_at: string;
}

export interface SecretLinkResult {
  url: string;
  names: string[];
  scope: string;
  expires_at: string;
}

/** Mint a Pipedream Quick Connect link for a declared connector. */
export async function mintConnectLink(opts: {
  slug: string;
  expiresInMinutes?: number;
  workspaceOverride?: string;
}): Promise<ConnectLinkResult> {
  if (!opts.slug) throw new CliError('connector slug is required', 'USAGE');
  const { client, workspaceId } = connectorWorkspaceContext(opts.workspaceOverride);
  return client.post<ConnectLinkResult>(`/workspaces/${workspaceId}/connect-requests`, {
    slug: opts.slug,
    ...(opts.expiresInMinutes ? { expires_in_minutes: opts.expiresInMinutes } : {}),
  });
}

/** Mint a short-lived link a human opens to enter Workspace secret value(s). */
export async function mintSecretLink(opts: {
  names: string[];
  scope?: 'runtime' | 'connector';
  expiresInMinutes?: number;
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  workspaceOverride?: string;
}): Promise<SecretLinkResult> {
  if (opts.names.length === 0) throw new CliError('at least one secret name is required', 'USAGE');
  const { client, workspaceId } = connectorWorkspaceContext(opts.workspaceOverride);
  return client.post<SecretLinkResult>(`/workspaces/${workspaceId}/secret-requests`, {
    names: opts.names,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.expiresInMinutes ? { expires_in_minutes: opts.expiresInMinutes } : {}),
    ...(opts.labels && Object.keys(opts.labels).length ? { labels: opts.labels } : {}),
    ...(opts.descriptions && Object.keys(opts.descriptions).length
      ? { descriptions: opts.descriptions }
      : {}),
  });
}

/**
 * Add (or update) a connector on the Workspace NOW — committed to kortix.yaml on
 * main + synced server-side, exactly like the dashboard's "Add app". No change
 * request needed; it's live this session.
 */
export async function addConnector(
  draft: Record<string, unknown>,
  workspaceOverride?: string,
): Promise<{ ok: boolean; sync?: unknown }> {
  const { client, workspaceId } = connectorWorkspaceContext(workspaceOverride);
  return client.post<{ ok: boolean; sync?: unknown }>(
    `/connectors/workspaces/${workspaceId}/connectors`,
    draft,
  );
}

/** Remove a connector from the Workspace (kortix.yaml on main + catalog). */
export async function removeConnector(slug: string, workspaceOverride?: string): Promise<void> {
  const { client, workspaceId } = connectorWorkspaceContext(workspaceOverride);
  await client.delete(
    `/connectors/workspaces/${workspaceId}/connectors/${encodeURIComponent(slug)}`,
  );
}
