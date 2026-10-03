/**
 * Connector onboarding on `kortix ship` — after a successful push, reconcile
 * the catalog from the just-shipped manifest and walk the user through
 * connecting anything that still needs auth. Split out of ship.ts: ship's
 * push flow calls it, but a connector never decides how git pushes.
 */

import { ApiError, type ApiClient } from '../api/client.ts';
import { promptSecret } from '../prompts.ts';
import { C, status } from '../style.ts';

/** The ship flags the connector flow reads. */
interface ConnectorFlags {
  noConnect: boolean;
  yes: boolean;
}

/**
 * Say so when the connector routes are simply not there.
 *
 * Both connector steps below swallow their errors, and correctly so: a transient
 * reconcile failure does not invalidate a completed git push, and the server's
 * rotating discovery sweep retries the project anyway. But `404` is not
 * transient — it means this binary is calling a route the API no longer has, and
 * no amount of retrying fixes it. That is exactly the failure that went
 * unnoticed for weeks after `/executor/*` became `/connectors/*`: every sandbox
 * CLI 404ed on every connector call and printed nothing at all.
 *
 * So: surface a 404 and name the fix, keep swallowing everything else. Written
 * to STDERR so it cannot be mistaken for ship output a script is parsing.
 */
function warnIfConnectorRouteMissing(err: unknown): void {
  if (!(err instanceof ApiError) || err.status !== 404) return;
  process.stderr.write(
    `${status.warn('connector routes returned 404 — this `kortix` CLI looks out of date')}\n` +
      `  ${C.dim}Update it with ${C.reset}${C.cyan}kortix update${C.reset}${C.dim}, then re-run ship. ` +
      `Connectors were NOT reconciled.${C.reset}\n`,
  );
}

interface ShipConnector {
  slug: string;
  name: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'postman' | 'graphql' | 'http';
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  authSecret: string | null;
  secretSet: boolean;
}

/**
 * After a successful push, reconcile the connector catalog from the just-shipped
 * manifest and walk the user through connecting anything that still needs auth —
 * Pipedream apps via an auto-finalizing one-click connection URL, and
 * HTTP/OpenAPI/GraphQL/MCP connectors via their credential secret. Mirrors
 * the env-secret reconciliation so a single `kortix ship` leaves the project
 * ready to run. Skipped with --no-connect; non-interactive / --yes only nags
 * with the slugs left to connect. Never hard-fails the ship.
 */
export async function ensureConnectorsConnected(
  client: ApiClient,
  projectId: string,
  flags: ConnectorFlags,
): Promise<void> {
  if (flags.noConnect) return;
  const ex = `/connectors/projects/${projectId}`;

  let connectors: ShipConnector[];
  try {
    const resp = await client.get<{ connectors: ShipConnector[] }>(`${ex}/connectors`);
    connectors = resp.connectors;
  } catch (err) {
    warnIfConnectorRouteMissing(err);
    return; // don't block the ship over connector setup
  }
  if (connectors.length === 0) return;

  const pending = connectors.filter(
    (c) => c.status === 'needs_auth' || (!!c.authSecret && !c.secretSet),
  );
  if (pending.length === 0) {
    process.stdout.write(
      `  ${C.dim}connectors  ${connectors.length} declared, all connected${C.reset}\n`,
    );
    return;
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive || flags.yes) {
    const slugs = pending.map((c) => c.slug).join(', ');
    process.stdout.write(
      `  ${status.warn(`${pending.length} connector${pending.length === 1 ? '' : 's'} not connected: ${slugs}`)}\n` +
        `  ${C.dim}Connect ${pending.length === 1 ? 'it' : 'them'} with ${C.reset}${C.cyan}kortix connectors connect <slug>${C.reset}${C.dim} (or re-run ship interactively).${C.reset}\n`,
    );
    return;
  }

  process.stdout.write(
    `\n  ${C.bold}connectors${C.reset}  ${C.dim}${pending.length} need setup — connect ${pending.length === 1 ? 'it' : 'them'} now (blank = skip):${C.reset}\n`,
  );
  let connected = 0;
  let connectionLinks = 0;
  for (const c of pending) {
    if (c.provider === 'pipedream') {
      if (await connectPipedreamApp(client, projectId, c)) connectionLinks += 1;
    } else if (c.authSecret) {
      if (await setConnectorCredential(client, ex, c)) connected += 1;
    } else {
      process.stdout.write(`    ${C.dim}${c.slug}: no auth flow to run — skipped${C.reset}\n`);
    }
  }
  if (connected > 0) {
    process.stdout.write(
      `  ${C.dim}${connected} connector${connected === 1 ? '' : 's'} connected.${C.reset}\n`,
    );
  }
  if (connectionLinks > 0) {
    process.stdout.write(
      `  ${C.dim}${connectionLinks} auto-finalizing connection URL${connectionLinks === 1 ? '' : 's'} created.${C.reset}\n`,
    );
  }
}

/**
 * Reconcile the pushed manifest into the server runtime catalog.
 *
 * This step always runs. The --no-connect flag only skips credential prompts.
 */
export async function reconcileShippedManifest(
  client: ApiClient,
  projectId: string,
): Promise<void> {
  try {
    await client.post(`/connectors/projects/${projectId}/connectors/sync`);
  } catch (err) {
    // A reconcile failure does not invalidate the completed git push.
    // The rotating server discovery sweep retries the project — except on a
    // 404, which no retry can fix. See warnIfConnectorRouteMissing.
    warnIfConnectorRouteMissing(err);
  }
}

/** Mint one auto-finalizing Pipedream connection URL for the user. */
async function connectPipedreamApp(
  client: ApiClient,
  projectId: string,
  c: ShipConnector,
): Promise<boolean> {
  try {
    const resp = await client.post<{ url: string; expires_at: string }>(
      `/projects/${projectId}/connect-requests`,
      { slug: c.slug },
    );
    process.stdout.write(`\n    ${C.bold}${c.slug}${C.reset} ${C.faded}(${c.name})${C.reset}\n`);
    process.stdout.write(
      `    ${C.dim}Authorize:${C.reset} ${C.cyan}${resp.url}${C.reset}\n` +
        `    ${C.dim}Expires ${resp.expires_at}. The connection finalizes automatically.${C.reset}\n`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error).message;
    process.stderr.write(`    ${status.err(`connect ${c.slug} failed: ${msg}`)}\n`);
    return false;
  }
}

/** HTTP/OpenAPI/GraphQL/MCP: store the bearer/basic credential secret value. */
async function setConnectorCredential(
  client: ApiClient,
  ex: string,
  c: ShipConnector,
): Promise<boolean> {
  const value = await promptSecret(`    ${c.slug} ${C.dim}(credential → ${c.authSecret})${C.reset}`);
  if (!value) {
    process.stdout.write(`    ${C.dim}skipped ${c.slug}${C.reset}\n`);
    return false;
  }
  try {
    await client.put(`${ex}/connectors/${encodeURIComponent(c.slug)}/credential`, { value });
    process.stdout.write(`    ${status.ok(`${C.bold}${c.slug}${C.reset} credential set`)}\n`);
    return true;
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error).message;
    process.stderr.write(`    ${status.err(`couldn't set ${c.slug}: ${msg}`)}\n`);
    return false;
  }
}
