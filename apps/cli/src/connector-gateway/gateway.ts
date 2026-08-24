/**
 * The Connector's data plane, shared by both faces of `kortix connectors`:
 *   - the CLI subcommands (`kortix connectors call …`)
 *   - the stdio MCP server (`kortix connectors mcp`)
 * plus the `@kortix/sdk` project client, which this module uses directly.
 *
 * Two project surfaces live here:
 *   1. `@kortix/sdk`'s project Connector data plane — runs connector tool calls.
 *      It acts as the launching user via KORTIX_TOKEN. The gateway resolves
 *      third-party credentials server-side. No secret touches the sandbox.
 *   2. The project-scoped API adapter — used for connector management
 *      (add/remove) and setup-link minting (connect / request_secret). Resolved
 *      through the same sandbox env-token host the rest of the CLI uses
 *      (`KORTIX_TOKEN` + `KORTIX_PROJECT_ID`).
 */
import type { ConnectorCallResult, Kortix } from '@kortix/sdk';
import { loadAuth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { kortixFromAuth } from '../api/sdk.ts';
import { resolveProjectId } from '../project-link.ts';
import { CliError } from './io.ts';

/**
 * The Connector gateway client — runs tool calls as the launching user.
 *
 * Resolves auth from ONE place (`activeHost()` via loadAuth), so it works
 * identically:
 *   - in-sandbox: `KORTIX_TOKEN` + `KORTIX_API_URL` are
 *     injected and win;
 *   - on a laptop: falls back to the host you `kortix login`'d.
 * The project comes from KORTIX_PROJECT_ID / `.kortix/link.json` / `--project`.
 * When a project is known we hit the project-explicit gateway routes (which
 * accept a plain user token), so `kortix connectors` is the SAME locally and in
 * the cloud. Without a project we fall back to the legacy flat routes, which
 * need a scoped session token (the in-sandbox case).
 */
export type ConnectorClient = Kortix['connectors'];

export function connectorClient(projectOverride?: string): ConnectorClient {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — run `kortix login` (or set KORTIX_TOKEN in a sandbox).',
      'MISSING_ENV',
    );
  }
  // --project > KORTIX_PROJECT_ID > .kortix/link.json (resolveProjectId order).
  const projectId = resolveProjectId(projectOverride);
  const kortix = kortixFromAuth(auth);
  return projectId ? kortix.project(projectId).connectors : kortix.connectors;
}

/**
 * The project-scoped kortix API client (NOT the gateway) — for connector
 * management + setup-link minting. Resolves the sandbox env-token host
 * (`activeHost()` in api/config.ts) + KORTIX_PROJECT_ID.
 */
export function connectorProjectContext(projectOverride?: string): { client: ApiClient; projectId: string } {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — KORTIX_TOKEN is missing.',
      'MISSING_ENV',
    );
  }
  const projectId = resolveProjectId(projectOverride);
  if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set.', 'MISSING_ENV');
  return { client: clientFromAuth(auth), projectId };
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
  projectOverride?: string;
}): Promise<ConnectLinkResult> {
  if (!opts.slug) throw new CliError('connector slug is required', 'USAGE');
  const { client, projectId } = connectorProjectContext(opts.projectOverride);
  return client.post<ConnectLinkResult>(`/projects/${projectId}/connect-requests`, {
    slug: opts.slug,
    ...(opts.expiresInMinutes ? { expires_in_minutes: opts.expiresInMinutes } : {}),
  });
}

/** Mint a short-lived link a human opens to enter project secret value(s). */
export async function mintSecretLink(opts: {
  names: string[];
  scope?: 'runtime' | 'connector';
  expiresInMinutes?: number;
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  projectOverride?: string;
}): Promise<SecretLinkResult> {
  if (opts.names.length === 0) throw new CliError('at least one secret name is required', 'USAGE');
  const { client, projectId } = connectorProjectContext(opts.projectOverride);
  return client.post<SecretLinkResult>(`/projects/${projectId}/secret-requests`, {
    names: opts.names,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.expiresInMinutes ? { expires_in_minutes: opts.expiresInMinutes } : {}),
    ...(opts.labels && Object.keys(opts.labels).length ? { labels: opts.labels } : {}),
    ...(opts.descriptions && Object.keys(opts.descriptions).length
      ? { descriptions: opts.descriptions }
      : {}),
  });
}

export type BrokerMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface BrokerCallResult {
  status: number;
  headers: Record<string, string>;
  body_base64: string;
}

/**
 * Make one HTTPS request with a project secret injected SERVER-SIDE.
 *
 * The sandbox never receives the credential: the API resolves it, applies the
 * secret's own host/method/injection policy, performs the request, and returns
 * only the upstream response. Same route the `kortix secrets call` CLI uses
 * (`POST /projects/:id/secrets/:identifier/broker`); this is its MCP face.
 */
export async function brokerSecretRequest(opts: {
  identifier: string;
  url: string;
  method?: BrokerMethod;
  headers?: Record<string, string>;
  body?: string;
  projectOverride?: string;
}): Promise<BrokerCallResult> {
  if (!opts.identifier) throw new CliError('secret identifier is required', 'USAGE');
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new CliError(`not a valid URL: ${opts.url}`, 'USAGE');
  }
  // Fail here rather than at the API: a plaintext hop would expose the
  // injected credential on the wire, so it is never a retryable condition.
  if (parsed.protocol !== 'https:') {
    throw new CliError('broker URL must be HTTPS', 'USAGE');
  }
  const { client, projectId } = connectorProjectContext(opts.projectOverride);
  return client.post<BrokerCallResult>(
    `/projects/${projectId}/secrets/${encodeURIComponent(opts.identifier)}/broker`,
    {
      url: opts.url,
      ...(opts.method ? { method: opts.method } : {}),
      ...(opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : {}),
      ...(opts.body !== undefined
        ? { body_base64: Buffer.from(opts.body, 'utf8').toString('base64') }
        : {}),
    },
  );
}

/**
 * Add (or update) a connector on the project NOW — committed to kortix.yaml on
 * main + synced server-side, exactly like the dashboard's "Add app". No change
 * request needed; it's live this session.
 */
export async function addConnector(
  draft: Record<string, unknown>,
  projectOverride?: string,
): Promise<{ ok: boolean; sync?: unknown }> {
  const { client, projectId } = connectorProjectContext(projectOverride);
  return client.post<{ ok: boolean; sync?: unknown }>(
    `/connectors/projects/${projectId}/connectors`,
    draft,
  );
}

/** Remove a connector from the project (kortix.yaml on main + catalog). */
export async function removeConnector(slug: string, projectOverride?: string): Promise<void> {
  const { client, projectId } = connectorProjectContext(projectOverride);
  await client.delete(`/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}`);
}
