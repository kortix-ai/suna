import { createHash } from 'node:crypto';
import { type Database, auditEvents } from '@kortix/db';
import {
  type AuditRouteLabel,
  auditLabelForEntrypoint,
  auditLabelForRoute,
  UNMATCHED_ROUTE_LABEL,
} from '@kortix/shared/audit-labels';
import { getRequestContext } from '../../lib/request-context';
import { type AuditRow, getAuditQueue } from './audit-queue';
import { AnonymousAuditBudget, type AnonymousAuditSummary } from './audit-anonymous-budget';
import {
  type AuditPrincipal,
  type HonoIdentitySnapshot,
  type InboundAuditScope,
  type InboundEntrypoint,
  currentInboundAuditScope,
} from './audit-scope';
import { db } from '../../lib/db';
import { auditDb } from './audit-db';
import { resolveProjectAccountId } from '../accounts/project-account-lookup';
import type { Actor } from '../iam/actor';
import { type AgentAuditAttribution, resolveAgentAuditAttribution } from './agent-audit-attribution';
import { isUuid } from '../../lib/validate';

/** `anonymous`: nothing authenticated the request (a 401, a public route). */
export type AuditActorType = 'human' | 'agent' | 'service_account' | 'system' | 'anonymous';
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'pending';

export interface AuditEventInput {
  accountId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  opencodeSessionId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  toolCallId?: string | null;
  executionId?: string | null;
  actorUserId?: string | null;
  actorType?: AuditActorType | null;
  agentId?: string | null;
  agentName?: string | null;
  initiatorActorType?: string | null;
  initiatorActorId?: string | null;
  /** The human an agent session acted on behalf of. Null otherwise. */
  onBehalfOfUserId?: string | null;
  parentEventId?: string | null;
  delegationDepth?: number;
  /** Compatibility alias. New writers should use authoritativeSource. */
  source?: string | null;
  authoritativeSource?: string | null;
  /** What the API authenticated. Never client-reported. */
  credentialKind?: string | null;
  credentialId?: string | null;
  outcome?: AuditOutcome | null;
  action: string;
  phase?: string;
  resourceType: string;
  resourceId?: string | null;
  httpStatus?: number | null;
  durationMs?: number | null;
  requestId?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  sourceLedger?: string | null;
  sourceRecordId?: string | null;
  sourceRevision?: string | null;
  inputSummary?: Record<string, unknown> | null;
  outputSummary?: Record<string, unknown> | null;
  inputSha256?: string | null;
  outputSha256?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

function pathIds(path: string): { projectId: string | null; sessionId: string | null } {
  const projectMatch = path.match(/\/projects\/([^/]+)/);
  const sessionMatch = path.match(/\/projects\/[^/]+\/sessions\/([^/]+)/);
  const projectId = projectMatch?.[1] && isUuid(projectMatch[1]) ? projectMatch[1] : null;
  return {
    projectId,
    sessionId: sessionMatch?.[1] ?? null,
  };
}

function inferResource(path: string): { resourceType: string; resourceId: string | null } {
  const ids = pathIds(path);
  if (ids.sessionId) return { resourceType: 'project_session', resourceId: ids.sessionId };
  if (ids.projectId) return { resourceType: 'project', resourceId: ids.projectId };

  const parts = path.split('/').filter(Boolean);
  const v1Index = parts.indexOf('v1');
  const root = v1Index >= 0 ? parts[v1Index + 1] : parts[0];
  const id = v1Index >= 0 ? parts[v1Index + 2] : parts[1];

  if (!root) return { resourceType: 'unknown', resourceId: null };
  if (root === 'p') return { resourceType: 'sandbox_proxy', resourceId: id ?? null };
  if (root === 'account-invites') {
    return { resourceType: 'account_invite', resourceId: isUuid(id) ? id : null };
  }
  return {
    resourceType: root.replace(/-/g, '_').replace(/s$/, ''),
    // Arbitrary path values can be bearer capabilities (approval links,
    // setup links, public shares, device codes). Preserve UUID identifiers;
    // the matched route template in `action` still identifies every endpoint.
    resourceId: isUuid(id) ? id : null,
  };
}

function sessionIdForSnapshot(
  snapshot: HonoIdentitySnapshot,
  pathSessionId: string | null,
): string | null {
  if (pathSessionId) return pathSessionId;
  if (snapshot.authType === 'supabase') return null;
  return snapshot.sessionIdVar;
}

function actorTypeForSnapshot(
  snapshot: HonoIdentitySnapshot,
  actorUserId: string | null,
): AuditActorType | null {
  const { authType } = snapshot;
  if (authType === 'service_account') return 'service_account';
  const hasProjectSession =
    authType !== 'supabase' && (snapshot.sessionIdVar != null || snapshot.hasAgentGrant);
  if (hasProjectSession || (authType === 'apiKey' && snapshot.apiKeyType === 'sandbox')) {
    return 'agent';
  }
  if (actorUserId) return 'human';
  return snapshot.accountId ? 'system' : null;
}

function auditSourceFor(authType: string | undefined, actorType: AuditActorType | null): string {
  if (actorType === 'service_account') return 'automation';
  if (actorType === 'agent') return 'agent';
  if (authType === 'supabase') return 'human';
  if (authType === 'apiKey') return 'api_key';
  return 'api';
}

export function inferAuditSource(authType: string | undefined, actorType: AuditActorType | null): string {
  return auditSourceFor(authType, actorType);
}

function outcomeForStatus(status: number): AuditOutcome {
  if (status === 202) return 'pending';
  if (status === 401 || status === 403) return 'denied';
  // 101: a WebSocket handshake that completed. The socket is open.
  if (status === 101 || (status >= 200 && status < 400)) return 'success';
  return 'failure';
}

function uuidOrNull(value: string | null | undefined): string | null {
  return isUuid(value) ? value : null;
}

const SECRET_VALUE_RE =
  /(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|gh[opusr]_[a-z0-9_]{12,}|kortix_(?:pat|sbx)_[a-z0-9_-]+|(?:token|secret|password|api[_-]?key)=\S+)/i;
const CONTENT_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'args',
  'arguments',
  'authorization',
  'body',
  'client_secret',
  'command',
  'content',
  'cookie',
  'credential',
  'data',
  'env',
  'environment',
  'error',
  'error_message',
  'headers',
  'input',
  'message',
  'output',
  'password',
  'payload',
  'prompt',
  'query',
  'refresh_token',
  'request_body',
  'response',
  'response_body',
  'result',
  'secret',
  'stack',
  'text',
  'token',
  'transcript',
  'value',
  'value_enc',
]);

