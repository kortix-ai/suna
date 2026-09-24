/**
 * The inbound audit scope: one per request that reaches the API process.
 *
 * ## Why this exists
 *
 * The audit log used to be opt-in in four independent ways, so every new
 * surface started out dark:
 *
 *  1. `auditApiRequest` wrote a row only when a route had put a user or an
 *     account on the Hono context. Anything that authenticated its own
 *     credential was skipped without a trace — the Git proxy wrote no row for
 *     a clone or a push until #7507 patched it by hand.
 *  2. It was mounted on `/v1/*`, so `/scim/v2` never passed through it.
 *  3. Preview subdomains, deployed-app origins, the tunnel WebSocket and the
 *     PTY terminal WebSocket are dispatched by `Bun.serve.fetch` before Hono
 *     sees the request, so they had no row and no request context at all.
 *  4. Every explicit `recordAuditEvent` call had to pass the actor by hand.
 *
 * ## The model
 *
 * The outermost layer that sees a request opens ONE scope and writes ONE row
 * when the response is known — unconditionally, except for the probe and
 * preflight noise named in {@link isUnauditedInbound}. In production that
 * layer is `Bun.serve.fetch` (`shared/audit-edge.ts`); a test that drives the
 * Hono app directly gets the same row from `auditApiRequest`.
 *
 * Everything that learns something about the request writes INTO the scope:
 *
 *  - an authenticator that resolved a caller calls {@link bindAuditPrincipal};
 *  - a handler that knows the domain meaning calls {@link annotateAuditEvent}
 *    (`git.push` with its refs, instead of `POST …/git-receive-pack`);
 *  - the dispatcher that classified the request calls
 *    {@link setInboundAuditEntrypoint}.
 *
 * A request nobody bound is still written, as `actor_type: 'anonymous'`. A
 * missing binding therefore shows up as an unattributed row, never as a
 * missing one.
 *
 * This module is a LEAF: it imports only the request context. Eleven test
 * files replace `shared/audit` wholesale with `mock.module`, so authenticators
 * import their binding API from here, never from `shared/audit`.
 */
import * as requestContext from '../lib/request-context';

// Namespace import, resolved at call time: several test files replace
// `lib/request-context` with a partial `mock.module` (no `runWithContext`),
// and a named import would fail those files at link time.
const getRequestContext = () => requestContext.getRequestContext();

export type AuditScopeActorType = 'human' | 'agent' | 'service_account' | 'system' | 'anonymous';
export type AuditScopeOutcome = 'success' | 'failure' | 'denied' | 'pending';

/**
 * Where the request entered the process. `http` is the Hono app; the others
 * are dispatched by `Bun.serve.fetch` before Hono. `worker` is a background
 * job's tick (`runWorkerTick`), which no request drives.
 */
export type InboundEntrypoint = 'http' | 'preview_origin' | 'app_origin' | 'ws_upgrade' | 'worker';

/**
 * Who is calling, as far as an authenticator could tell.
 *
 * `undefined` means "not known here" and never overwrites a value another
 * authenticator bound. `null` is a statement — "known to be none" — and is
 * kept.
 */
export interface AuditPrincipal {
  accountId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  actorType?: AuditScopeActorType | null;
  agentId?: string | null;
  agentName?: string | null;
  onBehalfOfUserId?: string | null;
  initiatorActorType?: string | null;
  initiatorActorId?: string | null;
  /** How the caller authenticated, e.g. `human`, `api_key`, `agent`, `scim`. */
  authoritativeSource?: string | null;
  /**
   * HOW the caller authenticated, never the secret itself: `{ kind:
   * 'scim_token', token_id }`, `{ kind: 'git_basic' }`. Stored as
   * `metadata.auth`. (Not `credential`: the central redactor blanks any key
   * with that name, correctly.)
   */
  authMethod?: Record<string, unknown> | null;
  /**
   * Attribution that needs a lookup — an agent session's on-behalf-of human,
   * say. Resolved when the row is written, off the request path; the fields
   * it returns win over the ones bound alongside it. A lookup that fails
   * keeps what was bound.
   */
  lateAttribution?: () => Promise<Omit<AuditPrincipal, 'lateAttribution'> | null>;
}

