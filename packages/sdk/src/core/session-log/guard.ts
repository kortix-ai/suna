/**
 * Structural checks for session-log records read from the network or the device.
 *
 * The SDK has no zod (`types.test.ts`), so these are hand-written. They check every field
 * the store and `toV1` read (identity, the closed sets, model, usage, producer, the optional
 * strings) and the message-level rules F1 (unique block ids), F3, F13 and C2 (the closure
 * rule). Not checked: the inside of `ext` entries, `pending` payloads, tool `input` and
 * `details`, compaction `layout` entries: nothing here reads them. `guard.test.ts` holds the
 * guard and `SessionLogMessageSchema` in agreement on every api-contract fixture and on each
 * rejected shape it lists.
 */
import type { SessionLogPage } from './source';
import type { SessionLogThreadHead } from './store';
import { SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage } from './types';

type J = Record<string, unknown>;

const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isStr(v) && v.length > 0;
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isOptional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const oneOf =
  (...values: readonly unknown[]) =>
  (v: unknown) =>
    values.includes(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isNum = (v: unknown) => typeof v === 'number';
const isSchemaRef = (v: J) => v.schema === SESSION_LOG_SCHEMA && isCount(v.v);
const isOptStr = (v: unknown) => isOptional(v, isStr);
const isExt = (v: unknown) => v === undefined || (isObj(v) && Object.values(v).every((e) => isObj(e) && isStr(e.version)));
const isModel = (v: unknown) => v === null || (isObj(v) && isStr(v.provider) && isStr(v.model) && isOptStr(v.variant));
const isUsage = (v: unknown) =>
  v === null ||
  (isObj(v) && isNum(v.input) && isNum(v.output) && isNum(v.cache_read) && isNum(v.cache_write) && isOptional(v.reasoning, isNum) && isOptional(v.cost, isNum));
const isResultContent = (c: unknown) => isObj(c) && ((c.type === 'text' && isStr(c.text)) || (c.type === 'attachment' && isStr(c.mime)));
const isToolResult = (r: unknown) =>
  isObj(r) && Array.isArray(r.content) && r.content.every(isResultContent) && isOptional(r.model_content, (m) => Array.isArray(m) && m.every(isResultContent)) && typeof r.is_error === 'boolean';

const BLOCK: Record<SessionLogBlock['type'], (b: J) => boolean> = {
  // F3: a text stored by reference states its size.
  text: (b) => isStr(b.text) && isOptional(b.bytes, isCount) && isOptStr(b.ref) && (b.ref === undefined || b.bytes !== undefined),
  reasoning: (b) => isStr(b.text),
  // F13: `ref` and `bytes` together, or neither.
  attachment: (b) => isStr(b.mime) && isOptStr(b.ref) && isOptional(b.bytes, isCount) && (b.ref === undefined) === (b.bytes === undefined),
  tool_call: (b) =>
    isStr(b.call_id) &&
    isStr(b.name) &&
    isId(b.kind) &&
    oneOf('pending', 'running', 'complete', 'error')(b.status) &&
    isOptional(b.result, isToolResult),
  compaction: (b) => isStrOrNull(b.summary) && isStrOrNull(b.first_kept_message_id),
  subtask: (b) => isStr(b.thread_id) && isStr(b.agent) && isStr(b.description),
  step: (b) => oneOf('start', 'finish')(b.phase),
  harness: (b) => isId(b.harness) && isId(b.kind) && typeof b.model_visible === 'boolean',
};

/** F1 and the block union; C2: at rest, an in-context message holds no open tool call. */
function isBlocks(blocks: unknown, atRestInContext: boolean): boolean {
  if (!Array.isArray(blocks)) return false;
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!isObj(b) || !isId(b.id) || seen.has(b.id) || !Object.hasOwn(BLOCK, b.type as string)) return false;
    if (!BLOCK[b.type as SessionLogBlock['type']](b) || !isExt(b.ext)) return false;
    if (atRestInContext && b.type === 'tool_call' && (b.status === 'pending' || b.status === 'running' || !b.result)) return false;
    seen.add(b.id);
  }
  return true;
}

export function isSessionLogMessage(v: unknown): v is SessionLogMessage {
  return (
    isObj(v) &&
    isSchemaRef(v) &&
    isId(v.message_id) &&
    isId(v.thread_id) &&
    Number.isInteger(v.seq) &&
    oneOf('user', 'assistant', 'system')(v.role) &&
    oneOf('turn', 'compaction', 'context')(v.kind) &&
    oneOf('streaming', 'complete', 'error', 'aborted', 'interrupted')(v.status) &&
    typeof v.in_context === 'boolean' &&
    isOptional(v.hidden_reason, oneOf('failed_attempt', 'aborted', 'retracted', 'reverted', 'superseded')) &&
    isOptional(v.origin, oneOf('prompt', 'steer', 'command', 'automation', 'subagent', 'notification')) &&
    isOptional(v.agent, isStrOrNull) &&
    isOptional(v.reply_to, isStrOrNull) &&
    isOptional(v.parent_message_id, isStrOrNull) &&
    isOptStr(v.native_agent_id) &&
    isOptStr(v.context_ref) &&
    isModel(v.model) &&
    isUsage(v.usage) &&
    oneOf('stop', 'tool_calls', 'length', 'error', 'aborted', null)(v.finish) &&
    (v.error === null || (isObj(v.error) && isId(v.error.code) && isStr(v.error.message))) &&
    isStr(v.created_at) &&
    isStrOrNull(v.completed_at) &&
    isObj(v.producer) &&
    isId(v.producer.harness) &&
    isStr(v.producer.harness_version) &&
    isStr(v.producer.adapter_version) &&
    isExt(v.ext) &&
    isBlocks(v.blocks, v.status !== 'streaming' && v.in_context === true)
  );
}

export function isSessionLogThreadHead(v: unknown): v is SessionLogThreadHead {
  return (
    isObj(v) &&
    isSchemaRef(v) &&
    isId(v.thread_id) &&
    isStrOrNull(v.parent_thread_id) &&
    (v.spawned_by === null || isObj(v.spawned_by)) &&
    isStr(v.created_at)
  );
}

/** The session record as a page carries it: a patch, so each field is checked only when present. */
function isSessionPatch(v: unknown): boolean {
  return (
    isObj(v) &&
    isOptional(v.schema, (x) => x === SESSION_LOG_SCHEMA) &&
    isOptional(v.v, isCount) &&
    isOptStr(v.session_id) &&
    isOptional(v.title, isStrOrNull) &&
    isOptStr(v.created_at) &&
    isOptional(v.restore_grade, oneOf('native', 'converted', 'partial')) &&
    isOptional(v.todos, Array.isArray) &&
    isOptional(v.pending, (p) => isObj(p) && Array.isArray(p.questions) && Array.isArray(p.permissions)) &&
    isOptional(v.selection, (x) => isObj(x) && isOptional(x.agent, isStrOrNull) && isModel(x.model ?? null)) &&
    isOptional(v.harness, (x) => isObj(x) && isStr(x.current) && Array.isArray(x.history)) &&
    isExt(v.ext)
  );
}

export function isSessionLogPage(v: unknown): v is SessionLogPage {
  return (
    isObj(v) &&
    isCount(v.generation) &&
    typeof v.has_more === 'boolean' &&
    isSessionPatch(v.session) &&
    Array.isArray(v.threads) &&
    v.threads.every(isSessionLogThreadHead) &&
    (v.thread_id === null || isId(v.thread_id)) &&
    Array.isArray(v.messages) &&
    v.messages.every((m) => isSessionLogMessage(m) && m.thread_id === v.thread_id)
  );
}
