import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
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

export interface AuditDurabilityHealth {
  status: 'ok' | 'degraded';
  error: string | null;
}

export interface AuditRelay {
  enqueue(raw: { type?: string; properties?: unknown }): void;
  flush(): Promise<void>;
  stop(options?: { flush?: boolean }): Promise<void>;
  getDurability(): AuditDurabilityHealth;
}

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

type AuditJournalRecordKind = 'snapshot' | 'enqueue' | 'ack';

interface AuditJournalRecordCore {
  version: 3;
  sequence: number;
  kind: AuditJournalRecordKind;
  payload: unknown;
}

interface AuditJournalRecord extends AuditJournalRecordCore {
  checksum: string;
}

interface LoadedAuditJournal {
  queue: OpenCodeAuditEvent[];
  lineage: SessionLineage[];
  nextSequence: number;
  bytes: number;
  legacy: boolean;
}

const JOURNAL_RECORD_FIELDS = new Set(['version', 'sequence', 'kind', 'payload', 'checksum']);
const SOURCE_REVISION_RE = /^[0-9a-f-]{36}$/i;

function auditStateBytes(queue: OpenCodeAuditEvent[], lineage: SessionLineage[]): number {
  return Buffer.byteLength(JSON.stringify({ version: 3, queue, lineage }), 'utf8');
}

function deterministicLegacyRevision(event: unknown, index: number): string {
  const digest = createHash('sha256').update(stableJson({ event, index })).digest('hex');
  const variant = ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function normalizeLegacyEvent(value: unknown, index: number): OpenCodeAuditEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const normalized = {
    correlation_id: null,
    causation_id: null,
    ...event,
    source_revision: SOURCE_REVISION_RE.test(String(event.source_revision ?? ''))
      ? event.source_revision
      : deterministicLegacyRevision(event, index),
  };
  return isPersistedOpenCodeAuditEvent(normalized) ? normalized : null;
}

function parseLegacySpool(serialized: string, spoolPath: string): AuditSpoolV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  const parsedObject =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (
    parsedObject?.version === 2 &&
    Object.keys(parsedObject).some(
      (key) => key !== 'version' && key !== 'queue' && key !== 'lineage',
    )
  ) {
    throw new Error(`invalid OpenCode audit spool: ${spoolPath}`);
  }
  const rawQueue = Array.isArray(parsed)
    ? parsed
    : parsedObject?.version === 2
      ? parsedObject.queue
      : null;
  if (!Array.isArray(rawQueue)) return null;
  const queue = rawQueue.map(normalizeLegacyEvent);
  if (queue.some((event) => event === null)) {
    throw new Error(`invalid OpenCode audit spool: ${spoolPath}`);
  }
  const rawLineage = Array.isArray(parsed) ? [] : parsedObject?.lineage;
  if (
    !Array.isArray(rawLineage) ||
    rawLineage.length > 100_000 ||
    rawLineage.some((entry) => !isSessionLineage(entry))
  ) {
    throw new Error(`invalid OpenCode audit spool: ${spoolPath}`);
  }
  return {
    version: 2,
    queue: queue as OpenCodeAuditEvent[],
    lineage: rawLineage as SessionLineage[],
  };
}

function journalChecksum(core: AuditJournalRecordCore): string {
  return createHash('sha256').update(stableJson(core)).digest('hex');
}

function encodeJournalRecord(
  sequence: number,
  kind: AuditJournalRecordKind,
  payload: unknown,
): string {
  const core: AuditJournalRecordCore = { version: 3, sequence, kind, payload };
  return `${JSON.stringify({ ...core, checksum: journalChecksum(core) })}\n`;
}

