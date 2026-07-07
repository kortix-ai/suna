/**
 * The Executor's data plane, shared by both faces of `kortix executor`:
 *   - the CLI subcommands (`kortix executor call …`)
 *   - the stdio MCP server (`kortix executor mcp`)
 * plus the third face, the `@kortix/executor-sdk` TypeScript framework, which
 * this module is built on.
 *
 * Two clients live here:
 *   1. The Executor GATEWAY client (`@kortix/executor-sdk`) — runs connector
 *      tool calls. Acts AS the launching user via KORTIX_EXECUTOR_TOKEN; the
 *      gateway resolves the third-party credential server-side. No secret ever
 *      touches the sandbox.
 *   2. The project-scoped kortix API client — used for connector management
 *      (add/remove) and setup-link minting (connect / request_secret). Resolved
 *      through the same sandbox env-token host the rest of the CLI uses
 *      (KORTIX_CLI_TOKEN / KORTIX_EXECUTOR_TOKEN + KORTIX_PROJECT_ID).
 */
import {
  createExecutorClient,
  type ExecutorCallResult,
  type ExecutorClient,
} from '@kortix/executor-sdk';
import { loadAuth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { resolveProjectId } from '../project-link.ts';
import { CliError } from './io.ts';

/**
 * The Executor gateway client — runs tool calls as the launching user.
 *
 * Resolves auth from ONE place (`activeHost()` via loadAuth), so it works
 * identically:
 *   - in-sandbox: KORTIX_EXECUTOR_TOKEN/KORTIX_CLI_TOKEN + KORTIX_API_URL are
 *     injected and win;
 *   - on a laptop: falls back to the host you `kortix login`'d.
 * The project comes from KORTIX_PROJECT_ID / `.kortix/link.json` / `--project`.
 * When a project is known we hit the project-explicit gateway routes (which
 * accept a plain user token), so `kortix executor` is the SAME locally and in
 * the cloud. Without a project we fall back to the legacy flat routes, which
 * need a scoped session token (the in-sandbox case).
 */
export function executorClient(projectOverride?: string): ExecutorClient {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — run `kortix login` (or set KORTIX_EXECUTOR_TOKEN in a sandbox).',
      'MISSING_ENV',
    );
  }
  // --project > KORTIX_PROJECT_ID > .kortix/link.json (resolveProjectId order).
  const projectId = resolveProjectId(projectOverride) ?? undefined;
  return createExecutorClient({
    apiUrl: auth.api_base,
    token: auth.token,
    ...(projectId ? { projectId } : {}),
  });
}

/**
 * The project-scoped kortix API client (NOT the gateway) — for connector
 * management + setup-link minting. Resolves the sandbox env-token host
 * (`activeHost()` in api/config.ts) + KORTIX_PROJECT_ID.
 */
export function executorProjectContext(projectOverride?: string): { client: ApiClient; projectId: string } {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — KORTIX_EXECUTOR_TOKEN / KORTIX_CLI_TOKEN missing.',
      'MISSING_ENV',
    );
  }
  const projectId = resolveProjectId(projectOverride);
  if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set.', 'MISSING_ENV');
  return { client: clientFromAuth(auth), projectId };
}

/** Bound so a forgotten approval can't wedge the agent forever:
 *  ~40 × ~45s gateway holds ≈ 30 min of pause. */
const APPROVAL_POLL_MAX = 40;

/**
 * Run a tool call, PAUSING for human approval — shared by BOTH faces
 * (`kortix executor call` and the MCP server) so the agent's turn behaves the
 * same everywhere. A `require_approval` call blocks: the gateway holds each
 * request briefly, then — while still pending — returns `retryable` + the
 * execution id; we re-issue the call with that id so the wait is effectively
 * INDEFINITE (like a question) without any single long-held request. On
 * approve, the SAME held request falls through and runs the action, so the
 * turn resumes in place — the human never has to type "continue".
 */
export async function callPausingForApproval<T = unknown>(
  executor: ExecutorClient,
  connector: string,
  action: string,
  args: Record<string, unknown>,
): Promise<ExecutorCallResult<T>> {
  let result = await executor.call<T>(connector, action, args);
  for (let i = 0; i < APPROVAL_POLL_MAX; i++) {
    if (!(result.status === 'pending_approval' && result.retryable && result.execution_id)) break;
    result = await executor.call<T>(connector, action, args, {
      approvalExecutionId: result.execution_id,
    });
  }
  return result;
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
  const { client, projectId } = executorProjectContext(opts.projectOverride);
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
  const { client, projectId } = executorProjectContext(opts.projectOverride);
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
 * Add (or update) a connector on the project NOW — committed to kortix.toml on
 * main + synced server-side, exactly like the dashboard's "Add app". No change
 * request needed; it's live this session.
 */
export async function addConnector(
  draft: Record<string, unknown>,
  projectOverride?: string,
): Promise<{ ok: boolean; sync?: unknown }> {
  const { client, projectId } = executorProjectContext(projectOverride);
  return client.post<{ ok: boolean; sync?: unknown }>(
    `/executor/projects/${projectId}/connectors`,
    draft,
  );
}

/** Remove a connector from the project (kortix.toml on main + catalog). */
export async function removeConnector(slug: string, projectOverride?: string): Promise<void> {
  const { client, projectId } = executorProjectContext(projectOverride);
  await client.delete(`/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}`);
}
