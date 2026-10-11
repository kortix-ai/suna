/**
 * Structural checks for session-log records read from the network or the device.
 *
 * The SDK has no zod (`types.test.ts`), so these are hand-written. They check what a
 * reader of this package dereferences: the record identity, the closed sets (enums,
 * the block union) and the field types the store and `toV1` read. They do not repeat
 * every rule of `SessionLogSchema` (the closure rule, F3, F13): the API and kortixd
 * validate with it before a record is stored or sent. `guard.test.ts` holds the two in
 * agreement on every api-contract fixture and on each rejected mutation it lists.
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
const isSchemaRef = (v: J) => v.schema === SESSION_LOG_SCHEMA && isCount(v.v);

const BLOCK: Record<SessionLogBlock['type'], (b: J) => boolean> = {
  text: (b) => isStr(b.text),
  reasoning: (b) => isStr(b.text),
  attachment: (b) => isStr(b.mime),
  tool_call: (b) =>
    isStr(b.call_id) &&
    isStr(b.name) &&
    isId(b.kind) &&
    oneOf('pending', 'running', 'complete', 'error')(b.status) &&
    isOptional(b.result, (r) => isObj(r) && Array.isArray(r.content) && typeof r.is_error === 'boolean'),
  compaction: (b) => isStrOrNull(b.summary) && isStrOrNull(b.first_kept_message_id),
  subtask: (b) => isStr(b.thread_id) && isStr(b.agent) && isStr(b.description),
  step: (b) => oneOf('start', 'finish')(b.phase),
  harness: (b) => isId(b.harness) && isId(b.kind) && typeof b.model_visible === 'boolean',
};

function isBlocks(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!isObj(b) || !isId(b.id) || seen.has(b.id) || !Object.hasOwn(BLOCK, b.type as string)) return false;
    if (!BLOCK[b.type as SessionLogBlock['type']](b)) return false;
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
    (v.model === null || isObj(v.model)) &&
    (v.usage === null || isObj(v.usage)) &&
    oneOf('stop', 'tool_calls', 'length', 'error', 'aborted', null)(v.finish) &&
    (v.error === null || (isObj(v.error) && isId(v.error.code) && isStr(v.error.message))) &&
    isStr(v.created_at) &&
    isStrOrNull(v.completed_at) &&
    isObj(v.producer) &&
    isId(v.producer.harness) &&
    isBlocks(v.blocks)
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

export function isSessionLogPage(v: unknown): v is SessionLogPage {
  return (
    isObj(v) &&
    isCount(v.generation) &&
    typeof v.has_more === 'boolean' &&
    isObj(v.session) &&
    isSchemaRef(v.session) &&
    isId(v.session.session_id) &&
    Array.isArray(v.threads) &&
    v.threads.every(isSessionLogThreadHead) &&
    Array.isArray(v.messages) &&
    v.messages.every(isSessionLogMessage)
  );
}