function parseJournalRecord(
  line: string,
  lineNumber: number,
  spoolPath: string,
): AuditJournalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`invalid OpenCode audit journal record ${lineNumber}: ${spoolPath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid OpenCode audit journal record ${lineNumber}: ${spoolPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !JOURNAL_RECORD_FIELDS.has(key)) ||
    record.version !== 3 ||
    !Number.isSafeInteger(record.sequence) ||
    Number(record.sequence) < 1 ||
    !['snapshot', 'enqueue', 'ack'].includes(String(record.kind)) ||
    !SHA256_RE.test(String(record.checksum ?? ''))
  ) {
    throw new Error(`invalid OpenCode audit journal record ${lineNumber}: ${spoolPath}`);
  }
  const core: AuditJournalRecordCore = {
    version: 3,
    sequence: Number(record.sequence),
    kind: record.kind as AuditJournalRecordKind,
    payload: record.payload,
  };
  if (journalChecksum(core) !== record.checksum) {
    throw new Error(
      `OpenCode audit journal checksum mismatch at record ${lineNumber}: ${spoolPath}`,
    );
  }
  return { ...core, checksum: String(record.checksum) };
}

function validateSnapshotPayload(
  payload: unknown,
  spoolPath: string,
): { queue: OpenCodeAuditEvent[]; lineage: SessionLineage[] } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`invalid OpenCode audit journal snapshot: ${spoolPath}`);
  }
  const snapshot = payload as Record<string, unknown>;
  if (
    Object.keys(snapshot).some((key) => key !== 'queue' && key !== 'lineage') ||
    !Array.isArray(snapshot.queue) ||
    snapshot.queue.some((event) => !isPersistedOpenCodeAuditEvent(event)) ||
    !Array.isArray(snapshot.lineage) ||
    snapshot.lineage.length > 100_000 ||
    snapshot.lineage.some((entry) => !isSessionLineage(entry))
  ) {
    throw new Error(`invalid OpenCode audit journal snapshot: ${spoolPath}`);
  }
  return {
    queue: snapshot.queue as OpenCodeAuditEvent[],
    lineage: snapshot.lineage as SessionLineage[],
  };
}

function truncatePartialJournalTail(spoolPath: string, bytes: number): void {
  truncateSync(spoolPath, bytes);
  const fd = openSync(spoolPath, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function loadAuditJournal(spoolPath: string, maxStateBytes: number): LoadedAuditJournal {
  if (!existsSync(spoolPath)) {
    return { queue: [], lineage: [], nextSequence: 1, bytes: 0, legacy: false };
  }
  const serialized = readFileSync(spoolPath, 'utf8');
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  const maxJournalReadBytes = Math.max(maxStateBytes * 4, 1024 * 1024);
  if (serializedBytes > maxJournalReadBytes) {
    throw new Error(
      `OpenCode audit journal capacity exceeded: ${serializedBytes} > ${maxJournalReadBytes} bytes`,
    );
  }

  const legacy = parseLegacySpool(serialized, spoolPath);
  if (legacy) {
    if (auditStateBytes(legacy.queue, legacy.lineage) > maxStateBytes) {
      throw new Error(`OpenCode audit spool capacity exceeded: ${spoolPath}`);
    }
    return {
      queue: legacy.queue,
      lineage: legacy.lineage,
      nextSequence: 1,
      bytes: serializedBytes,
      legacy: true,
    };
  }

  const completeCharacters = serialized.endsWith('\n')
    ? serialized.length
    : Math.max(0, serialized.lastIndexOf('\n') + 1);
  const complete = serialized.slice(0, completeCharacters);
  const completeBytes = Buffer.byteLength(complete, 'utf8');
  const lines = complete.split('\n').filter((line) => line.length > 0);
  let expectedSequence = 1;
  let queue: OpenCodeAuditEvent[] = [];
  const sessions = new Map<string, SessionLineage>();
  const revisions = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const record = parseJournalRecord(line, index + 1, spoolPath);
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `OpenCode audit journal sequence mismatch at record ${index + 1}: expected ${expectedSequence}, got ${record.sequence}`,
      );
    }
    expectedSequence += 1;
    if (record.kind === 'snapshot') {
      if (record.sequence !== 1) {
        throw new Error(`OpenCode audit journal snapshot must be the first record: ${spoolPath}`);
      }
      const snapshot = validateSnapshotPayload(record.payload, spoolPath);
      queue = [];
      revisions.clear();
      sessions.clear();
      for (const event of snapshot.queue) {
        if (revisions.has(event.source_revision)) continue;
        revisions.add(event.source_revision);
        queue.push(event);
      }
      for (const entry of snapshot.lineage) sessions.set(entry.session_id, entry);
      continue;
    }
    if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
      throw new Error(`invalid OpenCode audit journal ${record.kind} payload: ${spoolPath}`);
    }
    const payload = record.payload as Record<string, unknown>;
    if (record.kind === 'enqueue') {
      if (
        Object.keys(payload).some((key) => key !== 'event' && key !== 'lineage') ||
        !isPersistedOpenCodeAuditEvent(payload.event) ||
        (payload.lineage !== null && !isSessionLineage(payload.lineage))
      ) {
        throw new Error(`invalid OpenCode audit journal enqueue payload: ${spoolPath}`);
      }
      const event = payload.event;
      if (!revisions.has(event.source_revision)) {
        revisions.add(event.source_revision);
        queue.push(event);
      }
      if (payload.lineage) {
        const lineage = payload.lineage as SessionLineage;
        sessions.set(lineage.session_id, lineage);
      }
      continue;
    }
    if (
      Object.keys(payload).some((key) => key !== 'source_revisions') ||
      !Array.isArray(payload.source_revisions) ||
      payload.source_revisions.length > 10_000 ||
      payload.source_revisions.some((revision) => !SOURCE_REVISION_RE.test(String(revision)))
    ) {
      throw new Error(`invalid OpenCode audit journal ack payload: ${spoolPath}`);
    }
    const acknowledged = new Set(payload.source_revisions as string[]);
    queue = queue.filter((event) => !acknowledged.has(event.source_revision));
    for (const revision of acknowledged) revisions.delete(revision);
  }

  if (completeBytes !== serializedBytes) truncatePartialJournalTail(spoolPath, completeBytes);
  const lineage = [...sessions.values()];
  if (auditStateBytes(queue, lineage) > maxStateBytes) {
    throw new Error(`OpenCode audit spool capacity exceeded: ${spoolPath}`);
  }
  return {
    queue,
    lineage,
    nextSequence: expectedSequence,
    bytes: completeBytes,
    legacy: false,
  };
}

function writeJournalSnapshot(
  spoolPath: string,
  queue: OpenCodeAuditEvent[],
  lineage: SessionLineage[],
): { nextSequence: number; bytes: number } {
  const directory = dirname(spoolPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${spoolPath}.${process.pid}.${randomUUID()}.tmp`;
  const line = encodeJournalRecord(1, 'snapshot', { queue, lineage });
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, line, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, spoolPath);
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return { nextSequence: 2, bytes: Buffer.byteLength(line, 'utf8') };
}

