import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface OpenCodeAuditEvent {
  event_id: string;
  /** Stable identity for one observed emission. Retries preserve it. */
  source_revision: string;
  type: string;
  occurred_at: string;
  opencode_session_id: string | null;
  turn_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  execution_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  delegation_depth: number;
  outcome: 'success' | 'failure' | 'denied' | 'pending';
  phase: string;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown> | null;
  input_sha256: string;
  output_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const SECRET_VALUE =
  /(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|gh[opusr]_[a-z0-9_]{12,}|kortix_(?:pat|sbx)_[a-z0-9_-]+|(?:token|secret|password|api[_-]?key)=\S+)/i;
const SAFE_KEYS = new Set([
  'id',
  'sessionID',
  'sessionId',
  'session_id',
  'parentID',
  'parentId',
  'messageID',
  'messageId',
  'partID',
  'partId',
  'callID',
  'callId',
  'toolCallID',
  'toolCallId',
  'executionID',
  'executionId',
  'tool',
  'name',
  'status',
  'role',
  'type',
  'path',
  'filename',
  'mime',
  'size',
  'bytes',
  'duration',
  'durationMs',
  'agent',
  'agentID',
  'agentId',
  'agentName',
  'depth',
  'multiple',
  'custom',
  'count',
  // OpenCode wraps the safe identity and lifecycle fields below in these
  // objects. Raw prompt, input, output, error text, and arbitrary metadata are
  // still excluded by the recursive allowlist.
  'session',
  'message',
  'part',
  'info',
  'error',
  'state',
  'time',
  'start',
  'end',
  'created',
  'completed',
  'updated',
  'compacting',
  'archived',
  'providerID',
  'modelID',
  'mode',
  'delivery',
]);
const STRUCTURAL_WRAPPER_KEYS = new Set(['session', 'message', 'part', 'info', 'error', 'state']);

const EVENT_FIELDS = new Set([
  'event_id',
  'source_revision',
  'type',
  'occurred_at',
  'opencode_session_id',
  'turn_id',
  'message_id',
  'tool_call_id',
  'execution_id',
  'agent_id',
  'agent_name',
  'correlation_id',
  'causation_id',
  'delegation_depth',
  'outcome',
  'phase',
  'input_summary',
  'output_summary',
  'input_sha256',
  'output_sha256',
  'error_code',
  'error_message',
  'metadata',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

function isSafePersistedSummary(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_KEYS.has(key)) return false;
    if (STRUCTURAL_WRAPPER_KEYS.has(key)) {
      if (!isSafePersistedSummary(child, depth + 1)) return false;
      continue;
    }
    if (child === null || typeof child === 'boolean') continue;
    if (typeof child === 'number' && Number.isFinite(child)) continue;
    if (typeof child === 'string' && child.length <= 512 && !SECRET_VALUE.test(child)) continue;
    if (isSafePersistedSummary(child, depth + 1)) continue;
    return false;
  }
  return true;
}

function isPersistedOpenCodeAuditEvent(value: unknown): value is OpenCodeAuditEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some((key) => !EVENT_FIELDS.has(key))) return false;
  const nullableIdentifiers = [
    'opencode_session_id',
    'turn_id',
    'message_id',
    'tool_call_id',
    'execution_id',
    'agent_id',
    'agent_name',
    'correlation_id',
    'causation_id',
    'error_code',
  ];
  if (
    !SHA256_RE.test(String(event.event_id ?? '')) ||
    typeof event.source_revision !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(event.source_revision) ||
    typeof event.type !== 'string' ||
    !/^[a-z0-9_.:-]{1,128}$/i.test(event.type) ||
    typeof event.occurred_at !== 'string' ||
    Number.isNaN(new Date(event.occurred_at).getTime()) ||
    nullableIdentifiers.some(
      (key) => event[key] !== null && (typeof event[key] !== 'string' || event[key].length > 256),
    ) ||
    !Number.isInteger(event.delegation_depth) ||
    Number(event.delegation_depth) < 0 ||
    Number(event.delegation_depth) > 100 ||
    !['success', 'failure', 'denied', 'pending'].includes(String(event.outcome)) ||
    typeof event.phase !== 'string' ||
    !/^[a-z0-9_.:-]{1,32}$/i.test(event.phase) ||
    !isSafePersistedSummary(event.input_summary) ||
    (event.output_summary !== null && !isSafePersistedSummary(event.output_summary)) ||
    !SHA256_RE.test(String(event.input_sha256 ?? '')) ||
    (event.output_sha256 !== null && !SHA256_RE.test(String(event.output_sha256))) ||
    event.error_message !== null
  ) {
    return false;
  }
  if (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) {
    return false;
  }
  const metadata = event.metadata as Record<string, unknown>;
  if (Object.keys(metadata).some((key) => key !== 'event_type' && key !== 'property_keys')) {
    return false;
  }
  return (
    typeof metadata.event_type === 'string' &&
    metadata.event_type === event.type &&
    Array.isArray(metadata.property_keys) &&
    metadata.property_keys.length <= 64 &&
    metadata.property_keys.every(
      (key) => typeof key === 'string' && /^[a-z0-9_.:-]{1,128}$/i.test(key),
    )
  );
}

function originOnlyUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function safeScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const origin = originOnlyUrl(value);
  if (origin) return origin;
  if (SECRET_VALUE.test(value)) return '[REDACTED]';
  return value.slice(0, 512);
}

function structuralSummary(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (STRUCTURAL_WRAPPER_KEYS.has(key)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        result[key] = structuralSummary(child, depth + 1);
      }
      continue;
    }
    if (SAFE_KEYS.has(key)) {
      if (Array.isArray(child)) result[key] = { count: child.length };
      else if (child && typeof child === 'object')
        result[key] = structuralSummary(child, depth + 1);
      else result[key] = safeScalar(child);
      continue;
    }
    if (
      child &&
      typeof child === 'object' &&
      ['session', 'message', 'part', 'error', 'info'].includes(key)
    ) {
      result[key] = structuralSummary(child, depth + 1);
    }
  }
  return result;
}

function firstString(object: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value) return value.slice(0, 256);
  }
  return null;
}

function nestedObject(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = object[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function sanitizeOpenCodeEvent(
  raw: { type?: string; properties?: unknown },
  observedAt = new Date(),
): OpenCodeAuditEvent | null {
  const type =
    typeof raw.type === 'string' && /^[a-z0-9_.:-]{1,128}$/i.test(raw.type) ? raw.type : null;
  if (!type) return null;
  const properties =
    raw.properties && typeof raw.properties === 'object'
      ? (raw.properties as Record<string, unknown>)
      : {};
  const session = nestedObject(properties, 'session');
  const info = nestedObject(properties, 'info');
  const explicitMessage = nestedObject(properties, 'message');
  const message = Object.keys(explicitMessage).length > 0 ? explicitMessage : info;
  const part = nestedObject(properties, 'part');
  const state = nestedObject(part, 'state');
  const propertyError = nestedObject(properties, 'error');
  const messageError = nestedObject(message, 'error');
  const error = Object.keys(propertyError).length > 0 ? propertyError : messageError;
  const errorData = nestedObject(error, 'data');
  const opencodeSessionId =
    firstString(properties, ['sessionID', 'sessionId', 'session_id']) ??
    firstString(session, ['id', 'sessionID']) ??
    firstString(message, ['sessionID', 'sessionId']);
  const messageId =
    firstString(properties, ['messageID', 'messageId']) ??
    firstString(message, ['id', 'messageID']) ??
    firstString(part, ['messageID', 'messageId']);
  const toolCallId =
    firstString(properties, ['callID', 'callId', 'toolCallID', 'toolCallId']) ??
    firstString(part, ['callID', 'callId', 'toolCallID', 'toolCallId']);
  const executionId = firstString(properties, ['executionID', 'executionId']) ?? toolCallId;
  const turnId = firstString(properties, ['turnID', 'turnId']) ?? messageId;
  const agentId =
    firstString(properties, ['agentID', 'agentId']) ?? firstString(message, ['agent']);
  const agentName =
    firstString(properties, ['agentName', 'agent']) ?? firstString(message, ['agent']);
  const status =
    firstString(properties, ['status']) ??
    firstString(part, ['status']) ??
    firstString(state, ['status']);
  const response = firstString(properties, ['response']);
  const isError = type.includes('error') || status === 'error' || Object.keys(error).length > 0;
  const isPending =
    type.endsWith('.asked') ||
    type.endsWith('.pending') ||
    status === 'pending' ||
    status === 'running';
  const isDenied =
    type.includes('denied') ||
    type.includes('rejected') ||
    status === 'denied' ||
    response === 'reject';
  const messageTime = nestedObject(message, 'time');
  const phase = (() => {
    if (isDenied) return 'denied';
    if (isError) return 'failed';
    if (status === 'pending' || status === 'running' || status === 'completed') return status;
    if (isPending) return 'pending';
    if (typeof messageTime.completed === 'number') return 'completed';
    if (type.endsWith('.created')) return 'created';
    if (type.endsWith('.removed') || type.endsWith('.deleted')) return 'removed';
    if (type.endsWith('.updated')) return 'updated';
    return 'completed';
  })();
  const rawInput =
    state.input ??
    properties.input ??
    properties.args ??
    properties.arguments ??
    properties.prompt ??
    null;
  const rawOutput = state.output ?? state.error ?? properties.output ?? properties.result ?? null;
  const canonical = { type, properties };
  const eventId = sha256(canonical);
  const errorMessageRaw = errorData.message ?? error.message;
  const fingerprintedOutput = rawOutput ?? errorMessageRaw ?? null;
  return {
    event_id: eventId,
    source_revision: randomUUID(),
    type,
    occurred_at: observedAt.toISOString(),
    opencode_session_id: opencodeSessionId,
    turn_id: turnId,
    message_id: messageId,
    tool_call_id: toolCallId,
    execution_id: executionId,
    agent_id: agentId,
    agent_name: agentName,
    correlation_id: null,
    causation_id: null,
    delegation_depth: Number.isInteger(properties.depth)
      ? Math.max(0, Math.min(Number(properties.depth), 100))
      : 0,
    outcome: isDenied ? 'denied' : isError ? 'failure' : isPending ? 'pending' : 'success',
    phase,
    input_summary: structuralSummary(properties),
    output_summary:
      fingerprintedOutput == null
        ? null
        : {
            type: rawOutput == null ? 'error' : typeof rawOutput,
            ...(Array.isArray(rawOutput) ? { count: rawOutput.length } : {}),
          },
    input_sha256: sha256(rawInput ?? canonical),
    output_sha256: fingerprintedOutput == null ? null : sha256(fingerprintedOutput),
    error_code:
      firstString(error, ['name', 'code']) ?? (status === 'error' ? 'ToolExecutionError' : null),
    error_message: null,
    metadata: { event_type: type, property_keys: Object.keys(properties).sort().slice(0, 64) },
  };
}

export interface AuditRelayStats {
  /** Events refused at the source because their class is on `dropTypes`. */
  dropped: number;
  /** Events superseded in the pending queue by a newer identical state. */
  coalesced: number;
  /** Events the API accepted. A rejected batch is not counted until it lands. */
  sent: number;
  /** Accepted POSTs. `sent / posts` is the achieved batch size. */
  posts: number;
}

export interface AuditRelay {
  enqueue(raw: { type?: string; properties?: unknown }): void;
  flush(): Promise<void>;
  stop(options?: { flush?: boolean }): Promise<void>;
  stats(): AuditRelayStats;
}

/**
 * EMISSION CONTRACT — how many POSTs one sandbox is allowed to cost.
 * ------------------------------------------------------------------
 * Measured on Essentia 2026-08-26: POST
 * `/v1/projects/:p/sessions/:s/audit/events` ran 3,395 times across 20 session
 * opens in one hour — 680 ms median, 2,265 s cumulative, the single largest
 * line in the whole performance corpus. One local session
 * (`08891820-0cd9-4fe7-bcfd-2431375ff75d`, `kortix.audit_events`) shows the
 * mechanism: 117,437 relayed OpenCode events in 64 minutes, and the relay's own
 * access log records 4,848 POSTs for that ONE session.
 *
 * The volume was never batched away because the relay forwarded EVERY OpenCode
 * SSE event 1:1 (`main.ts` `onEvent` -> `enqueue`) at `batchSize = 50`. Three
 * rules now bound it, in the order they apply:
 *
 * 1. DROP a class that carries no audited fact (`dropTypes`). Two qualify, and
 *    together they are 91.7% of that session's traffic:
 *      - `message.part.delta` (107,394 rows / 91.4%) is one row per streamed
 *        TOKEN. The token itself is stripped by `sanitizeOpenCodeEvent`, so the
 *        persisted row is identity + hashes and nothing a reconstruction can
 *        use. The API already names this the one droppable class
 *        (`shared/opencode-audit-rate-guard.ts:62`) — it just dropped it AFTER
 *        paying for the network hop, the two scope queries and the insert.
 *      - `server.heartbeat` (384 rows) is a daemon liveness ping: no actor, no
 *        resource, no state change.
 *    Dropping happens BEFORE `sanitizeOpenCodeEvent` and before `persist()`, so
 *    it also removes 91.7% of the spool's fsyncs from the sandbox's hot path.
 *
 * 2. COALESCE repeats, never transitions (`coalesceTypes`). A streaming text
 *    part emits one `message.part.updated` per chunk; every one of them has the
 *    same session, message, part, phase and outcome, and differs only in a
 *    timestamp and a hash of content that is deliberately not persisted. The
 *    coalesce key includes `phase` and `outcome`, so a tool part walking
 *    pending -> running -> completed keeps all three rows, and permission,
 *    question, error, file and lifecycle classes are not on the list at all.
 *    The survivor is the NEWEST state and it takes the tail position, so
 *    `occurred_at` stays monotonic inside a batch.
 *
 * 3. BATCH what is left: one POST per `batchSize` events or per `flushMs`,
 *    whichever comes first — the timer runs from the OLDEST pending event, so
 *    a steady stream cannot keep postponing a flush. `batchSize` defaults to
 *    the API's own ceiling
 *    (`MAX_BATCH_SIZE = 200`, `shared/opencode-audit-ingestion.ts:10`) and is
 *    clamped to it, so a misconfigured env can never produce a 400. The route
 *    still writes in 25-row chunks server-side, so a 200-event POST costs the
 *    same insert work as four 50-event POSTs but ONE auth pass and ONE pair of
 *    scope queries.
 *
 * Nothing here weakens delivery: the spool is still fsynced per accepted event,
 * `stop()` still drains, and a 503 + Retry-After still backs off on the
 * existing ladder.
 */

/** The API rejects a batch larger than this (`MAX_BATCH_SIZE`). */
export const MAX_RELAY_BATCH_SIZE = 200;
export const DEFAULT_BATCH_SIZE = MAX_RELAY_BATCH_SIZE;
/**
 * Upper bound on how long an accepted event waits for company.
 *
 * After rule 1 a busy session emits ~190 events/min (12,083 kept events over
 * the 64-minute reference session), so a 200-event batch takes ~63 s to fill:
 * the relay is cadence-bound, not batch-bound, and this number alone decides
 * the POST rate. Measured on the reference trace: 2 s -> 1,040 POSTs, 5 s ->
 * 588, 10 s -> 318, against 4,848 POSTs actually recorded for that session.
 *
 * Measured POSTs for that session by `flushMs` (same trace, same relay):
 *   500 ms (old default, no rule 1/2)  2,462   median batch 50
 *   2 s                                1,040   median batch 11
 *   5 s                                  588   median batch 17
 *   10 s (this default)                  318   median batch 26
 *   30 s                                  121   median batch 64
 *   60 s                                   62   median batch 118
 * An operator can move to 30 s with `KORTIX_AUDIT_RELAY_FLUSH_MS=30000` during
 * an incident without a daemon release.
 *
 * 10 s is affordable because `kortix.audit_events` has NO real-time consumer.
 * The approval gate and the question relay run on the live OpenCode SSE stream
 * and `relayQuestionToApi` (main.ts), not on this ledger; what reads the ledger
 * is the IAM audit log, the session audit panel, exports and the SIEM webhook.
 * Nothing is lost by waiting: the spool is fsynced per accepted event and
 * `stop()` drains it on SIGTERM/SIGINT.
 */
export const DEFAULT_FLUSH_MS = 10_000;

/** Raw OpenCode event types the relay never forwards. See rule 1 above. */
export const DEFAULT_DROPPED_EVENT_TYPES: readonly string[] = [
  'message.part.delta',
  'server.heartbeat',
];

/** Raw types whose same-state repeats collapse in the queue. See rule 2. */
export const DEFAULT_COALESCED_EVENT_TYPES: readonly string[] = [
  'message.updated',
  'message.part.updated',
  'session.status',
  'session.updated',
  'session.diff',
  'catalog.updated',
  'file.watcher.updated',
];

/**
 * Two events collapse only when they are the same class, about the same thing,
 * in the same lifecycle phase, with the same outcome. Any transition changes
 * `phase` or `outcome` and therefore survives.
 */
export function coalesceKey(event: OpenCodeAuditEvent): string {
  const part = event.input_summary.part;
  const partObject =
    part && typeof part === 'object' && !Array.isArray(part)
      ? (part as Record<string, unknown>)
      : {};
  return [
    event.type,
    event.opencode_session_id ?? '',
    event.message_id ?? '',
    typeof partObject.id === 'string' ? partObject.id : '',
    typeof partObject.type === 'string' ? partObject.type : '',
    event.tool_call_id ?? '',
    event.phase,
    event.outcome,
  ].join('|');
}

export interface AuditRelayConfig {
  batchSize: number;
  flushMs: number;
  dropTypes: string[];
  coalesceTypes: string[];
}

function typeList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined) return [...fallback];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Every knob in the contract above, readable from the sandbox environment so an
 * incident can be tuned without a daemon release.
 *
 * - `KORTIX_AUDIT_RELAY_BATCH_SIZE` — 1..200, clamped. Default 200.
 * - `KORTIX_AUDIT_RELAY_FLUSH_MS`   — >0 ms. Default 10000.
 * - `KORTIX_AUDIT_RELAY_DROP_TYPES` — comma list; empty string drops nothing.
 * - `KORTIX_AUDIT_RELAY_COALESCE`   — `0`/`false`/`off` disables rule 2, or a
 *   comma list to replace the coalesced set outright.
 */
export function auditRelayConfigFromEnv(env: NodeJS.ProcessEnv): AuditRelayConfig {
  const rawBatch = Number.parseInt(env.KORTIX_AUDIT_RELAY_BATCH_SIZE || '', 10);
  const batchSize =
    Number.isFinite(rawBatch) && rawBatch > 0
      ? Math.min(rawBatch, MAX_RELAY_BATCH_SIZE)
      : DEFAULT_BATCH_SIZE;
  const rawFlush = Number.parseInt(env.KORTIX_AUDIT_RELAY_FLUSH_MS || '', 10);
  const flushMs = Number.isFinite(rawFlush) && rawFlush > 0 ? rawFlush : DEFAULT_FLUSH_MS;
  const coalesceRaw = env.KORTIX_AUDIT_RELAY_COALESCE;
  const coalesceOff =
    coalesceRaw !== undefined && ['0', 'false', 'off', 'no'].includes(coalesceRaw.trim().toLowerCase());
  return {
    batchSize,
    flushMs,
    dropTypes: typeList(env.KORTIX_AUDIT_RELAY_DROP_TYPES, DEFAULT_DROPPED_EVENT_TYPES),
    coalesceTypes: coalesceOff
      ? []
      : typeList(coalesceRaw, DEFAULT_COALESCED_EVENT_TYPES),
  };
}

/**
 * How far back a coalesce lookup scans. Bounds the per-event cost even when a
 * recovered spool hands the relay a queue with a very large backlog.
 */
const COALESCE_SCAN_LIMIT = 1_000;

const DEFAULT_MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const MAX_LINEAGE_DEPTH = 100;

interface SessionLineage {
  session_id: string;
  parent_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
}

interface AuditSpoolV2 {
  version: 2;
  queue: OpenCodeAuditEvent[];
  lineage: SessionLineage[];
}

const LINEAGE_FIELDS = new Set(['session_id', 'parent_id', 'agent_id', 'agent_name']);
const LINEAGE_IDENTIFIER_RE = /^[a-z0-9_.:/@-]{1,256}$/i;

function isNullableLineageIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && LINEAGE_IDENTIFIER_RE.test(value));
}

