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
import { createExecutorClient, type ExecutorClient } from '@kortix/executor-sdk';
import { loadAuth } from '../api/auth.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { resolveProjectId } from '../project-link.ts';
import { CliError } from './io.ts';

function apiBase(): string {
  const url = process.env.KORTIX_API_URL?.trim();
  if (!url) throw new CliError('KORTIX_API_URL not set — the Executor gateway is unreachable.', 'MISSING_ENV');
  return url.replace(/\/+$/, '');
}

/** The gateway client — runs tool calls as the launching user. */
export function executorClientFromEnv(): ExecutorClient {
  const token = process.env.KORTIX_EXECUTOR_TOKEN?.trim() || process.env.KORTIX_CLI_TOKEN?.trim();
  if (!token) {
    throw new CliError('KORTIX_EXECUTOR_TOKEN not set — cannot reach the Executor gateway.', 'MISSING_ENV');
  }
  return createExecutorClient({ apiUrl: apiBase(), token });
}

/**
 * The project-scoped kortix API client (NOT the gateway) — for connector
 * management + setup-link minting. Resolves the sandbox env-token host
 * (`activeHost()` in api/config.ts) + KORTIX_PROJECT_ID.
 */
export function executorProjectContext(): { client: ApiClient; projectId: string } {
  const auth = loadAuth();
  if (!auth?.token) {
    throw new CliError(
      'not authenticated — KORTIX_EXECUTOR_TOKEN / KORTIX_CLI_TOKEN missing.',
      'MISSING_ENV',
    );
  }
  const projectId = resolveProjectId();
  if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set.', 'MISSING_ENV');
  return { client: clientFromAuth(auth), projectId };
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
}): Promise<ConnectLinkResult> {
  if (!opts.slug) throw new CliError('connector slug is required', 'USAGE');
  const { client, projectId } = executorProjectContext();
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
}): Promise<SecretLinkResult> {
  if (opts.names.length === 0) throw new CliError('at least one secret name is required', 'USAGE');
  const { client, projectId } = executorProjectContext();
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
): Promise<{ ok: boolean; sync?: unknown }> {
  const { client, projectId } = executorProjectContext();
  return client.post<{ ok: boolean; sync?: unknown }>(
    `/executor/projects/${projectId}/connectors`,
    draft,
  );
}

/** Remove a connector from the project (kortix.toml on main + catalog). */
export async function removeConnector(slug: string): Promise<void> {
  const { client, projectId } = executorProjectContext();
  await client.delete(`/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}`);
}
