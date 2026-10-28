/**
 * The v1 parts and rows behind session-log blocks and messages, for the block turn layer: it
 * calls the v1 turn helpers (`core/turns`) on them and maps their answers back to blocks, so
 * both layers give one answer until P8.4 removes the v1 helpers. Internal.
 *
 * `blockPartOf` rebuilds the part `toV1` gives a block alone: exact for a converted block (its
 * residual restores every v1 field), the builder's part for a native one. Each is cached on the
 * block object, so a part keeps its identity while its block does.
 */
import type { Part, ToolPart } from '../../runtime/runtime-types';
import type { SessionLogThreadHead } from '../store';
import { blockPartOf, toolCallBlock } from '../tool-call';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage } from '../types';
import { rowsOf, type V1MessageRow } from '../v1-view';

const blocks = new WeakMap<object, SessionLogBlock>();
/** The message each grouped block belongs to; set by `groupLogIntoTurns`, read for a block's part and a thought's liveness. */
export const messageOfBlock = new WeakMap<SessionLogBlock, SessionLogMessage>();
const fallbacks = new WeakMap<SessionLogBlock, Part>();

/**
 * The v1 part of `block` (one per block object), undefined for a block v1 cannot hold (a
 * subtask, a harness block the model never saw). A harness block holds its v1 part when a
 * `fromV1` thread wrote it; a native one renders its fallback text, or nothing.
 */
export function partOf(block: SessionLogBlock): Part | undefined {
  let part: Part | undefined;
  const message = messageOfBlock.get(block);
  // With its message known, the part comes from the message's own rows (message time and session id included).
  if (message) part = partsById(message).get(block.id);
  if (part) return blocks.set(part, shownBlock(block, part, message)), part;
  if (block.type !== 'harness' || block.kind === 'nested_part') part = blockPartOf(block);
  else if (typeof (block.data as { type?: unknown } | null)?.type === 'string') part = block.data as Part;
  else if (block.model_visible && block.fallback_text !== undefined) {
    part = fallbacks.get(block) ?? ({ id: block.id, type: 'text', text: block.fallback_text, synthetic: true } as unknown as Part);
    fallbacks.set(block, part);
  }
  if (part) blocks.set(part, shownBlock(block, part, message));
  return part;
}

/**
 * The block a host draws for `part`: `block` itself, except a `nested_part` harness block (a
 * codemode script's call, model-invisible), which draws as the tool call of its part, so a
 * reload renders the same card as the live turn. One call per part object; it reads back to
 * the same part.
 */
function shownBlock(block: SessionLogBlock, part: Part, message: SessionLogMessage | undefined): SessionLogBlock {
  if (block.type !== 'harness' || block.kind !== 'nested_part') return block;
  const call = toolCallBlock(part as ToolPart);
  if (message) messageOfBlock.set(call, message);
  return call;
}

/** The block `partOf` built `part` from. */
export const blockOf = (part: object): SessionLogBlock => blocks.get(part)!;

/** The v1 parts of `list`, without the blocks v1 cannot hold. */
export const partsOf = (list: ReadonlyArray<SessionLogBlock>): Part[] => list.flatMap((b) => partOf(b) ?? []);

const indexes = new WeakMap<SessionLogMessage, Map<string, Part>>();
/** The first v1 row's parts of `m`, by part id, built once per message object. */
function partsById(m: SessionLogMessage): Map<string, Part> {
  let index = indexes.get(m);
  if (!index) indexes.set(m, (index = new Map(v1RowsOf(m)[0]?.parts.map((p) => [p.id, p]))));
  return index;
}

const heads = new Map<string, SessionLogThreadHead>();

/** The v1 rows of a message (a compaction gives two: the marker, then its summary), cached per message object. */
export function v1RowsOf(m: SessionLogMessage): V1MessageRow[] {
  let head = heads.get(m.thread_id);
  if (!head) {
    head = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: m.thread_id, parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '' };
    heads.set(m.thread_id, head);
  }
  return rowsOf(head, m);
}