function isSessionLineage(value: unknown): value is SessionLineage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).every((key) => LINEAGE_FIELDS.has(key)) &&
    typeof entry.session_id === 'string' &&
    LINEAGE_IDENTIFIER_RE.test(entry.session_id) &&
    isNullableLineageIdentifier(entry.parent_id) &&
    isNullableLineageIdentifier(entry.agent_id) &&
    isNullableLineageIdentifier(entry.agent_name)
  );
}

function lineageUpdate(
  raw: { type?: string; properties?: unknown },
  sessionId: string | null,
): Partial<SessionLineage> | null {
  if (!sessionId || (raw.type !== 'session.created' && raw.type !== 'session.updated')) return null;
  const properties =
    raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, unknown>)
      : {};
  const info = nestedObject(properties, 'info');
  const session = nestedObject(properties, 'session');
  const sources = [properties, info, session];
  const update: Partial<SessionLineage> = { session_id: sessionId };
  for (const source of sources) {
    for (const key of ['parentID', 'parentId']) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (value === null || (typeof value === 'string' && LINEAGE_IDENTIFIER_RE.test(value))) {
        update.parent_id = value;
      }
    }
  }
  const agent =
    firstString(properties, ['agentID', 'agentId', 'agentName', 'agent']) ??
    firstString(info, ['agentID', 'agentId', 'agentName', 'agent']) ??
    firstString(session, ['agentID', 'agentId', 'agentName', 'agent']);
  if (agent && LINEAGE_IDENTIFIER_RE.test(agent)) {
    update.agent_id = agent;
    update.agent_name = agent;
  }
  return update;
}