const MAX_AUDIT_STRING_CHARS = 512;
const MAX_AUDIT_COLLECTION_ITEMS = 100;
const MAX_AUDIT_RECORD_BYTES = 64 * 1024;

function sha256(value: unknown): string {
  // lgtm[js/insufficient-password-hash] This digest fingerprints audit content. It never verifies passwords.
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
}

function isContentKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, '_');
  return (
    CONTENT_KEYS.has(normalized) ||
    /_(?:access_token|api_key|authorization|client_secret|credential|password|refresh_token)$/.test(
      normalized,
    )
  );
}

function isUrlKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, '_');
  return normalized === 'url' || normalized.endsWith('_url');
}

function sanitizeAuditUrl(value: string): { origin?: string; sha256: string } {
  const fingerprint = sha256(value);
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? { sha256: fingerprint } : { origin, sha256: fingerprint };
  } catch {
    return { sha256: fingerprint };
  }
}

function sanitizeAuditValue(value: unknown, key = '', depth = 0): unknown {
  if (isContentKey(key)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string' && isUrlKey(key)) return sanitizeAuditUrl(value);
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) return '[REDACTED]';
    if (value.length > MAX_AUDIT_STRING_CHARS) {
      return { redacted: true, length: value.length, sha256: sha256(value) };
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= 8) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_AUDIT_COLLECTION_ITEMS)
      .map((item) => sanitizeAuditValue(item, '', depth + 1));
  }
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_AUDIT_COLLECTION_ITEMS)
      .map(([childKey, child]) => [childKey, sanitizeAuditValue(child, childKey, depth + 1)]),
  );
}

function sanitizeAuditRecord(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (value == null) return null;
  const sanitized = sanitizeAuditValue(value) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') <= MAX_AUDIT_RECORD_BYTES) {
    return sanitized;
  }
  return {
    redacted: true,
    reason: 'oversized',
    sha256: sha256(value),
  };
}

