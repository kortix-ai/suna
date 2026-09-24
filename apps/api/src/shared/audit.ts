import { createHash } from 'node:crypto';
import { type Database, auditEvents } from '@kortix/db';
import type { Context, Next } from 'hono';
import { getRequestContext, runWithContext } from '../lib/request-context';
import type { AppEnv } from '../types';
import { normalizeAuditClientSource } from './audit-client-source';
import { type AuditRow, getAuditQueue } from './audit-queue';
import { AnonymousAuditBudget, type AnonymousAuditSummary } from './audit-anonymous-budget';
import {
  type AuditPrincipal,
  type HonoIdentitySnapshot,
  type InboundAuditScope,
  type InboundEntrypoint,
  attachInboundAuditScope,
  currentInboundAuditScope,
  isUnauditedInbound,
} from './audit-scope';
import { db } from './db';
import { auditDb } from './audit-db';
import { resolveProjectAccountId } from './project-account-lookup';
import type { Actor } from '../iam/actor';
import { type AgentAuditAttribution, resolveAgentAuditAttribution } from './agent-audit-attribution';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** The human an agent session acted on behalf of (spec
   *  docs/specs/2026-09-22-agents-as-principals.md §2). Null otherwise. */
  onBehalfOfUserId?: string | null;
  parentEventId?: string | null;
  delegationDepth?: number;
  /** Compatibility alias. New writers should use authoritativeSource. */
  source?: string | null;
  authoritativeSource?: string | null;
  clientReportedSource?: string | null;
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

type AuditContext = Context<AppEnv>;

function pathIds(path: string): { projectId: string | null; sessionId: string | null } {
  const projectMatch = path.match(/\/projects\/([^/]+)/);
  const sessionMatch = path.match(/\/projects\/[^/]+\/sessions\/([^/]+)/);
  const projectId = projectMatch?.[1] && UUID_RE.test(projectMatch[1]) ? projectMatch[1] : null;
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
    return { resourceType: 'account_invite', resourceId: id && UUID_RE.test(id) ? id : null };
  }
  return {
    resourceType: root.replace(/-/g, '_').replace(/s$/, ''),
    // Arbitrary path values can be bearer capabilities (approval links,
    // setup links, public shares, device codes). Preserve UUID identifiers;
    // the matched route template in `action` still identifies every endpoint.
    resourceId: id && UUID_RE.test(id) ? id : null,
  };
}

function inferAccountId(c: AuditContext): string | null {
  const parts = c.req.path.split('/').filter(Boolean);
  const accountPathCandidate = parts[0] === 'v1' && parts[1] === 'accounts' ? parts[2] : null;
  const accountPathId =
    accountPathCandidate && UUID_RE.test(accountPathCandidate) ? accountPathCandidate : null;
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
    onBehalfOfUserIdVar: get('onBehalfOfUserId') as string | null | undefined,
    path: c.req.path,
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

export function inferAuditSource(c: AuditContext, actorType: AuditActorType | null): string {
  return auditSourceFor(c.get('authType'), actorType);
}

export function clientReportedAuditSource(c: AuditContext): string | null {
  return normalizeAuditClientSource(c.req.header('x-kortix-client'));
}

function outcomeForStatus(status: number): AuditOutcome {
  if (status === 202) return 'pending';
  if (status === 401 || status === 403) return 'denied';
  // 101: a WebSocket handshake that completed. The socket is open.
  if (status === 101 || (status >= 200 && status < 400)) return 'success';
  return 'failure';
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

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
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

function buildAuditRow(rawInput: AuditEventInput): AuditRow {
  const input = withInheritedPrincipal(rawInput);
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
    opencodeSessionId: input.opencodeSessionId ?? null,
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
    clientReportedSource: input.clientReportedSource ?? null,
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
  if (auditWritesAreSynchronous()) {
    await insertAuditEvent(auditDb(), input);
    return;
  }
  getAuditQueue(auditDb()).enqueue(buildAuditRow(input));
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

/** Drain buffered audit events. Called on shutdown and by tests. */
export async function flushAuditEvents(): Promise<void> {
  await settlePendingInboundEmissions();
  if (auditWritesAreSynchronous()) return;
  await getAuditQueue(auditDb()).flush();
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
    (projectId && UUID_RE.test(projectId)
      ? await resolveProjectAccountId(projectId).catch(() => null)
      : null);
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
  const inferred = hono
    ? inferResource(hono.path)
    : { resourceType: ENTRYPOINT_RESOURCE_TYPE[scope.entrypoint], resourceId: null };

  const metadata: Record<string, unknown> = {
    ...annotation.metadata,
    method: scope.method,
    path: route,
    ...(annotation.action ? { http: httpAction } : {}),
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
    clientReportedSource: normalizeAuditClientSource(scope.clientSourceHeader ?? undefined),
    outcome: annotation.outcome ?? outcomeForStatus(status),
    action: annotation.action ?? httpAction,
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

/**
 * Write the one row for an inbound request. Idempotent per scope, and never
 * throws: an audit failure must not fail the request it describes.
 */
export async function emitInboundAuditRow(scope: InboundAuditScope, status: number): Promise<void> {
  if (scope.emitted) return;
  scope.emitted = true;
  try {
    const input = await inboundAuditInput(scope, status);
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
    if (scope.entrypoint === 'http') scope.route = c.req.routePath || c.req.path;
    scope.status = thrown ? errorStatus(thrown) : c.res.status;
    scope.hono = honoIdentitySnapshot(c);
    if (scope.owner === 'hono') await emitInboundAuditRow(scope, scope.status);
  }
}

export const auditStateChangingRequest = auditApiRequest;
