// The request audit as Hono middleware: it reads what only Hono knows (the
// matched route, the handler's status, the auth middleware's identity) and hands
// it to the inbound audit scope. Rows are built and written in `shared/audit.ts`.
import type { Context, Next } from 'hono';
import { matchedRoutes } from 'hono/route';
import { auditLabelForRoute } from '@kortix/shared/audit-labels';
import { getRequestContext, runWithContext } from '../lib/request-context';
import type { AppEnv } from '../types';
import { emitInboundAuditRow } from '../shared/audit';
import { credentialFromContext } from '../shared/audit-credential';
import { type HonoIdentitySnapshot, attachInboundAuditScope, isUnauditedInbound } from '../shared/audit-scope';
import { isUuid } from '../shared/validate';

type AuditContext = Context<AppEnv>;

function inferAccountId(c: AuditContext): string | null {
  const parts = c.req.path.split('/').filter(Boolean);
  const accountPathCandidate = parts[0] === 'v1' && parts[1] === 'accounts' ? parts[2] : null;
  const accountPathId = isUuid(accountPathCandidate) ? accountPathCandidate : null;
  return (
    c.get('accountId') ||
    getRequestContext()?.accountId ||
    c.req.query('account_id') ||
    c.req.query('accountId') ||
    accountPathId ||
    null
  );
}

/**
 * What the Hono auth middleware put on the context, captured once after the
 * handler ran. The rules below turn it into actor fields; they are the rules
 * the request audit has always applied.
 */
function honoIdentitySnapshot(c: AuditContext): HonoIdentitySnapshot {
  const request = getRequestContext();
  const get = (key: string): unknown => (c as unknown as { get(key: string): unknown }).get(key);
  return {
    tokenUserId: c.get('userId') ?? request?.userId ?? null,
    accountId: inferAccountId(c),
    authType: c.get('authType'),
    apiKeyType: c.get('apiKeyType'),
    sessionIdVar: c.get('sessionId') ?? null,
    hasAgentGrant: c.get('agentGrant') != null,
    actor: get('actor'),
    credential: credentialFromContext(get),
    onBehalfOfUserIdVar: get('onBehalfOfUserId') as string | null | undefined,
    path: c.req.path,
  };
}

function errorStatus(error: unknown): number {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return 500;
}

/**
 * The route template of the endpoint Hono matched, or null when none did.
 *
 * Not `routePath`: that is the handler Hono stopped at, so a request an auth
 * middleware refused was recorded under the middleware's `/v1/projects/*`
 * instead of the endpoint it asked for. The router matches the whole handler
 * stack up front, so the endpoint is known even when it never ran: the last
 * method route, or else a catch-all handler (`app.all`) the catalog labels.
 * Everything else that matches with method ALL is middleware.
 */
function matchedEndpointRoute(c: AuditContext): string | null {
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i];
    if (route && route.method !== 'ALL') return route.path;
  }
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i];
    if (route && auditLabelForRoute('ALL', route.path)) return route.path;
  }
  return null;
}

/**
 * The request audit for the Hono app.
 *
 * Mounted on `*`. When `Bun.serve.fetch` already opened the request's scope
 * (production), this stamps what only Hono knows — the matched route
 * template, the handler's status, the auth middleware's identity — and leaves
 * the write to the edge. When nothing opened a scope (a test driving the app
 * directly), it opens one and writes the row itself.
 *
 * Either way every request gets exactly one row. There is no identity gate:
 * a request nobody authenticated is written as `anonymous`.
 */
export async function auditApiRequest(c: AuditContext, next: Next): Promise<void> {
  if (isUnauditedInbound(c.req.method, c.req.path)) {
    await next();
    return;
  }
  if (!getRequestContext()) {
    // A bare Hono app has no request context. Open one, so an authenticator's
    // binding has a scope to land in. Run the body directly — never recurse
    // into this check, which a mocked request context could fail forever.
    await runWithContext(
      c.req.method,
      c.req.path,
      () => auditRequestInScope(c, next),
      c.req.header('traceparent'),
    );
    return;
  }
  await auditRequestInScope(c, next);
}

async function auditRequestInScope(c: AuditContext, next: Next): Promise<void> {
  let url: URL | null = null;
  try {
    url = new URL(c.req.url);
  } catch {
    url = null;
  }
  const scope = attachInboundAuditScope({
    owner: 'hono',
    method: c.req.method,
    headers: c.req.raw.headers,
    url,
  });

  let thrown: unknown;
  try {
    await next();
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    if (scope.entrypoint === 'http') scope.route = matchedEndpointRoute(c);
    scope.status = thrown ? errorStatus(thrown) : c.res.status;
    scope.hono = honoIdentitySnapshot(c);
    if (scope.owner === 'hono') await emitInboundAuditRow(scope, scope.status);
  }
}

export const auditStateChangingRequest = auditApiRequest;