type AuditInsertClient = Pick<Database, 'insert'>;
type AuditTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Build the row synchronously, at emit time.
 *
 * This MUST stay separate from the write: `recordAuditEvent` enqueues and the
 * flusher writes hundreds of milliseconds later, by which point the request's
 * AsyncLocalStorage scope (`getRequestContext()`) has ended and the caller may
 * have mutated `input`. Everything context- or caller-derived is resolved here.
 */
const INHERITED_IDENTITY_FIELDS = [
  'actorUserId',
  'agentId',
  'agentName',
  'onBehalfOfUserId',
  'initiatorActorType',
  'initiatorActorId',
] as const;

/**
 * Fill what an explicit event left out from the principal its request already
 * proved — so a domain row written inside a self-authenticating surface (a
 * SCIM user change, a webhook-driven action) names the same caller as the
 * request row, without every call site passing it by hand.
 *
 * Only `undefined` is filled; an explicit value, `null` included, always wins.
 * Identity is inherited as a unit: a caller that names an `actorType` gets no
 * user or agent fields with it, so a `system` row can never carry a user.
 * Outside a request there is no principal and nothing changes.
 */
function withInheritedPrincipal(input: AuditEventInput): AuditEventInput {
  const principal = currentInboundAuditScope()?.principal;
  if (!principal) return input;
  const out: AuditEventInput = { ...input };
  if (out.accountId === undefined && principal.accountId != null) out.accountId = principal.accountId;
  if (out.projectId === undefined && principal.projectId != null) out.projectId = principal.projectId;
  if (out.authoritativeSource === undefined && out.source === undefined && principal.authoritativeSource) {
    out.authoritativeSource = principal.authoritativeSource;
  }
  // The credential proved the request, whoever the row names as its actor.
  if (out.credentialKind === undefined && principal.credentialKind) {
    out.credentialKind = principal.credentialKind;
    if (out.credentialId === undefined) out.credentialId = principal.credentialId;
  }
  if (out.actorType === undefined && principal.actorType != null) {
    out.actorType = principal.actorType;
    for (const key of INHERITED_IDENTITY_FIELDS) {
      if (out[key] === undefined && principal[key] !== undefined) out[key] = principal[key];
    }
    if (principal.authMethod && !(out.metadata && 'auth' in out.metadata)) {
      out.metadata = { ...out.metadata, auth: principal.authMethod };
    }
  }
  return out;
}

/**
 * An event written while a request runs happened in that request: it carries
 * the request's IP and user agent, unless it names its own.
 * A worker tick has no request, so its scope lends none.
 */
function withRequestTransport(input: AuditEventInput): AuditEventInput {
  const scope = currentInboundAuditScope();
  if (!scope || scope.owner === 'worker') return input;
  return {
    ...input,
    ip: input.ip || scope.ip,
    userAgent: input.userAgent ?? scope.userAgent,
  };
}

