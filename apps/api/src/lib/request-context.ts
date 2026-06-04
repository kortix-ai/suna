/**
 * Request-scoped context using AsyncLocalStorage.
 *
 * Provides automatic context propagation for structured logging.
 * Any code running within a request lifecycle can call getRequestContext()
 * to get the current userId, accountId, sandboxId, requestId, etc.
 *
 * The logger and console.error patch automatically attach these fields
 * to every log — no manual passing needed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

export interface RequestContext {
  /** Unique ID for this request (for tracing across logs) */
  requestId: string;
  /** W3C trace ID for cross-service trace propagation */
  traceId: string;
  /** Span ID for this API request */
  spanId: string;
  /** Upstream parent span ID, when the caller supplied a valid traceparent */
  parentSpanId?: string;
  /** W3C trace flags */
  traceFlags: string;
  /** Normalized W3C traceparent header for downstream calls */
  traceparent: string;
  /** HTTP method */
  method: string;
  /** Request path */
  path: string;
  /** Supabase user ID (set after auth middleware) */
  userId?: string;
  /** Kortix account ID (set after auth middleware) */
  accountId?: string;
  /** User email (set after auth middleware) */
  userEmail?: string;
  /** Kortix project ID (set by route middleware/handlers when known) */
  projectId?: string;
  /** Kortix project session ID (set by route middleware/handlers when known) */
  sessionId?: string;
  /** Sandbox ID (set by route handlers that operate on a sandbox) */
  sandboxId?: string;
  /** Extra fields that route handlers can attach */
  [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

let counter = 0;

const LOG_FIELD_ALIASES: Record<string, string> = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  parentSpanId: 'parent_span_id',
  traceFlags: 'trace_flags',
  userId: 'user_id',
  accountId: 'account_id',
  userEmail: 'user_email',
  projectId: 'project_id',
  sessionId: 'session_id',
  sandboxId: 'sandbox_id',
};

/**
 * Generate a short request ID: timestamp prefix + counter.
 * Not globally unique (use trace IDs for that), but unique enough
 * to correlate logs within a single API instance.
 */
function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const seq = (counter++).toString(36);
  return `${ts}-${seq}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function parseTraceparent(value?: string | null): Pick<RequestContext, 'traceId' | 'parentSpanId' | 'traceFlags'> | null {
  if (!value) return null;

  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) return null;

  const [, traceId, parentSpanId, traceFlags] = match;
  if (traceId === ZERO_TRACE_ID || parentSpanId === ZERO_SPAN_ID) return null;

  return { traceId, parentSpanId, traceFlags };
}

function createTraceContext(incomingTraceparent?: string | null): Pick<RequestContext, 'traceId' | 'spanId' | 'parentSpanId' | 'traceFlags' | 'traceparent'> {
  const parsed = parseTraceparent(incomingTraceparent);
  const traceId = parsed?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const traceFlags = parsed?.traceFlags ?? '01';

  return {
    traceId,
    spanId,
    parentSpanId: parsed?.parentSpanId,
    traceFlags,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
}

/**
 * Run a function within a request context.
 * Called by the Hono middleware at the start of every request.
 */
export function runWithContext<T>(method: string, path: string, fn: () => T, incomingTraceparent?: string | null): T {
  const trace = createTraceContext(incomingTraceparent);
  const ctx: RequestContext = {
    requestId: generateRequestId(),
    ...trace,
    method,
    path,
  };
  return storage.run(ctx, fn);
}

/**
 * Get the current request context (or undefined if not in a request).
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Set a field on the current request context.
 * Call this from auth middleware, route handlers, etc.
 *
 *   setContextField('userId', user.id);
 *   setContextField('sandboxId', sandbox.id);
 */
export function setContextField(key: string, value: string): void {
  const ctx = storage.getStore();
  if (ctx) {
    ctx[key] = value;
  }
}

/**
 * Get headers that should be forwarded to downstream services.
 */
export function getTraceHeaders(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};

  return {
    traceparent: ctx.traceparent,
    'X-Request-Id': ctx.requestId,
  };
}

/**
 * Get loggable fields from the current context.
 * Returns only defined fields (no undefined values cluttering logs).
 */
export function getContextFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined) {
      fields[key] = value;
      const alias = LOG_FIELD_ALIASES[key];
      if (alias) fields[alias] = value;
    }
  }
  return fields;
}