function appendJournalRecord(spoolPath: string, line: string): number {
  mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
  const fd = openSync(spoolPath, 'a', 0o600);
  try {
    writeFileSync(fd, line, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return Buffer.byteLength(line, 'utf8');
}

/** The ingestion route accepts only the sandbox credential. The session PAT is
 * intentionally excluded even when both credentials exist in the runtime. */
export function auditRelayToken(env: NodeJS.ProcessEnv): string | null {
  return (env.KORTIX_SANDBOX_TOKEN || env.KORTIX_TOKEN || '').trim() || null;
}

export function createAuditRelay(
  send: (events: OpenCodeAuditEvent[]) => Promise<void>,
  options: {
    batchSize?: number;
    flushMs?: number;
    retryMs?: number;
    spoolPath?: string;
    maxSpoolBytes?: number;
    compactAfterBytes?: number;
    initialDurabilityError?: string;
    onDurabilityChange?: (health: AuditDurabilityHealth) => void;
  } = {},
): AuditRelay {
  const batchSize = options.batchSize ?? 50;
  const flushMs = options.flushMs ?? 500;
  const retryMs = options.retryMs ?? 1_000;
  const spoolPath = options.spoolPath?.trim() || null;
  const maxSpoolBytes = options.maxSpoolBytes ?? DEFAULT_MAX_SPOOL_BYTES;
  const compactAfterBytes = options.compactAfterBytes ?? Math.max(64 * 1024, maxSpoolBytes / 2);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('audit relay batchSize must be a positive integer');
  }
  if (!Number.isSafeInteger(maxSpoolBytes) || maxSpoolBytes < 1) {
    throw new Error('audit relay maxSpoolBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(compactAfterBytes) || compactAfterBytes < 1) {
    throw new Error('audit relay compactAfterBytes must be a positive integer');
  }

  let durability: AuditDurabilityHealth = options.initialDurabilityError
    ? { status: 'degraded', error: options.initialDurabilityError.slice(0, 400) }
    : { status: 'ok', error: null };
  const setDurability = (next: AuditDurabilityHealth) => {
    if (durability.status === next.status && durability.error === next.error) return;
    durability = next;
    options.onDurabilityChange?.({ ...next });
  };
  const durabilityFailure = (error: unknown) => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    setDurability({ status: 'degraded', error: message });
  };
  const durabilityRecovered = () => setDurability({ status: 'ok', error: null });

  const loaded = spoolPath
    ? loadAuditJournal(spoolPath, maxSpoolBytes)
    : { queue: [], lineage: [], nextSequence: 1, bytes: 0, legacy: false };
  let nextSequence = loaded.nextSequence;
  let journalBytes = loaded.bytes;
  if (spoolPath && loaded.legacy) {
    const migrated = writeJournalSnapshot(spoolPath, loaded.queue, loaded.lineage);
    nextSequence = migrated.nextSequence;
    journalBytes = migrated.bytes;
  }

  const sessions = new Map<string, SessionLineage>();
  for (const entry of loaded.lineage) sessions.set(entry.session_id, entry);
  const queue: OpenCodeAuditEvent[] = loaded.queue;
  let journalNeedsReload = false;

  const persistRecord = (kind: AuditJournalRecordKind, payload: unknown) => {
    if (!spoolPath) return;
    const lineage = [...sessions.values()];
    const stateBytes = auditStateBytes(queue, lineage);
    if (stateBytes > maxSpoolBytes) {
      throw new Error(
        `OpenCode audit spool capacity exceeded: ${stateBytes} > ${maxSpoolBytes} bytes`,
      );
    }
    try {
      if (journalNeedsReload) {
        // Validate and truncate any partial tail before replacing it. The
        // in-memory queue is authoritative while local storage is degraded, so
        // snapshot the WHOLE queue here—including events whose append failed—
        // rather than persisting only the newest operation.
        loadAuditJournal(spoolPath, maxSpoolBytes);
        const recovered = writeJournalSnapshot(spoolPath, queue, lineage);
        nextSequence = recovered.nextSequence;
        journalBytes = recovered.bytes;
        journalNeedsReload = false;
        return;
      }
      const line = encodeJournalRecord(nextSequence, kind, payload);
      journalBytes += appendJournalRecord(spoolPath, line);
      nextSequence += 1;
      if (journalBytes >= compactAfterBytes) {
        const compacted = writeJournalSnapshot(spoolPath, queue, lineage);
        nextSequence = compacted.nextSequence;
        journalBytes = compacted.bytes;
      }
    } catch (error) {
      journalNeedsReload = true;
      throw error;
    }
  };

  let flushing: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
    flushing = (async () => {
      try {
        await send(batch);
        queue.splice(0, batch.length);
        try {
          persistRecord('ack', {
            source_revisions: batch.map((event) => event.source_revision),
          });
        } catch (error) {
          // The server already ingested this batch. Its source_revision makes
          // replay idempotent if the local ack could not be recorded.
          durabilityFailure(error);
        }
        // Successful central ingestion is a durability recovery even when the
        // local journal remains unavailable: the event now has an authoritative
        // durable copy, and a stale local replay is deduplicated by source_revision.
        durabilityRecovered();
      } catch (error) {
        // With no local journal, a failed central delivery leaves the batch
        // only in memory. Surface that loss-of-durability until a retry lands.
        if (!spoolPath) durabilityFailure(error);
        schedule(retryMs);
        throw error;
      } finally {
        flushing = null;
        if (queue.length > 0) schedule(queue.length >= batchSize ? 0 : flushMs);
      }
    })();
    return flushing;
  };

  const relay: AuditRelay = {
    enqueue(raw) {
      if (stopped) return;
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
      queue.push(event);
      try {
        persistRecord('enqueue', {
          event,
          lineage: sessionId ? (sessions.get(sessionId) ?? null) : null,
        });
        durabilityRecovered();
      } catch (error) {
        // Keep the event and lineage in memory. Local durability is secondary;
        // direct central delivery must continue while the filesystem is sick.
        durabilityFailure(error);
      }
      if (queue.length >= batchSize) void flush().catch(() => {});
      else schedule();
    },
    flush,
    async stop(stopOptions = {}) {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (stopOptions.flush === false) return;
      while (queue.length > 0) await flush();
    },
    getDurability() {
      return { ...durability };
    },
  };
  options.onDurabilityChange?.({ ...durability });
  schedule();
  return relay;
}