function buildAuditRow(rawInput: AuditEventInput): AuditRow {
  const input = withRequestTransport(withInheritedPrincipal(rawInput));
  const request = getRequestContext();
  const authoritativeSource = input.authoritativeSource ?? input.source ?? 'api';
  const inputSummary = sanitizeAuditRecord(input.inputSummary);
  const outputSummary = sanitizeAuditRecord(input.outputSummary);
  const before = sanitizeAuditRecord(input.before);
  const after = sanitizeAuditRecord(input.after);
  const metadata = sanitizeAuditRecord(input.metadata) ?? {};
  return {
    accountId: uuidOrNull(input.accountId || request?.accountId),
    projectId: uuidOrNull(input.projectId || request?.projectId),
    sessionId: input.sessionId || request?.sessionId || null,
    runtimeSessionId: input.opencodeSessionId ?? null,
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    toolCallId: input.toolCallId ?? null,
    executionId: input.executionId ?? null,
    actorUserId: uuidOrNull(input.actorUserId),
    actorType: input.actorType ?? (input.actorUserId ? 'human' : 'system'),
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    initiatorActorType: input.initiatorActorType ?? null,
    initiatorActorId: input.initiatorActorId ?? null,
    onBehalfOfUserId: uuidOrNull(input.onBehalfOfUserId),
    parentEventId: uuidOrNull(input.parentEventId),
    delegationDepth: input.delegationDepth ?? 0,
    source: authoritativeSource,
    authoritativeSource,
    credentialKind: input.credentialKind ?? null,
    credentialId: input.credentialId ?? null,
    outcome: input.outcome ?? 'success',
    action: input.action,
    phase: input.phase ?? 'completed',
    resourceType: input.resourceType,
    resourceId: input.resourceId || null,
    httpStatus: input.httpStatus ?? null,
    durationMs: input.durationMs ?? null,
    requestId: input.requestId || request?.requestId || null,
    traceId: input.traceId || request?.traceId || null,
    correlationId: input.correlationId || null,
    causationId: input.causationId ?? null,
    sourceLedger: input.sourceLedger ?? null,
    sourceRecordId: input.sourceRecordId ?? null,
    sourceRevision: input.sourceRevision ?? null,
    inputSummary,
    outputSummary,
    inputSha256: input.inputSha256 ?? (input.inputSummary ? sha256(input.inputSummary) : null),
    outputSha256:
      input.outputSha256 ??
      (input.outputSummary
        ? sha256(input.outputSummary)
        : input.errorMessage
          ? sha256(input.errorMessage)
          : null),
    errorCode: input.errorCode ?? null,
    // Provider and runtime errors can echo prompts, credentials, or response
    // bodies. Preserve `errorCode` and a SHA-256 fingerprint only.
    errorMessage: null,
    before,
    after,
    ip: input.ip || null,
    userAgent:
      typeof input.userAgent === 'string' && SECRET_VALUE_RE.test(input.userAgent)
        ? '[REDACTED]'
        : input.userAgent || null,
    metadata,
  };
}

/**
 * Single-row, synchronous insert. Still used by `runAuditedTransaction` (which
 * must write inside the caller's transaction) and by the synchronous test mode.
 * The `.returning()` is what makes the statement awaited by the transaction, so
 * a failed audit write still rolls the mutation back.
 */
async function insertAuditEvent(client: AuditInsertClient, input: AuditEventInput): Promise<void> {
  await client
    .insert(auditEvents)
    .values(buildAuditRow(input))
    .returning({ eventId: auditEvents.eventId });
}

/**
 * Synchronous emission is kept for tests, which read the row back immediately
 * after the action that produced it. `KORTIX_AUDIT_SYNC=1` forces it anywhere;
 * `KORTIX_AUDIT_SYNC=0` forces the queue on under a test runner.
 */
export function auditWritesAreSynchronous(): boolean {
  const flag = process.env.KORTIX_AUDIT_SYNC;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return process.env.NODE_ENV === 'test';
}

/**
 * Emit one audit event.
 *
 * Returns as soon as the row is buffered — the INSERT happens on the flusher,
 * off the request path. The signature stays `Promise<void>` so the ~74 existing
 * call sites are unchanged, and a write failure can no longer surface as a
 * rejected promise in a request handler.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  const scope = currentInboundAuditScope();
  if (auditWritesAreSynchronous()) {
    await insertAuditEvent(auditDb(), input);
  } else {
    getAuditQueue(auditDb()).enqueue(buildAuditRow(input));
  }
  if (scope && scope.owner !== 'worker') scope.recordedActions.add(input.action);
}

/**
 * Request rows the edge is still building. The edge writes a request's row
 * AFTER it has handed the response back (attribution can need a lookup), so a
 * flush must wait for those rows to reach the queue first — otherwise
 * `GET /audit` could miss the request that immediately preceded it.
 */
const pendingInboundEmissions = new Set<Promise<void>>();

export function trackInboundAuditEmission(emission: Promise<void>): void {
  pendingInboundEmissions.add(emission);
  void emission.finally(() => pendingInboundEmissions.delete(emission));
}

async function settlePendingInboundEmissions(): Promise<void> {
  if (pendingInboundEmissions.size === 0) return;
  await Promise.allSettled([...pendingInboundEmissions]);
}

