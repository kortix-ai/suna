import type { auditEvents } from '@kortix/db';

const SHA256_RE = /^[0-9a-f]{64}$/;
const EVENT_TYPE_RE = /^[a-z0-9_.:-]{1,128}$/i;
const IDENTIFIER_RE = /^[a-z0-9_.:/@-]{1,256}$/i;
const PHASE_RE = /^[a-z0-9_.:-]{1,32}$/i;
const ERROR_CODE_RE = /^[a-z0-9_.:-]{1,256}$/i;
const OUTCOMES = new Set(['success', 'failure', 'denied', 'pending']);
const INITIATOR_TYPES = new Set(['human', 'agent', 'service_account', 'system']);
const MAX_BATCH_SIZE = 200;
const MAX_SUMMARY_BYTES = 16_384;
const SECRET_VALUE_RE =
  /(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|gh[opusr]_[a-z0-9_]{12,}|kortix_(?:pat|sbx)_[a-z0-9_-]+|(?:token|secret|password|api[_-]?key)=\S+)/i;

const SUMMARY_KEYS = new Set([
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
  'session',
  'message',
  'part',
  'error',
  'info',
  'count',
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

type AuditInsert = typeof auditEvents.$inferInsert;

export interface OpenCodeAuditScope {
  accountId: string;
  projectId: string;
  sessionId: string;
}

export interface ParsedOpenCodeAuditBatch {
  accepted: number;
  values: AuditInsert[];
}

function fail(index: number, message: string): never {
  throw new Error(`events[${index}] ${message}`);
}

function optionalIdentifier(value: unknown, index: number, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    fail(index, `has an invalid ${field}`);
  }
  return value;
}

function sanitizeSummary(
  value: unknown,
  index: number,
  field: 'input_summary' | 'output_summary',
): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(index, `has an invalid ${field}`);
  }
  let nodes = 0;
  const originOnlyUrl = (candidate: string): string | null => {
    try {
      const parsed = new URL(candidate);
      return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ? parsed.origin : null;
    } catch {
      return null;
    }
  };
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 256 || depth > 4) fail(index, `has an oversized ${field}`);
    if (candidate == null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) fail(index, `has an invalid ${field}`);
      return candidate;
    }
    if (typeof candidate === 'string') {
      if (candidate.length > 512) fail(index, `has an oversized ${field}`);
      const origin = originOnlyUrl(candidate);
      if (origin) return origin;
      if (SECRET_VALUE_RE.test(candidate)) {
        fail(index, `has a credential-shaped ${field} value`);
      }
      return candidate;
    }
    if (Array.isArray(candidate)) fail(index, `has an invalid ${field}`);
    if (typeof candidate !== 'object') fail(index, `has an invalid ${field}`);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (!SUMMARY_KEYS.has(key)) fail(index, `has a disallowed ${field} key: ${key}`);
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  const sanitized = visit(value, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_SUMMARY_BYTES) {
    fail(index, `has an oversized ${field}`);
  }
  return sanitized;
}

function sanitizeMetadata(value: unknown, index: number): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(index, 'has invalid metadata');
  }
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key !== 'event_type' && key !== 'property_keys') {
      fail(index, `has a disallowed metadata key: ${key}`);
    }
  }
  if (input.event_type != null) {
    if (typeof input.event_type !== 'string' || !EVENT_TYPE_RE.test(input.event_type)) {
      fail(index, 'has invalid metadata.event_type');
    }
    result.event_type = input.event_type;
  }
  if (input.property_keys != null) {
    if (
      !Array.isArray(input.property_keys) ||
      input.property_keys.length > 64 ||
      input.property_keys.some(
        (key) => typeof key !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(key),
      )
    ) {
      fail(index, 'has invalid metadata.property_keys');
    }
    result.property_keys = [...input.property_keys];
  }
  return result;
}

function requiredSha256(value: unknown, index: number, field: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail(index, `has an invalid ${field}`);
  }
  return value;
}

function optionalSha256(value: unknown, index: number, field: string): string | null {
  if (value == null) return null;
  return requiredSha256(value, index, field);
}

function canonicalOpenCodeAction(
  type: string,
  inputSummary: Record<string, unknown> | null,
): string {
  if (type !== 'message.part.updated') return `opencode.${type}`;
  const part = inputSummary?.part;
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const partType = (part as Record<string, unknown>).type;
    if (partType === 'tool') return 'opencode.tool.updated';
    if (typeof partType === 'string' && EVENT_TYPE_RE.test(partType)) {
      return `opencode.message.part.${partType}.updated`;
    }
  }
  return `opencode.${type}`;
}