/** What a handler knows that the transport does not. */
export interface AuditAnnotation {
  /** A canonical domain action (`git.push`) that replaces `METHOD /route`. */
  action?: string;
  resourceType?: string;
  resourceId?: string | null;
  outcome?: AuditScopeOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Identity the Hono auth middleware put on the context, captured by
 * `auditApiRequest` after the handler ran. Emission turns it into actor fields
 * with the same rules the middleware always used.
 */
export interface HonoIdentitySnapshot {
  tokenUserId: string | null;
  accountId: string | null;
  authType: string | undefined;
  apiKeyType: string | undefined;
  sessionIdVar: string | null;
  hasAgentGrant: boolean;
  /** `c.get('actor')` — the canonical IAM actor, when auth built one. */
  actor: unknown;
  /** `c.get('onBehalfOfUserId')`; `undefined` when the variable was never set. */
  onBehalfOfUserIdVar: string | null | undefined;
  /** The raw request path. Used to derive ids; never written to the row. */
  path: string;
}

export interface InboundAuditScope {
  /**
   * Which layer opened the scope. Only `edge` and `hono` write a request row;
   * a `worker` scope lends its principal to the rows its tick writes.
   */
  readonly owner: 'edge' | 'hono' | 'worker';
  readonly method: string;
  readonly startedAt: number;
  entrypoint: InboundEntrypoint;
  /** Matched route template or entrypoint class. Never a raw path. */
  route: string | null;
  /** Status as the innermost layer saw it, before edge rewrites (502 → 503). */
  status: number | null;
  principal: AuditPrincipal;
  annotation: AuditAnnotation;
  hono: HonoIdentitySnapshot | null;
  /** Request-level facts, captured once when the scope opens. */
  ip: string | null;
  userAgent: string | null;
  clientSourceHeader: string | null;
  correlationId: string | null;
  /** Account id from `?account_id=` / `?accountId=`; the only query value read. */
  queryAccountId: string | null;
  emitted: boolean;
}

export interface InboundAuditScopeInit {
  owner: 'edge' | 'hono' | 'worker';
  method: string;
  entrypoint?: InboundEntrypoint;
  route?: string | null;
  headers?: Headers | null;
  url?: URL | null;
  startedAt?: number;
}

const SCOPE_KEY = Symbol.for('kortix.inbound-audit-scope');

type ContextWithScope = { [SCOPE_KEY]?: InboundAuditScope };

function firstForwardedFor(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || null
  );
}

/**
 * Open the scope for this request, or return the one already open.
 *
 * Idempotent on purpose: the edge opens it and the Hono middleware then finds
 * it, so a request dispatched into Hono is still ONE row. Outside a request
 * context the scope is returned but not attached, so a test that drives a bare
 * Hono app with no request context still gets its row from the middleware.
 */
export function attachInboundAuditScope(init: InboundAuditScopeInit): InboundAuditScope {
  const existing = currentInboundAuditScope();
  if (existing) return existing;
  const headers = init.headers ?? null;
  const scope: InboundAuditScope = {
    owner: init.owner,
    method: init.method,
    startedAt: init.startedAt ?? Date.now(),
    entrypoint: init.entrypoint ?? 'http',
    route: init.route ?? null,
    status: null,
    principal: {},
    annotation: {},
    hono: null,
    ip: firstForwardedFor(headers),
    userAgent: headers?.get('user-agent') || null,
    clientSourceHeader: headers?.get('x-kortix-client') ?? null,
    correlationId: headers?.get('x-correlation-id') || headers?.get('idempotency-key') || null,
    queryAccountId:
      init.url?.searchParams.get('account_id') || init.url?.searchParams.get('accountId') || null,
    emitted: false,
  };
  const store = getRequestContext() as ContextWithScope | undefined;
  if (store) store[SCOPE_KEY] = scope;
  return scope;
}

/** The scope of the request currently executing, if any. */
export function currentInboundAuditScope(): InboundAuditScope | undefined {
  return (getRequestContext() as ContextWithScope | undefined)?.[SCOPE_KEY];
}