/**
 * How long a READ route's flush barrier may wait.
 *
 * A read route awaits `flushAuditEvents()` for read-your-writes. Each snapshot
 * chains onto the in-flight one, so while the audit pool's INSERT is slow (cold
 * cache IO, up to the 10 s statement timeout) the barrier can wait far past the
 * request deadline: prod,
 * 2026-09-28 — `GET /v1/accounts/:id/audit` answered 16× 503 "25s deadline" +
 * 3× 57014 statement timeouts in one minute while its workspace's audit ingest
 * was contended (KRTX-631). Read routes therefore pass this bound: a healthy
 * flush completes well inside the queue's 250 ms cadence, and when the convoy
 * is backing up the read proceeds while the queue keeps retrying in the
 * background — audit completeness is already best-effort by design.
 */
export const AUDIT_READ_FLUSH_BARRIER_MS = 2_000;

/**
 * Drain buffered audit events.
 *
 * Called on shutdown and by tests without `waitMs` — the drain waits for the
 * queue to finish. Read routes pass `waitMs` (see
 * {@link AUDIT_READ_FLUSH_BARRIER_MS}): losing that race leaves the flush
 * running, and the queue's write never rejects, so the abandoned barrier only
 * keeps working in the background.
 */
export async function flushAuditEvents(options?: { waitMs?: number }): Promise<void> {
  const waitMs = options?.waitMs;
  const barrier = async (): Promise<void> => {
    await settlePendingInboundEmissions();
    if (auditWritesAreSynchronous()) return;
    await getAuditQueue(auditDb()).flush();
  };
  if (!waitMs) {
    await barrier();
    return;
  }
  await Promise.race([
    barrier(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]);
}

/** Flush and stop the flush timer. Shutdown path only. */
export async function shutdownAuditEvents(): Promise<void> {
  await settlePendingInboundEmissions();
  const suppressed = anonymousBudget.drainSummary(Date.now());
  if (suppressed) {
    await recordAuditEvent(anonymousSummaryEvent(suppressed)).catch((error) => {
      console.error('[audit] Failed to record the anonymous-traffic summary:', error);
    });
  }
  if (auditWritesAreSynchronous()) return;
  await getAuditQueue(auditDb()).shutdown();
}

/**
 * Deliberately NOT queued. The whole point of this helper is that the audit row
 * commits atomically with the operation it describes, so it must stay inside the
 * transaction. Only 5 call sites use it and none are on a hot path.
 */
export async function runAuditedTransaction<T>(
  operation: (tx: AuditTransaction) => Promise<T>,
  event: (result: T) => AuditEventInput,
): Promise<T> {
  const committed = await db.transaction(async (tx) => {
    const result = await operation(tx);
    await insertAuditEvent(tx, event(result));
    return result;
  });
  return committed;
}

/**
 * Agent attribution for the credential the Hono auth middleware resolved, or
 * null when the request did not authenticate with an agent-session token.
 * Never throws: audit enrichment must not fail the audited request.
 */
async function agentAttributionForSnapshot(
  snapshot: HonoIdentitySnapshot,
): Promise<AgentAuditAttribution | null> {
  const actor = snapshot.actor as Actor | undefined;
  const credential = actor?.credential;
  if (!credential || credential.kind !== 'agent_session') return null;
  try {
    return await resolveAgentAuditAttribution({
      sessionId: credential.sessionId ?? snapshot.sessionIdVar ?? null,
      serviceAccountId: credential.serviceAccountId,
      agentName: credential.agentGrant?.agent ?? null,
      agentPrincipal: credential.agentPrincipal === true,
      tokenUserId: snapshot.tokenUserId,
      onBehalfOfUserId:
        snapshot.onBehalfOfUserIdVar !== undefined
          ? snapshot.onBehalfOfUserIdVar
          : (credential.onBehalfOfUserId ?? null),
    });
  } catch (error) {
    console.error('[audit] agent attribution failed:', error);
    return null;
  }
}

/**
 * The bound principal with its deferred lookup applied. Runs at write time, so
 * a slow lookup never holds the response; a failed one keeps what was bound.
 */
async function principalWithLateAttribution(principal: AuditPrincipal): Promise<AuditPrincipal> {
  const { lateAttribution, ...bound } = principal;
  if (!lateAttribution) return bound;
  try {
    const late = await lateAttribution();
    if (!late) return bound;
    const merged: AuditPrincipal = { ...bound };
    for (const [key, value] of Object.entries(late)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return merged;
  } catch (error) {
    console.error('[audit] deferred attribution failed:', error);
    return bound;
  }
}

/** The resource a non-Hono entrypoint acts on, when no handler said more. */
const ENTRYPOINT_RESOURCE_TYPE: Record<InboundEntrypoint, string> = {
  http: 'unknown',
  preview_origin: 'sandbox_preview_origin',
  app_origin: 'app',
  ws_upgrade: 'websocket',
  worker: 'worker',
};

/**
 * The audit label of the request's route (`@kortix/shared/audit-labels`):
 * the matched endpoint for a request Hono routed, the class name for one the
 * server dispatched before Hono, and a fixed label when no endpoint matched.
 * Null for a route the catalog does not know; its row keeps `METHOD /route`.
 */
function routeLabel(scope: InboundAuditScope): AuditRouteLabel | null {
  if (scope.entrypoint !== 'http') return scope.route ? auditLabelForEntrypoint(scope.route) : null;
  return scope.route ? auditLabelForRoute(scope.method, scope.route) : UNMATCHED_ROUTE_LABEL;
}

/**
 * The row for one inbound request. Precedence, per field: what an
 * authenticator bound or a handler annotated, then what the Hono auth
 * middleware put on the context, then the request context. A request with no
 * identity from any of them is `anonymous`.
 */
async function inboundAuditInput(
  scope: InboundAuditScope,
  status: number,
): Promise<AuditEventInput> {
  const request = getRequestContext();
  const hono = scope.hono;
  const bound = await principalWithLateAttribution(scope.principal);
  const annotation = scope.annotation;
  const ids = hono ? pathIds(hono.path) : { projectId: null, sessionId: null };
  const agent = hono ? await agentAttributionForSnapshot(hono) : null;
  const tokenUserId = hono?.tokenUserId ?? null;

  const actorUserId =
    bound.actorUserId !== undefined ? bound.actorUserId : agent ? agent.actorUserId : tokenUserId;
  const projectId =
    bound.projectId !== undefined ? bound.projectId : (ids.projectId ?? request?.projectId ?? null);
  // A row that names a project but no account belongs to the project's owner;
  // without this it lands in nobody's log. Never guess: no project, no account.
  const accountId =
    (bound.accountId !== undefined
      ? bound.accountId
      : (hono?.accountId ?? request?.accountId ?? scope.queryAccountId ?? null)) ??
    (isUuid(projectId) ? await resolveProjectAccountId(projectId).catch(() => null) : null);
  // `system` means an account-level credential with no user — an account API
  // key the auth middleware resolved. An account a route merely bound (the
  // project an invalid token was aimed at) proves no caller: `anonymous`.
  const actorType: AuditActorType =
    bound.actorType ??
    (hono ? actorTypeForSnapshot(hono, tokenUserId) : null) ??
    (actorUserId ? 'human' : hono?.accountId ? 'system' : 'anonymous');
  const source =
    bound.authoritativeSource ??
    (actorType === 'anonymous' ? 'anonymous' : auditSourceFor(hono?.authType, actorType));

  // Hono stamps the matched template; other entrypoints name their class.
  // Never the raw path: path segments can be bearer capabilities.
  const route = scope.route ?? '<unmatched>';
  const httpAction = `${scope.method} ${route}`;
  const action = annotation.action ?? routeLabel(scope)?.action ?? httpAction;
  const inferred = hono
    ? inferResource(hono.path)
    : { resourceType: ENTRYPOINT_RESOURCE_TYPE[scope.entrypoint], resourceId: null };

  const metadata: Record<string, unknown> = {
    ...annotation.metadata,
    method: scope.method,
    path: route,
    ...(action !== httpAction ? { http: httpAction } : {}),
    ...(scope.entrypoint !== 'http' ? { entrypoint: scope.entrypoint } : {}),
    ...(bound.authMethod ? { auth: bound.authMethod } : {}),
  };

  return {
    accountId,
    projectId,
    sessionId:
      bound.sessionId !== undefined
        ? bound.sessionId
        : hono
          ? sessionIdForSnapshot(hono, ids.sessionId ?? request?.sessionId ?? null)
          : null,
    actorUserId,
    actorType,
    agentId: bound.agentId !== undefined ? bound.agentId : agent?.agentId,
    agentName: bound.agentName !== undefined ? bound.agentName : agent?.agentName,
    onBehalfOfUserId:
      bound.onBehalfOfUserId !== undefined ? bound.onBehalfOfUserId : agent?.onBehalfOfUserId,
    initiatorActorType:
      bound.initiatorActorType !== undefined
        ? bound.initiatorActorType
        : agent?.initiatorActorType,
    initiatorActorId:
      bound.initiatorActorId !== undefined ? bound.initiatorActorId : agent?.initiatorActorId,
    authoritativeSource: source,
    credentialKind: bound.credentialKind ?? hono?.credential.credentialKind ?? null,
    credentialId:
      bound.credentialKind !== undefined
        ? (bound.credentialId ?? null)
        : (hono?.credential.credentialId ?? null),
    outcome: annotation.outcome ?? outcomeForStatus(status),
    action,
    resourceType: annotation.resourceType ?? inferred.resourceType,
    resourceId: annotation.resourceId !== undefined ? annotation.resourceId : inferred.resourceId,
    httpStatus: status,
    durationMs: Date.now() - scope.startedAt,
    requestId: request?.requestId ?? null,
    traceId: request?.traceId ?? null,
    correlationId: scope.correlationId,
    ip: scope.ip,
    userAgent: scope.userAgent,
    metadata,
  };
}

const anonymousBudget = new AnonymousAuditBudget({
  perSecond: AnonymousAuditBudget.perSecondFromEnv(process.env.KORTIX_AUDIT_ANONYMOUS_PER_SECOND),
  summaryEveryMs: 60_000,
});

function anonymousSummaryEvent(summary: AnonymousAuditSummary): AuditEventInput {
  return {
    actorType: 'system',
    authoritativeSource: 'audit',
    action: 'audit.anonymous.suppressed',
    resourceType: 'audit',
    outcome: 'success',
    metadata: {
      window_start: new Date(summary.windowStartMs).toISOString(),
      window_end: new Date(summary.windowEndMs).toISOString(),
      suppressed: summary.suppressed,
      by_status_class: summary.byStatusClass,
    },
  };
}

/** Route-label action of `POST /v1/projects/:p/sessions/:s/audit/events` (packages/shared audit-route-labels). */
const AUDIT_INGEST_ACTION = 'audit.session.ingest';

/**
 * Write the one row for an inbound request. Idempotent per scope, and never
 * throws: an audit failure must not fail the request it describes.
 */
export async function emitInboundAuditRow(scope: InboundAuditScope, status: number): Promise<void> {
  if (scope.emitted) return;
  scope.emitted = true;
  try {
    const input = await inboundAuditInput(scope, status);
    // The handler already wrote this request's event, and the request
    // succeeded: that event is the row. It is either the route's own action
    // (`iam.group.create`, with the group in `after`) or one the route label
    // lists (`secret.strategy.changed`, recorded only for a real change). A
    // failed or refused request keeps its own row, with the status.
    const standIns = [input.action, ...(routeLabel(scope)?.events ?? [])];
    if (status < 400 && standIns.some((action) => scope.recordedActions.has(action))) return;
    // The sandbox relay's own delivery of audit events is not an action: the
    // events it carries are the record. A row per batch (one per 10 s per busy
    // session) only added load on the table it writes to. A refused or failed
    // batch (status >= 400) keeps its row.
    if (status < 400 && input.action === AUDIT_INGEST_ACTION) return;
    // A deployed app's public traffic is the customer's end users, not a
    // principal acting on the account. A signed-in viewer is still audited.
    if (scope.entrypoint === 'app_origin' && input.actorType === 'anonymous') return;
    // Every anonymous row is budgeted, including one that resolved to a
    // tenant through the project in its URL: an outsider who knows a project
    // id sends that request at will, and each row can reach the account's
    // audit webhooks.
    if (input.actorType === 'anonymous') {
      const decision = anonymousBudget.admit(Date.now(), status);
      if (decision.summary) await recordAuditEvent(anonymousSummaryEvent(decision.summary));
      if (!decision.admit) return;
    }
    await recordAuditEvent(input);
  } catch (error) {
    console.error('[audit] Failed to record inbound request:', error);
  }
}
