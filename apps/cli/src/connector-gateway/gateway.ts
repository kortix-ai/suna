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
 *
 * Both are SESSION surfaces: they serve the session's project with the
 * session's credential, so they resolve the injected env identity explicitly
 * (loadEnvAuth) and never inherit the stored active host plain commands
 * prefer — a host credential for another deployment can reach neither this
 * session's project nor its connector credentials.
 */
import type { ConnectorCallResult, Kortix } from '@kortix/sdk';
import { loadAuth, loadEnvAuth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { kortixFromAuth } from '../api/sdk.ts';
import { resolveProjectId } from '../project-link.ts';
import { CliError, stringValue } from './io.ts';

/**
 * The Connector gateway client — runs tool calls as the launching user.
 *
 * Resolves the injected env identity FIRST (loadEnvAuth) so it works
 * identically:
 *   - in-sandbox: `KORTIX_TOKEN` + `KORTIX_API_URL` are injected and serve
 *     the session — regardless of any stored active host;
 *   - on a laptop: falls back to the host you `kortix login`'d.
 * The project comes from KORTIX_PROJECT_ID / `.kortix/link.json` / `--project`.
 * When a project is known we hit the project-explicit gateway routes (which
 * accept a plain user token), so `kortix connectors` is the SAME locally and in
 * the cloud. Without a project we fall back to the legacy flat routes, which
 * need a scoped session token (the in-sandbox case).
 */
export type ConnectorClient = Kortix['connectors'];

export function connectorClient(projectOverride?: string): ConnectorClient {
  const auth = loadEnvAuth() ?? loadAuth();
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
 * explicitly (session surface — see the module doc) + KORTIX_PROJECT_ID.
 */
export function connectorProjectContext(projectOverride?: string): {
  client: ApiClient;
  projectId: string;
} {
  const auth = loadEnvAuth() ?? loadAuth();
  if (!auth?.token) {
    throw new CliError('not authenticated — KORTIX_TOKEN is missing.', 'MISSING_ENV');
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
  options: { account?: string | true | null; approvalContext?: string | true | null } = {},
): Promise<ConnectorCallResult<T>> {
  // A valueless `--account`/`--reason` arrives as `true` — a flag typo, not a
  // name or a description. Only a real string is forwarded.
  const account = stringValue(options.account)?.trim();
  // Same flag-typo guard for the approval context.
  const approvalContext = stringValue(options.approvalContext)?.trim();
  return client.call<T>(`${connector}.${action}`, args, {
    ...(account ? { account } : {}),
    ...(approvalContext ? { approvalContext } : {}),
  });
}

interface ConnectLinkResult {
  provider: string;
  url: string | null;
  slug: string;
  app: string | null;
  connected: boolean;
  is_no_auth: boolean;
  session_id: string | null;
  connection_id: string | null;
  request_id: string | null;
  expires_at?: string;
}

interface FinalizeConnectionResult {
  provider: string;
  connected: boolean;
  account_id: string | null;
  connection_id: string | null;
  is_no_auth: boolean;
}

export interface SecretLinkResult {
  url: string;
  names: string[];
  scope: string;
  expires_at: string;
  /** Present only when this session's agent will not receive some names. */
  agent?: string;
  withheld?: Array<{ name: string; reason: 'agent_grant' | 'session_allowlist' }>;
  /** The server's one-paragraph fix for `withheld`, ready to relay. */
  withheld_fix?: string;
}

/**
 * Mint the KORTIX connect link a human should open for a declared connector.
 *
 * It must be OUR `${FRONTEND_URL}/connect/<token>` url, not the provider's own
 * page. The web transcript turns exactly that shape into the one-click Connect
 * button (`parseSetupLinkHref` -> `SetupLinkButton`), and anything else renders
 * as a bare underlined link — which is what a `connect.composio.dev/link/...`
 * url did, next to a generic link preview, with no button and no popup.
 *
 * Despite its name this used to POST the provider-authorization route and hand
 * back that raw url, quietly dropping `expiresInMinutes` because that route has
 * no such parameter. The setup-link route is the one that takes it.
 *
 * Falls back to the provider url only when no setup link can be minted (a
 * connector whose provider has no hosted page). A bare url is worse than a
 * button, but far better than telling the human nothing.
 */
export async function mintConnectLink(opts: {
  slug: string;
  expiresInMinutes?: number;
  projectOverride?: string;
  /**
   * WHO the account this link creates belongs to: `me` (the human who opens
   * the link, the server-side default) or `project` (shared with every member,
   * which the API gates on project.connector.write).
   *
   * Sent only when named. A shipped CLI talks to whatever API version its host
   * runs and the connect-request body is `.strict()`, so an unrequested `owner`
   * would 400 every connect against an API that predates the field.
   */
  owner?: 'me' | 'project';
  /**
   * The name to suggest for the NEW account ("Dad's Gmail"). The human sees it
   * prefilled in the connect dialog and may change it. Sent only when named,
   * for the same old-API reason as `owner`.
   */
  label?: string;
}): Promise<ConnectLinkResult> {
  if (!opts.slug) throw new CliError('connector slug is required', 'USAGE');
  const { client, projectId } = connectorProjectContext(opts.projectOverride);
  try {
    const link = await client.post<{ url?: string; app?: string | null; expires_at?: string }>(
      `/projects/${projectId}/connect-requests`,
      {
        slug: opts.slug,
        ...(opts.expiresInMinutes ? { expires_in_minutes: opts.expiresInMinutes } : {}),
        ...(opts.owner ? { owner: opts.owner } : {}),
        ...(opts.label ? { label: opts.label } : {}),
      },
    );
    if (link?.url) {
      return {
        provider: 'kortix',
        url: link.url,
        slug: opts.slug,
        app: link.app ?? null,
        connected: false,
        is_no_auth: false,
        session_id: null,
        connection_id: null,
        request_id: null,
      };
    }
  } catch {
    // Fall through to the provider url below.
  }
  const result = await client.post<{
    provider?: string;
    app?: string | null;
    connectUrl?: string | null;
    connected?: boolean;
    isNoAuth?: boolean;
    sessionId?: string;
    connectionId?: string;
    requestId?: string;
  }>(`/connectors/projects/${projectId}/connectors/${encodeURIComponent(opts.slug)}/connect`, {
    ...(opts.owner ? { owner: opts.owner } : {}),
  });
  return {
    provider: result.provider ?? 'unknown',
    url: result.connectUrl ?? null,
    slug: opts.slug,
    app: result.app ?? null,
    connected: result.connected === true,
    is_no_auth: result.isNoAuth === true,
    session_id: result.sessionId ?? null,
    connection_id: result.connectionId ?? null,
    request_id: result.requestId ?? null,
  };
}

/** Confirm that a previously started provider authorization completed. */
export async function finalizeConnectorConnection(opts: {
  slug: string;
  connectionId?: string;
  requestId?: string;
  projectOverride?: string;
}): Promise<FinalizeConnectionResult> {
  if (!opts.slug) throw new CliError('connector slug is required', 'USAGE');
  const { client, projectId } = connectorProjectContext(opts.projectOverride);
  const result = await client.post<{
    provider?: string;
    connected?: boolean;
    accountId?: string;
    connectionId?: string;
    isNoAuth?: boolean;
  }>(
    `/connectors/projects/${projectId}/connectors/${encodeURIComponent(opts.slug)}/connect/finalize`,
    {
      ...(opts.connectionId ? { connection_id: opts.connectionId } : {}),
      ...(opts.requestId ? { request_id: opts.requestId } : {}),
    },
  );
  return {
    provider: result.provider ?? 'unknown',
    connected: result.connected === true,
    account_id: result.accountId ?? null,
    connection_id: result.connectionId ?? opts.connectionId ?? null,
    is_no_auth: result.isNoAuth === true,
  };
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

/**
 * Store secret value(s) the caller already HAS — e.g. a key the human pasted in
 * chat. Same route as `kortix secrets set`; the API applies the caller's
 * secret-write permission. `connector` keeps the value server-side.
 */
export async function setSecrets(opts: {
  values: Record<string, string>;
  scope?: 'runtime' | 'connector';
  projectOverride?: string;
}): Promise<string[]> {
  const entries = Object.entries(opts.values);
  if (entries.length === 0)
    throw new CliError('at least one NAME: value pair is required', 'USAGE');
  const { client, projectId } = connectorProjectContext(opts.projectOverride);
  const saved: string[] = [];
  for (const [name, value] of entries) {
    await client.post(`/projects/${projectId}/secrets`, {
      name,
      value,
      ...(opts.scope === 'connector' ? { strategy: 'broker', consumer: 'connector' } : {}),
    });
    saved.push(name.toUpperCase());
  }
  return saved;
}

export type BrokerMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

interface BrokerCallResult {
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
