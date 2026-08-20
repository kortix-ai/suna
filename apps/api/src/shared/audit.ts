import { createHash } from 'node:crypto';
import { type Database, auditEvents } from '@kortix/db';
import type { Context, Next } from 'hono';
import { getRequestContext } from '../lib/request-context';
import type { AppEnv } from '../types';
import { normalizeAuditClientSource } from './audit-client-source';
import { type AuditRow, getAuditQueue } from './audit-queue';
import { db } from './db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIPPED_PATHS = new Set(['/v1/health', '/v1/openapi.json', '/v1/docs']);

export type AuditActorType = 'human' | 'agent' | 'service_account' | 'system';
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

function clientIp(c: AuditContext): string | null {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null
  );
}

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

function projectSessionId(c: AuditContext, pathSessionId: string | null): string | null {
  if (pathSessionId) return pathSessionId;
  const authType = c.get('authType');
  if (authType === 'supabase') return null;
  return c.get('sessionId') ?? null;
}

function inferActorType(c: AuditContext, actorUserId: string | null): AuditActorType | null {
  const authType = c.get('authType');
  if (authType === 'service_account') return 'service_account';
  const hasAgentGrant = c.get('agentGrant') != null;
  const apiKeyType = c.get('apiKeyType');
  const hasProjectSession =
    authType !== 'supabase' && (c.get('sessionId') != null || hasAgentGrant);
  if (hasProjectSession || (authType === 'apiKey' && apiKeyType === 'sandbox')) return 'agent';
  if (actorUserId) return 'human';
  return inferAccountId(c) ? 'system' : null;
}

export function inferAuditSource(c: AuditContext, actorType: AuditActorType | null): string {
  if (actorType === 'service_account') return 'automation';
  if (actorType === 'agent') return 'agent';
  if (c.get('authType') === 'supabase') return 'human';
  if (c.get('authType') === 'apiKey') return 'api_key';
  return 'api';
}

export function clientReportedAuditSource(c: AuditContext): string | null {
  return normalizeAuditClientSource(c.req.header('x-kortix-client'));
}

function outcomeForStatus(status: number): AuditOutcome {
  if (status === 202) return 'pending';
  if (status === 401 || status === 403) return 'denied';
  if (status >= 200 && status < 400) return 'success';
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
function buildAuditRow(input: AuditEventInput): AuditRow {
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
function auditWritesAreSynchronous(): boolean {
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
    await insertAuditEvent(db, input);
    return;
  }
  getAuditQueue(db).enqueue(buildAuditRow(input));
}

/** Drain buffered audit events. Called on shutdown and by tests. */
export async function flushAuditEvents(): Promise<void> {
  if (auditWritesAreSynchronous()) return;
  await getAuditQueue(db).flush();
}

/** Flush and stop the flush timer. Shutdown path only. */
export async function shutdownAuditEvents(): Promise<void> {
  if (auditWritesAreSynchronous()) return;
  await getAuditQueue(db).shutdown();
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

export async function auditApiRequest(c: AuditContext, next: Next): Promise<void> {
  if (c.req.method === 'OPTIONS' || SKIPPED_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const startedAt = Date.now();
  let thrown: unknown;
  try {
    await next();
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const request = getRequestContext();
    const actorUserId = c.get('userId') ?? request?.userId ?? null;
    const accountId = inferAccountId(c);
    if (actorUserId || accountId) {
      const status = thrown ? errorStatus(thrown) : c.res.status;
      const inferred = inferResource(c.req.path);
      const ids = pathIds(c.req.path);
      const actorType = inferActorType(c, actorUserId);
      const auditPath = c.req.routePath || c.req.path;
      try {
        await recordAuditEvent({
          accountId,
          projectId: ids.projectId ?? request?.projectId ?? null,
          sessionId: projectSessionId(c, ids.sessionId ?? request?.sessionId ?? null),
          actorUserId,
          actorType,
          authoritativeSource: inferAuditSource(c, actorType),
          clientReportedSource: clientReportedAuditSource(c),
          outcome: outcomeForStatus(status),
          action: `${c.req.method} ${auditPath}`,
          resourceType: inferred.resourceType,
          resourceId: inferred.resourceId,
          httpStatus: status,
          durationMs: Date.now() - startedAt,
          requestId: request?.requestId ?? null,
          traceId: request?.traceId ?? null,
          correlationId:
            c.req.header('x-correlation-id') || c.req.header('idempotency-key') || null,
          ip: clientIp(c),
          userAgent: c.req.header('user-agent') || null,
          metadata: {
            method: c.req.method,
            path: auditPath,
          },
        });
      } catch (error) {
        console.error('[audit] Failed to record API request:', error);
      }
    }
  }
}

export const auditStateChangingRequest = auditApiRequest;