function applyLineage(
  event: OpenCodeAuditEvent,
  sessions: ReadonlyMap<string, SessionLineage>,
): OpenCodeAuditEvent {
  const sessionId = event.opencode_session_id;
  if (!sessionId) return event;
  const current = sessions.get(sessionId);
  const immediateParent = current?.parent_id ?? null;
  let root = sessionId;
  let depth = 0;
  let cursor = sessionId;
  const visited = new Set<string>([cursor]);
  while (depth < MAX_LINEAGE_DEPTH) {
    const parent = sessions.get(cursor)?.parent_id ?? null;
    if (!parent || visited.has(parent)) break;
    root = parent;
    depth += 1;
    visited.add(parent);
    cursor = parent;
  }
  return {
    ...event,
    agent_id: event.agent_id ?? current?.agent_id ?? null,
    agent_name: event.agent_name ?? current?.agent_name ?? null,
    correlation_id: root,
    causation_id: immediateParent,
    delegation_depth: depth,
  };
}

/** The ingestion route accepts only the sandbox credential. The session PAT is
 * intentionally excluded even when both credentials exist in the runtime. */
export function auditRelayToken(env: NodeJS.ProcessEnv): string | null {
  return (env.KORTIX_TOKEN || '').trim() || null;
}

/**
 * Backoff after a rejected batch.
 *
 * A flat 1s retry is an amplifier, not a recovery. When the API rejects a batch
 * because `kortix.audit_events` inserts are queued on that session's
 * `audit_session_sequences` row lock, retrying one second later re-enters the
 * same lock queue and keeps it alive — Essentia 2026-08-26 held that livelock
 * for three hours (445 rejections, one roughly every 11s per stuck session,
 * each costing the API a full 10s statement_timeout). Double the wait each
 * time up to `maxRetryMs`, jitter it +/-25% so two sandboxes never
 * resynchronize, and never undercut a `Retry-After` the server asked for.
 */
