/**
 * The bridge between a v1 tool part (`kortix.transcript.v1`) and a session-log tool call
 * (`ToolCallBlock`), for hosts that render blocks while their rows are still v1.
 *
 * Both directions run the converters in `./v1.ts`, so they are exact: `toolCallBlock` is the
 * block `fromV1` builds for the part (live, so an open call stays open), and the v1 part of a
 * block is what `toV1` rebuilds from it. A block keeps what its fields do not map (the
 * harness's `state.metadata`, a pending call's `raw`) in its `kortix.transcript.v1` residual;
 * `toolCallMetadata` reads it back.
 *
 * Every result is cached on the object it came from: a part or block is replaced, never
 * mutated, when it changes, so a memoized renderer sees the same block and metadata while
 * its part is unchanged.
 */
import type { Part, ToolPart } from '../runtime/runtime-types';
import { KORTIX_TRANSCRIPT_SCHEMA } from '../runtime/transcript-types';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogThread, type ToolCallBlock } from './types';
import { fromV1, toV1 } from './v1';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
const EMPTY: Record<string, unknown> = Object.freeze({});

const blocks = new WeakMap<ToolPart, { state: ToolPart['state']; block: ToolCallBlock }>();

/**
 * The session-log block of a v1 tool part: the block `fromV1` builds for it, with an open
 * call kept open (`pending`/`running`, no result). Transitional: it goes with the v1 rows,
 * in the SDK major that removes them.
 */
export function toolCallBlock(part: ToolPart): ToolCallBlock {
  const cached = blocks.get(part);
  if (cached && cached.state === part.state) return cached.block;
  const sid = part.sessionID ?? null;
  const info = { id: part.messageID, sessionID: part.sessionID, role: 'assistant' };
  const log = fromV1({ session_id: '', root_id: sid, rows: [{ runtime_session_id: sid, info: info as never, parts: [part] }] }, { live: true });
  const block = log.threads[0]!.messages[0]!.blocks[0] as ToolCallBlock;
  blocks.set(part, { state: part.state, block });
  return block;
}

const parts = new WeakMap<SessionLogBlock, Part | undefined>();

/**
 * The v1 part `toV1` rebuilds from `block` alone (no message context: no message time, no
 * session id), `undefined` for a block v1 cannot hold (a subtask). Internal.
 */
export function blockPartOf(block: SessionLogBlock): Part | undefined {
  if (parts.has(block)) return parts.get(block);
  const thread: SessionLogThread = {
    ...V, thread_id: '', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '',
    ext: { opencode: { version: KORTIX_TRANSCRIPT_SCHEMA } },
    messages: [{
      ...V, message_id: '', thread_id: '', seq: 1, role: 'assistant', kind: 'turn', status: 'complete', in_context: true,
      model: null, usage: null, finish: null, error: null, created_at: '', completed_at: null,
      producer: { harness: '', harness_version: '', adapter_version: '' }, blocks: [block],
    }],
  };
  const { rows } = toV1({
    ...V, session_id: '', title: null, created_at: '', restore_grade: 'native', harness: { current: '', history: [] },
    selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] }, threads: [thread],
  });
  const part = rows[0]!.parts[0] as unknown as Part | undefined;
  parts.set(block, part);
  return part;
}

/** The v1 tool part `toV1` rebuilds from `call`. Internal: the part helpers read a block through it. */
export function toolPartOf(call: ToolCallBlock): ToolPart {
  return blockPartOf(call) as ToolPart;
}

/** A tool call block, as opposed to a v1 tool part: the widened part helpers branch on it. */
export const isToolCallBlock = (value: unknown): value is ToolCallBlock =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'tool_call';

/** The v1 part of a part or a block. Internal: a widened part helper reads its argument through it. */
export const asToolPart = (value: ToolPart | ToolCallBlock): ToolPart => (isToolCallBlock(value) ? toolPartOf(value) : value);

/**
 * The harness's display metadata of a tool call: the `state.metadata` of the v1 part it was
 * converted from (bash `command`, read `loaded`, task `sessionId`, edit `filediff`, ...), whole.
 * A native record carries its `details` (`result.details`, else its adapter's ext: pi's
 * `ext.pi.data.details`) and `exit` from `result.exit_code`. The same
 * frozen empty object when there is none. Transitional: it stays until the session-log schema
 * carries display metadata of its own.
 */
export function toolCallMetadata(call: ToolCallBlock): Record<string, unknown> {
  const metadata = (toolPartOf(call).state as { metadata?: unknown }).metadata;
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) && Object.keys(metadata).length
    ? (metadata as Record<string, unknown>)
    : EMPTY;
}

/** The text items of a result, joined: what `toV1` gives a v1 part as `output` or `error`. */
const textOf = (call: ToolCallBlock) => (call.result?.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');

/** The call's status in the words a renderer compares: `pending`, `running`, `completed` or `error`. */
export function toolCallStatus(call: ToolCallBlock): 'pending' | 'running' | 'completed' | 'error' {
  return call.status === 'complete' ? 'completed' : call.status;
}

const rawOutputs = new WeakMap<ToolCallBlock, string>();

/** A completed call's output text as the tool returned it; `''` for any other call. One string per call object. */
export function toolCallRawOutput(call: ToolCallBlock): string {
  if (call.status !== 'complete') return '';
  let text = rawOutputs.get(call);
  if (text === undefined) rawOutputs.set(call, (text = textOf(call)));
  return text;
}

/**
 * A failed call's error text: its semantic error, else its result text (a native export closes
 * a failed call with `is_error` and the tool's text only), as `toV1` gives `state.error`.
 * `undefined` for a call that did not fail.
 */
export function toolCallError(call: ToolCallBlock): string | undefined {
  return call.status === 'error' ? call.result?.error?.message || textOf(call) : undefined;
}