export function parseOpenCodeAuditBatch(
  body: unknown,
  scope: OpenCodeAuditScope,
): ParsedOpenCodeAuditBatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be an object');
  }
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH_SIZE) {
    throw new Error(`events must contain 1 to ${MAX_BATCH_SIZE} items`);
  }

  const values = events.map((item, index): AuditInsert => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(index, 'is invalid');
    }
    const event = item as Record<string, unknown>;
    const eventId = requiredSha256(event.event_id, index, 'event_id');
    const type =
      typeof event.type === 'string' && EVENT_TYPE_RE.test(event.type)
        ? event.type
        : fail(index, 'has an invalid type');
    const occurredAt = new Date(String(event.occurred_at ?? ''));
    if (
      typeof event.occurred_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        event.occurred_at,
      ) ||
      Number.isNaN(occurredAt.getTime())
    ) {
      fail(index, 'has an invalid occurred_at');
    }
    const outcome = event.outcome ?? 'success';
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      fail(index, 'has an invalid outcome');
    }
    const phase = event.phase ?? 'completed';
    if (typeof phase !== 'string' || !PHASE_RE.test(phase)) {
      fail(index, 'has an invalid phase');
    }
    const initiatorActorType = event.initiator_actor_type ?? null;
    if (
      initiatorActorType != null &&
      (typeof initiatorActorType !== 'string' || !INITIATOR_TYPES.has(initiatorActorType))
    ) {
      fail(index, 'has an invalid initiator_actor_type');
    }
    const delegationDepth = event.delegation_depth ?? 0;
    if (
      typeof delegationDepth !== 'number' ||
      !Number.isInteger(delegationDepth) ||
      delegationDepth < 0 ||
      delegationDepth > 100
    ) {
      fail(index, 'has an invalid delegation_depth');
    }
    const errorCode = event.error_code ?? null;
    if (errorCode != null && (typeof errorCode !== 'string' || !ERROR_CODE_RE.test(errorCode))) {
      fail(index, 'has an invalid error_code');
    }

    const inputSummary = sanitizeSummary(event.input_summary, index, 'input_summary');
    const outputSummary = sanitizeSummary(event.output_summary, index, 'output_summary');

    return {
      accountId: scope.accountId,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      opencodeSessionId: optionalIdentifier(
        event.opencode_session_id,
        index,
        'opencode_session_id',
      ),
      turnId: optionalIdentifier(event.turn_id, index, 'turn_id'),
      messageId: optionalIdentifier(event.message_id, index, 'message_id'),
      toolCallId: optionalIdentifier(event.tool_call_id, index, 'tool_call_id'),
      executionId: optionalIdentifier(event.execution_id, index, 'execution_id'),
      actorType: 'agent',
      agentId: optionalIdentifier(event.agent_id, index, 'agent_id'),
      agentName: optionalIdentifier(event.agent_name, index, 'agent_name'),
      initiatorActorType,
      initiatorActorId: optionalIdentifier(event.initiator_actor_id, index, 'initiator_actor_id'),
      delegationDepth,
      source: 'opencode',
      authoritativeSource: 'opencode',
      outcome,
      action: canonicalOpenCodeAction(type, inputSummary),
      phase,
      resourceType: 'opencode_event',
      resourceId: eventId,
      correlationId: optionalIdentifier(event.correlation_id, index, 'correlation_id'),
      causationId: optionalIdentifier(event.causation_id, index, 'causation_id'),
      sourceLedger: 'opencode_events',
      sourceRecordId: eventId,
      // One OpenCode emission can repeat the same phase with identical raw
      // properties. The relay assigns an occurrence UUID before durable
      // spooling, so transport retries dedupe while genuine repeats remain.
      sourceRevision: optionalIdentifier(event.source_revision, index, 'source_revision') ?? phase,
      inputSummary,
      outputSummary,
      inputSha256: requiredSha256(event.input_sha256, index, 'input_sha256'),
      outputSha256: optionalSha256(event.output_sha256, index, 'output_sha256'),
      errorCode,
      // OpenCode error strings can contain prompts or provider response bodies.
      // The canonical ledger stores only the bounded error code and digests.
      errorMessage: null,
      metadata: sanitizeMetadata(event.metadata, index),
      occurredAt,
    };
  });

  return { accepted: events.length, values };
}