export function computeRetryDelay(input: {
  retryMs: number;
  maxRetryMs: number;
  /** Consecutive failures INCLUDING the one being backed off from (1-based). */
  failures: number;
  /** A sample in [0, 1). */
  jitter: number;
  serverRetryAfterMs: number | null;
}): number {
  const exponential = Math.min(
    input.retryMs * 2 ** Math.max(0, input.failures - 1),
    input.maxRetryMs,
  );
  const jittered = Math.round(exponential * (0.75 + input.jitter * 0.5));
  return Math.max(jittered, input.serverRetryAfterMs ?? 0);
}

/** Ceiling on the relay's exponential retry backoff. */
export const MAX_RETRY_MS_DEFAULT = 30_000;

/**
 * A rejected batch can carry the server's own backoff. `main.ts` attaches
 * `retryAfterMs` from the 503's `Retry-After` header; anything else backs off
 * on the relay's own schedule.
 */
export function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function createAuditRelay(
  send: (events: OpenCodeAuditEvent[]) => Promise<void>,
  options: {
    batchSize?: number;
    flushMs?: number;
    retryMs?: number;
    maxRetryMs?: number;
    /** Injected for tests; production uses Math.random. */
    jitter?: () => number;
    spoolPath?: string;
    maxSpoolBytes?: number;
    /** Raw OpenCode types never forwarded. Defaults to `DEFAULT_DROPPED_EVENT_TYPES`. */
    dropTypes?: readonly string[];
    /** Raw OpenCode types whose same-state repeats collapse. Empty disables rule 2. */
    coalesceTypes?: readonly string[];
  } = {},
): AuditRelay {
  const batchSize = Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_RELAY_BATCH_SIZE);
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const dropTypes = new Set(options.dropTypes ?? DEFAULT_DROPPED_EVENT_TYPES);
  const coalesceTypes = new Set(options.coalesceTypes ?? DEFAULT_COALESCED_EVENT_TYPES);
  const stats: AuditRelayStats = { dropped: 0, coalesced: 0, sent: 0, posts: 0 };
  const retryMs = options.retryMs ?? 1_000;
  const maxRetryMs = options.maxRetryMs ?? MAX_RETRY_MS_DEFAULT;
  const jitter = options.jitter ?? Math.random;
  const spoolPath = options.spoolPath?.trim() || null;
  const maxSpoolBytes = options.maxSpoolBytes ?? DEFAULT_MAX_SPOOL_BYTES;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('audit relay batchSize must be a positive integer');
  }
  if (!Number.isSafeInteger(maxSpoolBytes) || maxSpoolBytes < 1) {
    throw new Error('audit relay maxSpoolBytes must be a positive integer');
  }
  let spoolWrite = 0;
  const sessions = new Map<string, SessionLineage>();
  const persist = () => {
    if (!spoolPath) return;
    const spool: AuditSpoolV2 = { version: 2, queue, lineage: [...sessions.values()] };
    const serialized = JSON.stringify(spool);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxSpoolBytes) {
      throw new Error(`OpenCode audit spool capacity exceeded: ${bytes} > ${maxSpoolBytes} bytes`);
    }
    const spoolDirectory = dirname(spoolPath);
    mkdirSync(spoolDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${spoolPath}.${process.pid}.${spoolWrite++}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, serialized, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, spoolPath);
      const directoryFd = openSync(spoolDirectory, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  };
  const load = (): AuditSpoolV2 => {
    if (!spoolPath || !existsSync(spoolPath)) return { version: 2, queue: [], lineage: [] };
    const serialized = readFileSync(spoolPath, 'utf8');
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxSpoolBytes) {
      throw new Error(`OpenCode audit spool capacity exceeded: ${bytes} > ${maxSpoolBytes} bytes`);
    }
    const parsed: unknown = JSON.parse(serialized);
    // V1 spools were arrays. Accept them so an in-place relay upgrade never
    // discards an already sanitized, unsent event.
    if (Array.isArray(parsed)) {
      const queue = parsed.map((event) =>
        event && typeof event === 'object' && !Array.isArray(event)
          ? { correlation_id: null, causation_id: null, ...event }
          : event,
      );
      if (queue.some((event) => !isPersistedOpenCodeAuditEvent(event))) {
        throw new Error(`invalid OpenCode audit spool: ${spoolPath}`);
      }
      return { version: 2, queue: queue as OpenCodeAuditEvent[], lineage: [] };
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`invalid OpenCode audit spool: ${spoolPath}`);
    }
    const spool = parsed as Record<string, unknown>;
    if (
      spool.version !== 2 ||
      Object.keys(spool).some((key) => !['version', 'queue', 'lineage'].includes(key)) ||
      !Array.isArray(spool.queue) ||
      spool.queue.some((event) => !isPersistedOpenCodeAuditEvent(event)) ||
      !Array.isArray(spool.lineage) ||
      spool.lineage.length > 100_000 ||
      spool.lineage.some((entry) => !isSessionLineage(entry))
    ) {
      throw new Error(`invalid OpenCode audit spool: ${spoolPath}`);
    }
    return spool as unknown as AuditSpoolV2;
  };
  const recovered = load();
  const queue: OpenCodeAuditEvent[] = recovered.queue;
  // Coalesce keys held in lockstep with `queue`. Never persisted: it is
  // recomputed from the recovered events, so an in-place relay upgrade keeps
  // the same contract without a spool version bump.
  const queueKeys: string[] = queue.map((event) =>
    coalesceTypes.has(event.type) ? coalesceKey(event) : '',
  );
  for (const entry of recovered.lineage) sessions.set(entry.session_id, entry);
  // Head of `queue` currently being POSTed. Coalescing must never rewrite a
  // row that is already on the wire.
  let inFlight = 0;
  let flushing: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;

  const retryDelay = (serverRetryAfterMs: number | null): number =>
    computeRetryDelay({
      retryMs,
      maxRetryMs,
      failures: consecutiveFailures,
      jitter: jitter(),
      serverRetryAfterMs,
    });

  const schedule = (delay = flushMs) => {
    if (stopped || timer || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => {});
    }, delay);
  };

  const flush = async (): Promise<void> => {
    if (flushing) return flushing;
    if (queue.length === 0) return;
    const batch = queue.slice(0, batchSize);
    inFlight = batch.length;
    flushing = (async () => {
      try {
        await send(batch);
        consecutiveFailures = 0;
        stats.sent += batch.length;
        stats.posts += 1;
        queue.splice(0, batch.length);
        queueKeys.splice(0, batch.length);
        persist();
      } catch (error) {
        consecutiveFailures += 1;
        schedule(retryDelay(retryAfterMs(error)));
        throw error;
      } finally {
        inFlight = 0;
        flushing = null;
        // `schedule` is a no-op while a timer is already pending, so the
        // backoff armed by the catch above survives this line. Without that,
        // the `queue.length >= batchSize ? 0 : flushMs` fast path would cancel
        // every backoff exactly when the spool is full — which is exactly when
        // the server is overloaded.
        if (queue.length > 0) schedule(queue.length >= batchSize ? 0 : flushMs);
      }
    })();
    return flushing;
  };

  const relay: AuditRelay = {
    enqueue(raw) {
      if (stopped) return;
      // Rule 1 — refused at the source, before sanitizing and before the spool
      // fsync this event would otherwise cost.
      if (typeof raw.type === 'string' && dropTypes.has(raw.type)) {
        stats.dropped += 1;
        return;
      }
      const sanitized = sanitizeOpenCodeEvent(raw);
      if (!sanitized) return;
      const update = lineageUpdate(raw, sanitized.opencode_session_id);
      const sessionId = sanitized.opencode_session_id;
      const previous = sessionId ? sessions.get(sessionId) : undefined;
      if (update && sessionId) {
        sessions.set(sessionId, {
          session_id: sessionId,
          parent_id:
            update.parent_id !== undefined ? update.parent_id : (previous?.parent_id ?? null),
          agent_id: update.agent_id !== undefined ? update.agent_id : (previous?.agent_id ?? null),
          agent_name:
            update.agent_name !== undefined ? update.agent_name : (previous?.agent_name ?? null),
        });
      }
      const event = applyLineage(sanitized, sessions);
      // Rule 2 — a pending event about the same thing, in the same phase, with
      // the same outcome is superseded by this one. Bounded reverse scan, and
      // never into the batch already on the wire.
      const key = coalesceTypes.has(event.type) ? coalesceKey(event) : '';
      let supersededAt = -1;
      if (key) {
        const from = Math.max(inFlight, queue.length - COALESCE_SCAN_LIMIT);
        for (let i = queue.length - 1; i >= from; i -= 1) {
          if (queueKeys[i] === key) {
            supersededAt = i;
            break;
          }
        }
      }
      const superseded = supersededAt >= 0 ? queue[supersededAt] : null;
      if (supersededAt >= 0) {
        queue.splice(supersededAt, 1);
        queueKeys.splice(supersededAt, 1);
      }
      queue.push(event);
      queueKeys.push(key);
      try {
        persist();
      } catch (error) {
        queue.pop();
        queueKeys.pop();
        if (superseded) {
          queue.splice(supersededAt, 0, superseded);
          queueKeys.splice(supersededAt, 0, key);
        }
        if (update && sessionId) {
          if (previous) sessions.set(sessionId, previous);
          else sessions.delete(sessionId);
        }
        throw error;
      }
      if (superseded) stats.coalesced += 1;
      if (queue.length >= batchSize) void flush().catch(() => {});
      else schedule();
    },
    flush,
    stats: () => ({ ...stats }),
    async stop(stopOptions = {}) {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (stopOptions.flush === false) return;
      while (queue.length > 0) await flush();
    },
  };
  schedule();
  return relay;
}