/**
 * Record who is calling. Call it from the authenticator, at the moment the
 * credential is proven — never from a handler "later".
 *
 * Safe everywhere: outside a request it does nothing, and it never throws.
 */
export function bindAuditPrincipal(principal: AuditPrincipal): void {
  const scope = currentInboundAuditScope();
  if (!scope) return;
  for (const [key, value] of Object.entries(principal) as Array<
    [keyof AuditPrincipal, AuditPrincipal[keyof AuditPrincipal]]
  >) {
    if (value === undefined) continue;
    (scope.principal as Record<string, unknown>)[key] = value;
  }
}

/**
 * Say what the request meant. The row keeps its HTTP identity in
 * `metadata.http`; `action` becomes the canonical domain action.
 */
export function annotateAuditEvent(annotation: AuditAnnotation): void {
  const scope = currentInboundAuditScope();
  if (!scope) return;
  const { metadata, ...rest } = annotation;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    (scope.annotation as Record<string, unknown>)[key] = value;
  }
  if (metadata) scope.annotation.metadata = { ...scope.annotation.metadata, ...metadata };
}

/** Classify a request the dispatcher routed outside Hono. */
export function setInboundAuditEntrypoint(entrypoint: InboundEntrypoint, route: string): void {
  const scope = currentInboundAuditScope();
  if (!scope) return;
  scope.entrypoint = entrypoint;
  scope.route = route;
}

const UNAUDITED_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/v1/health',
  '/v1/health/live',
  '/v1/health/ready',
  '/metrics',
  '/v1/openapi.json',
  '/v1/docs',
]);

/**
 * The only traffic that never produces an audit row: CORS preflights and the
 * load-balancer / scraper probes, which fire every few seconds on every task
 * and carry no principal action. Everything else is audited.
 */
export function isUnauditedInbound(method: string, path: string): boolean {
  return method === 'OPTIONS' || UNAUDITED_PATHS.has(path);
}

/**
 * An external system that proved itself — a webhook whose signature (or
 * shared secret) verified. The system is the actor; the account and project
 * are the ones the delivery is FOR, when the caller knows them. Call it from
 * the verifier's success branch, so only a proven delivery is attributed; a
 * forged one stays anonymous and is recorded as denied.
 */
export function bindIntegrationPrincipal(
  provider: string,
  target: { accountId?: string | null; projectId?: string | null } = {},
): void {
  bindAuditPrincipal({
    accountId: target.accountId,
    projectId: target.projectId,
    actorUserId: null,
    actorType: 'system',
    authoritativeSource: 'integration',
    authMethod: { kind: 'webhook_signature', provider },
  });
}

/**
 * Run one tick of a background job as the named worker.
 *
 * A timer, not a request, drives a worker, so no authenticator binds a
 * caller: every row a tick wrote defaulted to `actor_type: system, source:
 * api` and never named the job. The tick gets a FRESH request context (its
 * own request id, so its rows correlate) and a scope whose principal is the
 * worker. `recordAuditEvent` fills unset actor fields from it.
 *
 * Always a new context, never the caller's: a request handler that kicks a
 * drain (`drainSessionLifecycleQueue`, the app deployment worker) must not
 * lend its caller's identity to queued work that other principals enqueued.
 * The scope writes no request row.
 *
 * Wrap the tick function itself, not the timer, so an ad-hoc kick from a
 * handler runs as the worker too. `unit-worker-scope-wiring.test.ts` fails
 * when a background loop in `apps/api/src` is neither wrapped nor classified.
 */
export function runWorkerTick<T>(worker: string, tick: () => T | Promise<T>): Promise<T> {
  return requestContext.runWithContext('WORKER', worker, async () => {
    attachInboundAuditScope({
      owner: 'worker',
      method: 'WORKER',
      entrypoint: 'worker',
      route: `worker:${worker}`,
    });
    bindAuditPrincipal({
      actorUserId: null,
      actorType: 'system',
      authoritativeSource: 'worker',
      authMethod: { kind: 'worker', worker },
    });
    return tick();
  });
}
