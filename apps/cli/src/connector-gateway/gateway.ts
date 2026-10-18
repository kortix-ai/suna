/**
 * The Connector's data plane behind the `kortix connectors` subcommands,
 * plus the `@kortix/sdk` project client, which this module uses directly.
 *
 * Two project surfaces live here:
 *   1. `@kortix/sdk`'s project Connector data plane — runs connector tool calls.
 *      It acts as the launching user via KORTIX_TOKEN. The gateway resolves
 *      third-party credentials server-side. No secret touches the sandbox.
 *   2. The project-scoped API adapter — used for connector management
 *      (add/remove) and setup-link minting (connect). Resolved
 *      through the same sandbox env-token host the rest of the CLI uses
 *      (`KORTIX_TOKEN` + `KORTIX_PROJECT_ID`).
 */
import type { ConnectorCallResult, Kortix } from '@kortix/sdk';
import type { Auth } from '../api/auth.ts';
import { type ApiClient } from '../api/client.ts';
import { kortixFromAuth } from '../api/sdk.ts';
import { resolveProjectContext } from '../command-helpers.ts';
import { CliError, stringValue } from './io.ts';

/**
 * The project context behind BOTH connector faces — tool calls and management
 * — resolved exactly the way every other project-scoped command resolves it
 * (`resolveProjectContext`: `--host` → the cwd link's host + its stored
 * credentials → the injected env token → the active host; project: `--project`
 * → the link → `KORTIX_PROJECT_ID` → the host default).
 *
 * That sameness IS the fix (KRTX-2529): the gateway face used to pin auth to
 * the injected env token and the project to `KORTIX_PROJECT_ID`, so inside a
 * directory linked to a non-session project, `connectors call denies-connector
 * ls` answered as the sandbox session ("active") while `connectors ls`
 * answered as the link ("no connector") — two faces, two answers. Resolving
 * through the one function the admin face uses makes a disagreement
 * impossible: a link (or `--host`) supplies BOTH the project and the
 * credential that can act on it, and a session with no link keeps the
 * injected env identity (KRTX-1705), now via resolveProjectAuth's env
 * fallback.
 */
export async function connectorContext(
  projectOverride?: string,
  hostArg?: string,
): Promise<{ client: ApiClient; projectId: string; auth: Auth }> {
  const ctx = await resolveProjectContext({ projectArg: projectOverride, hostArg, envPin: true });
  if (!ctx) {
    throw new CliError(
      'no project context — run `kortix login`, then `kortix projects link` (or pass --project / --host).',
      'NO_PROJECT_CONTEXT',
    );
  }
  return ctx;
}

/**
 * The Connector gateway client — runs tool calls. Project-explicit routes
 * (which accept a plain user token), so `kortix connectors` is the SAME
 * locally and in the cloud.
 */
export type ConnectorClient = Kortix['connectors'];

export async function connectorClient(
  projectOverride?: string,
  hostArg?: string,
): Promise<ConnectorClient> {
  const ctx = await connectorContext(projectOverride, hostArg);
  const kortix = kortixFromAuth(ctx.auth);
  return kortix.project(ctx.projectId).connectors;
}

/**
 * The project-scoped kortix API client (NOT the gateway) — for connector
 * management + setup-link minting. Same context resolution as tool calls.
 */
export async function connectorProjectContext(
  projectOverride?: string,
  hostArg?: string,
): Promise<{ client: ApiClient; projectId: string }> {
  const ctx = await connectorContext(projectOverride, hostArg);
  return { client: ctx.client, projectId: ctx.projectId };
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
  const result = await client.call<T>(`${connector}.${action}`, args, {
    ...(account ? { account } : {}),
    ...(approvalContext ? { approvalContext } : {}),
  });
  // `output` repeats the payload of `data` without its envelope (for SDK
  // callers). The agent reads `data`; printing both doubles every result.
  const { output: _output, ...shown } = result as ConnectorCallResult<T> & { output?: unknown };
  return shown;
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
  hostArg?: string;
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
  const { client, projectId } = await connectorProjectContext(opts.projectOverride, opts.hostArg);
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

/**
 * Add (or update) a connector on the project NOW — committed to kortix.yaml on
 * main + synced server-side, exactly like the dashboard's "Add app". No change
 * request needed; it's live this session.
 */
export async function addConnector(
  draft: Record<string, unknown>,
  projectOverride?: string,
  hostArg?: string,
): Promise<{ ok: boolean; sync?: unknown }> {
  const { client, projectId } = await connectorProjectContext(projectOverride, hostArg);
  return client.post<{ ok: boolean; sync?: unknown }>(
    `/connectors/projects/${projectId}/connectors`,
    draft,
  );
}

/** Remove a connector from the project (kortix.yaml on main + catalog). */
export async function removeConnector(
  slug: string,
  projectOverride?: string,
  hostArg?: string,
): Promise<void> {
  const { client, projectId } = await connectorProjectContext(projectOverride, hostArg);
  await client.delete(`/connectors/projects/${projectId}/connectors/${encodeURIComponent(slug)}`);
}
