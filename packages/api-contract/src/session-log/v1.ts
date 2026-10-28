/**
 * `fromV1` and `toV1`: the session log and `kortix.transcript.v1` as the v1 mirror stores it
 * (`session_transcript_mirrors` + `session_transcript_messages`). Pure: no database, no fetch.
 *
 * EXACT BY CONSTRUCTION. `fromV1` maps each v1 message and part onto v2 fields. Then it runs
 * `toV1`'s own builder on the result and stores the difference to the stored v1 value (a
 * `V1Change`) in `ext[harness].data`, under the version `kortix.transcript.v1`. `toV1` runs the
 * builder and applies the change. So every field the mapping does not use (OpenCode metadata,
 * step tokens, snapshots, a stripped call's missing input) is kept, and `toV1(fromV1(x))`
 * deep-equals `x` for any JSON `x`, well-formed or not. A native v2 record has no such ext and
 * gets the builder's output alone.
 *
 * Decisions beyond the plain mapping:
 * - Threads. `thread_id` is the runtime session id (`opencode_session_id`), as the OpenCode
 *   adapter exports it. A runtime session other than the root is a child thread when a tool
 *   call names it (`state.metadata.sessionId`, else any mention in the call's state: the
 *   capture's `childSessionIdOf` rules all put the id there). `spawned_by` is that call.
 * - Multiple roots. A runtime session that is not the root and that no call names is an old
 *   root kept after a re-pin. Its messages go into the root thread, before the current root's,
 *   with `in_context: false, hidden_reason: 'superseded'`: the model of the current root never
 *   saw them, and a separate thread would claim a parent link that does not exist. A child of an
 *   old root becomes a child of the root thread.
 * - No usable root. `root_id` is null (both mirror columns are nullable; the v1 read then serves
 *   every row), or it names no row: a stale root, as after a re-pin to a fresh runtime session
 *   whose first capture has not run. Then the group of the latest row that no call names (the
 *   null group included) is the root thread, so the conversation stays in context. The stored
 *   `root_id` is kept in the session `ext`.
 * - At rest. The mirror holds only finished turns, so an assistant message with no
 *   `time.completed` and no error is `interrupted`, and every pending or running call is closed
 *   by the closure rule with the text the harness shows. An errored assistant row is out of
 *   context (`failed_attempt`), except an aborted one with a model-visible block (`aborted`,
 *   in context, as OpenCode sends it). `live: true` reads a live view instead (a client's v1
 *   store): those rows are `streaming` and their open calls stay open, and an in-context reply
 *   with an open call is `streaming` whatever its own end (pi completes a reply before its
 *   calls run; an abort lands before its calls close): rule C2 exempts only a streaming
 *   message. A failed attempt is out of context and keeps `error`.
 * - Errors. `error.code` is the daemon's `TurnErrorCode` (`info.error.code`) when the row has
 *   one, else the v1 error class name. `finish` takes the v2 values only; another v1 finish
 *   ('content-filter', 'other') maps to null and stays in ext.
 * - Attachments (F13). A resolved attachment gets `ref` and `bytes`. An unresolved one has
 *   neither, keeps `mime`, `name` and the v1 `url`, and counts in `grade_counts.attachment`.
 * - Tool kinds come from a name table (OpenCode and pi names); another name with `_` is `mcp`
 *   (OpenCode names MCP tools `<server>_<tool>`), the rest `other`.
 * - Model-invisible parts become harness blocks (`model_visible: false`, data = the v1 part):
 *   ignored text, text/plain and directory file parts (OpenCode sends their content as
 *   synthetic text instead), patch, snapshot, agent, retry, unknown types and malformed parts.
 *   A subtask part is model-visible with OpenCode's fallback text.
 * - Block ids are the part ids (F2). A part without an id gets `#<index>`. A repeated id keeps
 *   its first occurrence; each later one gets `<id>#<n>`, the smallest n >= 2 that no part of
 *   the message uses.
 * - `grade_counts` counts what an in-context message lost: `tool_input`, a tool call whose
 *   `state.input` is not an object (the legacy stripped rows); `cut_point`, a completed
 *   compaction without `tail_start_id`; `attachment`, a file part or tool attachment the
 *   resolver did not resolve. `restore_grade` is `partial` when any count is non-zero, else
 *   `converted`. `grade_counts` is always set.
 * - `toV1` returns rows in the mirror's order reversed to ascending (the read is
 *   `message_created_at DESC NULLS LAST, message_id DESC`, so a missing time comes first), then
 *   message id. Compare rows keyed by message id: Postgres orders ids by its collation.
 * - `toV1` applies the stored residuals whatever the producer: a daemon adapter that runs
 *   `fromV1` (OpenCode, P2.6) journals records under producer `opencode`, and they are exact
 *   too. A thread `fromV1` built always carries a `kortix.transcript.v1` ext, so that ext (or
 *   producer `kortix-v1-import`) marks a v1-derived message. On one, an `opencode` or `pi`
 *   harness block's `data` is the v1 part and passes through. On a native v2 record (no such
 *   ext, as the pi adapter writes), `toV1` skips `system` and `context` messages (an old
 *   client would draw them as user bubbles) and never passes a harness block's `data` through,
 *   except a `nested_part` block: a tool call a codemode script made, which the model never saw,
 *   as `data: { parent_call_id, part }`, `part` its v1 tool part without ids. It gives `part`
 *   back under the block's ids, so a reload draws the part the runtime published live.
 *   A native completed call's `state.metadata` is its display data (`result.details`, else the
 *   `details` of its adapter's ext: pi), as the harness's own v1 part carries it.
 * - Output never aliases input: `fromV1` and `toV1` clone their input.
 */
import type { KortixFilePart, KortixMessageInfo, KortixPart } from '../transcript';
import { KORTIX_TRANSCRIPT_SCHEMA, isTurnErrorCode } from '../transcript';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  type CompactionBlock,
  type Ext,
  type GradeCounts,
  type HarnessBlock,
  type KnownToolKind,
  type ModelRef,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogThread,
  type ToolCallBlock,
  type ToolResultContent,
  type Usage,
} from './types';

/** One `session_transcript_messages` row. The other columns are derived from `info` by the capture. */
export type V1Row = { runtime_session_id: string | null; info: KortixMessageInfo; parts: KortixPart[] };
/** One session's v1 mirror. `root_id` is `session_transcript_mirrors.opencode_session_id`. */
export type V1Transcript = { session_id: string; root_id: string | null; rows: V1Row[] };
/** A stored attachment object: `ref` names it, `bytes` is its size. */
export type V1Attachment = { ref: string; bytes: number; sha256?: string };
export type FromV1Options = {
  /** The harness that wrote the rows; it keys `ext`. Default `opencode`. */
  harness?: 'opencode' | 'pi';
  /**
   * Finds the stored object for a file part or tool attachment, usually by its
   * `kortix-attachment://` url. The mirror drops every other url, so a part may have none.
   * api-contract has no storage access, so the default resolves nothing: the block gets no
   * `ref` and no `bytes` (F13), keeps the url, and counts in `grade_counts.attachment`.
   */
  resolveAttachment?: (part: KortixFilePart) => V1Attachment | null;
  /**
   * The rows are a live view (a client's v1 store), not the mirror at rest: no closure rule. An
   * open call keeps `pending`/`running` with no result (a pending call that streams its input
   * has the text so far, `raw`, as its `input`), an open reply or compaction is `streaming`,
   * and the residual is taken against those blocks, so `toV1` stays exact and a running call
   * keeps its metadata. Default false.
   */
  live?: boolean;
};
/** What turns a value `toV1` builds into the stored one: replace it, delete it, or change some keys. */
export type V1Change = { set: unknown } | { del: true } | { sub: Record<string, V1Change> };

type Harness = NonNullable<FromV1Options['harness']>;
type J = Record<string, any>;
type MessageData = { info?: V1Change; summary?: V1Change; parts?: unknown; runtime_session_id?: string | null };
/** `fromV1`: the message came from `fromV1`, so its `opencode`/`pi` harness blocks hold v1 parts. */
type Ctx = { sessionID: string | null; messageID: string; created: number | undefined; fromV1: boolean };

const IMPORT = 'kortix-v1-import';
const PRODUCER = { harness: IMPORT, harness_version: KORTIX_TRANSCRIPT_SCHEMA, adapter_version: '1' };
const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR };
/** What the harness shows the model for a call that never ended. */
const INTERRUPTED: Record<Harness, string> = { opencode: '[Tool execution was interrupted]', pi: 'No result provided' };
/** What OpenCode shows the model for a pruned tool output (`time.compacted`). */
const CLEARED = '[Old tool result content cleared]';
const SUBTASK_TEXT = 'The following tool was executed by the user';
/** OpenCode 1.18 and pi 1.0.3 tool names (pi: bash, edit, find, grep, ls, powershell, read, write). */
const KIND = new Map<string, KnownToolKind>(Object.entries({
  bash: 'shell', powershell: 'shell', read: 'read', write: 'write', edit: 'edit', multiedit: 'edit', patch: 'patch', apply_patch: 'patch',
  list: 'list', ls: 'list', glob: 'glob', find: 'glob', grep: 'grep', webfetch: 'web_fetch', websearch: 'web_search', codesearch: 'web_search',
  todowrite: 'todo', todoread: 'todo', task: 'task', question: 'question', plan_enter: 'plan', plan_exit: 'plan',
}) as Array<[string, KnownToolKind]>);
const kindOf = (name: string): KnownToolKind => KIND.get(name) ?? (name.includes('_') ? 'mcp' : 'other');
const FINISH_V2 = new Map<unknown, SessionLogMessage['finish']>([['stop', 'stop'], ['tool-calls', 'tool_calls'], ['length', 'length'], ['error', 'error']]);
const FINISH_V1 = new Map<unknown, string>([['stop', 'stop'], ['tool_calls', 'tool-calls'], ['length', 'length'], ['error', 'error']]);

const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const own = (o: J, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const define = (o: J, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const iso = (ms: unknown) => (num(ms) !== undefined && Math.abs(ms as number) <= 8.64e15 ? new Date(ms as number).toISOString() : null);
const msOf = (s: string | null | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

// ─── V1Change ────────────────────────────────────────────────────────────────

/** Deep equality of JSON values; key order and `undefined` members do not count. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  return ka.length === Object.keys(b).filter((k) => b[k] !== undefined).length && ka.every((k) => same(a[k], own(b, k)));
}

/** The change that turns `built` into `stored`; undefined when they are equal. Arrays change whole. */
function diff(stored: unknown, built: unknown): V1Change | undefined {
  if (same(stored, built)) return undefined;
  if (stored === undefined) return { del: true };
  if (!isObj(stored) || !isObj(built)) return { set: stored };
  const sub: Record<string, V1Change> = {};
  for (const k of new Set([...Object.keys(stored), ...Object.keys(built)])) {
    const change = diff(own(stored, k), own(built, k));
    if (change) define(sub, k, change);
  }
  return { sub };
}

function apply(built: unknown, change: V1Change | undefined): unknown {
  if (!change) return built;
  if ('set' in change) return change.set;
  if ('del' in change) return undefined;
  const out: J = isObj(built) ? { ...built } : {};
  for (const [k, c] of Object.entries(change.sub)) {
    const v = apply(own(out, k), c);
    if (v === undefined) delete out[k];
    else define(out, k, v);
  }
  return out;
}

/** The ext entry `fromV1` writes, whatever harness keys it. */
const v1Ext = (ext: Ext | undefined) => Object.values(ext ?? {}).find((e) => e.version === KORTIX_TRANSCRIPT_SCHEMA);
const extOf = (h: Harness, entry: { native_id?: string; data?: unknown }): Ext => ({ [h]: { version: KORTIX_TRANSCRIPT_SCHEMA, ...entry } });

// ─── v2 -> v1 builders (shared by toV1 and by fromV1's residual) ─────────────

/**
 * The v1 url of an attachment: the one it came with, else (native records only) its object ref.
 * A v1-derived block keeps exactly the url its part had: an adapter sets `ref` after `fromV1`
 * (P2.6), and the stored part has no url for it.
 */
const urlOf = (a: { url?: string; ref?: string }, c: Ctx) =>
  a.url !== undefined ? { url: a.url } : a.ref !== undefined && !c.fromV1 ? { url: a.ref } : {};
const textOf = (content: ToolResultContent[] | undefined) => (content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
const head = (b: { id: string }, c: Ctx) => ({ id: b.id, ...(c.sessionID !== null && { sessionID: c.sessionID }), messageID: c.messageID });

/**
 * A native call's display data, the v1 `state.metadata` its harness part carries: `result.details`,
 * else the `details` an adapter keeps in its own ext (pi: `ext.pi.data.details`). A `fromV1` call
 * has neither; its metadata is in the v1 residual.
 */
const detailsOf = (b: ToolCallBlock): J => {
  if (isObj(b.result?.details)) return b.result.details;
  const own = Object.values(b.ext ?? {}).find((e) => e.version !== KORTIX_TRANSCRIPT_SCHEMA && isObj((e.data as J | undefined)?.details));
  return own ? (own.data as J).details : {};
};

function toolState(b: ToolCallBlock, c: Ctx, base: J): J {
  const r = b.result;
  const input = b.input === null || b.input === undefined ? {} : { input: b.input };
  const start = msOf(b.started_at) ?? c.created;
  const end = msOf(b.ended_at) ?? start;
  const meta = r?.exit_code !== undefined ? { exit: r.exit_code } : {};
  if (b.status === 'pending') return { status: 'pending', input: b.input ?? {}, raw: '' };
  if (b.status === 'running') return { status: 'running', input: b.input ?? {}, ...(b.title && { title: b.title }), time: { start } };
  if (b.status === 'error') return { status: 'error', ...input, error: textOf(r?.content), ...(r?.exit_code !== undefined && { metadata: meta }), time: { start, end } };
  const atts = (r?.content ?? []).flatMap((x, i) =>
    x.type === 'attachment' ? [{ ...base, id: `${b.id}-a${i}`, type: 'file', mime: x.mime, ...urlOf(x, c) }] : [],
  );
  const compacted = msOf(r?.cleared_at);
  return {
    status: 'completed', ...input, output: textOf(r?.content), title: b.title ?? '', metadata: { ...detailsOf(b), ...meta },
    time: { start, end, ...(compacted !== undefined && { compacted }) },
    ...(atts.length && { attachments: atts }),
  };
}

/** A v1 part for one block; undefined for a block v1 cannot hold. */
function partOf(b: SessionLogBlock, c: Ctx): unknown {
  const base = head(b, c);
  switch (b.type) {
    case 'text': return { ...base, type: 'text', text: b.text, ...(b.synthetic !== undefined && { synthetic: b.synthetic }) };
    case 'reasoning': return { ...base, type: 'reasoning', text: b.text, time: { start: c.created } };
    case 'attachment': return { ...base, type: 'file', mime: b.mime, ...(b.name !== undefined && { filename: b.name }), ...urlOf(b, c) };
    case 'tool_call': return { ...base, type: 'tool', callID: b.call_id, tool: b.name, state: toolState(b, c, { ...(c.sessionID !== null && { sessionID: c.sessionID }), messageID: c.messageID }) };
    case 'step': return b.phase === 'start'
      ? { ...base, type: 'step-start' }
      : { ...base, type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    case 'compaction': return {
      ...base, type: 'compaction', auto: b.trigger === 'auto' || b.trigger === 'overflow',
      ...(b.trigger === 'overflow' && { overflow: true }), ...(b.first_kept_message_id !== null && { tail_start_id: b.first_kept_message_id }),
    };
    case 'harness':
      if (c.fromV1 && (b.harness === 'opencode' || b.harness === 'pi')) return b.data;
      if (b.kind === 'nested_part' && isObj(b.data) && isObj(b.data.part)) return { ...b.data.part, ...base };
      return b.model_visible && b.fallback_text !== undefined ? { ...base, type: 'text', text: b.fallback_text, synthetic: true } : undefined;
    case 'subtask': return undefined;
  }
}

/** A v1 error from a v2 one: a `TurnErrorCode` goes to `code` (the class name to `name`), any other code is the class name. */
function errorV1(e: { code: string; message: string }): J {
  if (!isTurnErrorCode(e.code)) return { name: e.code, data: { message: e.message } };
  return { name: e.code === 'aborted' ? 'MessageAbortedError' : 'UnknownError', code: e.code, data: { message: e.message } };
}

function assistantInfo(m: SessionLogMessage, c: Ctx, over: J = {}): J {
  const u = m.usage;
  const finish = m.finish === null ? undefined : FINISH_V1.get(m.finish);
  return {
    id: m.message_id, ...(c.sessionID !== null && { sessionID: c.sessionID }), role: 'assistant',
    time: { created: c.created, ...(m.completed_at !== null && { completed: msOf(m.completed_at) }) },
    ...(m.reply_to && { parentID: m.reply_to }),
    modelID: m.model?.model ?? '', providerID: m.model?.provider ?? '', ...(m.model?.variant !== undefined && { variant: m.model.variant }),
    mode: m.agent ?? '', agent: m.agent ?? '', path: { cwd: '', root: '' },
    cost: u?.cost ?? 0, tokens: { input: u?.input ?? 0, output: u?.output ?? 0, reasoning: u?.reasoning ?? 0, cache: { read: u?.cache_read ?? 0, write: u?.cache_write ?? 0 } },
    ...(finish && { finish }), ...(m.error && { error: errorV1(m.error) }),
    ...over,
  };
}

function infoOf(m: SessionLogMessage, c: Ctx): J {
  if (m.role === 'assistant') return assistantInfo(m, c);
  return {
    id: m.message_id, ...(c.sessionID !== null && { sessionID: c.sessionID }), role: 'user', time: { created: c.created },
    agent: m.agent ?? '', model: { providerID: m.model?.provider ?? '', modelID: m.model?.model ?? '', ...(m.model?.variant !== undefined && { variant: m.model.variant }) },
  };
}

/** The assistant message OpenCode and pi store after a compaction marker. */
function summaryOf(m: SessionLogMessage, cb: CompactionBlock, c: Ctx): { info: J; parts: J[] } {
  const id = `${m.message_id}-summary`;
  const info = assistantInfo({ ...m, reply_to: m.message_id, agent: 'compaction', finish: m.status === 'complete' ? 'stop' : null }, c, { id, summary: true });
  return { info, parts: [{ id: `${id}-p0`, ...(c.sessionID !== null && { sessionID: c.sessionID }), messageID: id, type: 'text', text: cb.summary }] };
}

/** `v1Thread`: the thread carries the `kortix.transcript.v1` ext every `fromV1` thread gets. */
function rowsOf(m: SessionLogMessage, threadNative: string | null, v1Thread: boolean): V1Row[] {
  const v1 = v1Thread || m.producer.harness === IMPORT;
  if (!v1 && (m.role === 'system' || m.kind === 'context')) return [];
  const d = v1Ext(m.ext)?.data as MessageData | undefined;
  const sessionID = d && 'runtime_session_id' in d ? d.runtime_session_id ?? null : threadNative;
  const c: Ctx = { sessionID, messageID: m.message_id, created: msOf(m.created_at), fromV1: v1 };
  const parts = d && 'parts' in d
    ? d.parts
    : m.blocks.flatMap((b) => {
      const p = partOf(b, c);
      return p === undefined ? [] : [apply(p, v1Ext((b as { ext?: Ext }).ext)?.data as V1Change | undefined)];
    });
  const rows = [{ runtime_session_id: sessionID, info: apply(infoOf(m, c), d?.info), parts } as V1Row];
  const cb = m.blocks.find((b): b is CompactionBlock => b.type === 'compaction');
  if (m.kind === 'compaction' && cb && cb.summary !== null) {
    const s = apply(summaryOf(m, cb, c), d?.summary) as { info: KortixMessageInfo; parts: KortixPart[] };
    rows.push({ runtime_session_id: sessionID, info: s.info, parts: s.parts });
  }
  return rows;
}

const created = (r: V1Row) => num(isObj(r.info) && isObj(r.info.time) ? r.info.time.created : undefined) ?? -Infinity;
const idOf = (r: V1Row) => String(isObj(r.info) ? r.info.id : '');
/** The mirror's order, ascending: `(message_created_at NULLS FIRST, message_id)`. */
const rowOrder = (a: V1Row, b: V1Row) => created(a) - created(b) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);

const threadNativeOf = (t: SessionLogThread) => {
  const e = v1Ext(t.ext);
  return e ? e.native_id ?? null : t.thread_id;
};

/** v2 -> v1. Exact for a record `fromV1` built; for a native record, the v1 rows an old client renders. */
export function toV1(input: SessionLog): V1Transcript {
  const log = structuredClone(input);
  const root = log.threads.find((t) => t.parent_thread_id === null) ?? log.threads[0];
  const rows = log.threads.flatMap((t) => t.messages.flatMap((m) => rowsOf(m, threadNativeOf(t), v1Ext(t.ext) !== undefined)));
  const stated = v1Ext(log.ext)?.data as { root_id?: string | null } | undefined;
  const rootId = stated && 'root_id' in stated ? stated.root_id ?? null : root ? threadNativeOf(root) : null;
  return { session_id: log.session_id, root_id: rootId, rows: rows.sort(rowOrder) };
}

// ─── v1 -> v2 ────────────────────────────────────────────────────────────────

type Convert = { h: Harness; resolve: NonNullable<FromV1Options['resolveAttachment']>; counts: GradeCounts; live: boolean };

function modelOf(info: J): ModelRef | null {
  const src = info.role === 'assistant' ? { p: info.providerID, m: info.modelID, v: info.variant } : isObj(info.model) ? { p: info.model.providerID, m: info.model.modelID, v: info.model.variant } : {};
  const provider = str(src.p);
  const model = str(src.m);
  return provider === undefined || model === undefined ? null : { provider, model, ...(str(src.v) !== undefined && { variant: src.v }) };
}

function usageOf(info: J): Usage | null {
  if (!isObj(info.tokens)) return null;
  const t = info.tokens;
  const cache = isObj(t.cache) ? t.cache : {};
  return {
    input: num(t.input) ?? 0, output: num(t.output) ?? 0, cache_read: num(cache.read) ?? 0, cache_write: num(cache.write) ?? 0,
    ...(num(t.reasoning) !== undefined && { reasoning: t.reasoning }), ...(num(info.cost) !== undefined && { cost: info.cost }),
  };
}

const errorOf = (e: J) => ({ code: str(e.code) || str(e.name) || 'UnknownError', message: str(isObj(e.data) ? e.data.message : undefined) ?? '' });

/** F13: a resolved attachment has `ref` and `bytes`; an unresolved one has neither and counts as lost. Both keep the v1 url. */
function attachment(p: J, c: Convert, lost: GradeCounts) {
  const r = c.resolve(p as KortixFilePart);
  if (!r) lost.attachment++;
  return {
    mime: str(p.mime) ?? 'application/octet-stream',
    ...(r && { ref: r.ref, bytes: r.bytes, ...(r.sha256 !== undefined && { sha256: r.sha256 }) }),
    ...(str(p.url) !== undefined && { url: p.url as string }),
  };
}

function toolBlock(p: J, id: string, c: Convert, lost: GradeCounts): ToolCallBlock {
  const st = p.state as J;
  const time = isObj(st.time) ? st.time : {};
  if (!isObj(st.input)) lost.tool_input++;
  const exit = isObj(st.metadata) && num(st.metadata.exit) !== undefined ? { exit_code: st.metadata.exit as number } : {};
  let status: ToolCallBlock['status'];
  let result: ToolCallBlock['result'];
  let input: unknown = st.input ?? null;
  if (st.status === 'completed') {
    const atts: ToolResultContent[] = (Array.isArray(st.attachments) ? st.attachments : []).filter(isObj).map((a) => {
      const { bytes: _bytes, ...content } = attachment(a, c, lost);
      return { type: 'attachment', ...content };
    });
    const cleared = iso(time.compacted);
    status = 'complete';
    result = {
      content: [...(str(st.output) !== undefined ? [{ type: 'text' as const, text: st.output }] : []), ...atts], is_error: false, ...exit,
      ...(cleared && { model_content: [{ type: 'text', text: CLEARED }], cleared_at: cleared }),
    };
  } else if (st.status === 'error') {
    const error = str(st.error);
    status = 'error';
    result = { content: error !== undefined ? [{ type: 'text', text: error }] : [], is_error: true, ...(error !== undefined && { error: { message: error } }), ...exit };
  } else if (c.live) {
    status = st.status === 'pending' ? 'pending' : 'running';
    // A call that streams its input: the text so far is its input (OpenCode keeps it in `raw`).
    if (status === 'pending' && str(st.raw) && !(isObj(st.input) && Object.keys(st.input).length)) input = st.raw;
  } else {
    // C2 closure rule: a call that never ended, at rest.
    const text = INTERRUPTED[c.h];
    status = 'error';
    result = { content: [{ type: 'text', text }], is_error: true, synthetic: true, error: { code: 'interrupted', message: text } };
  }
  const started = iso(time.start);
  const ended = iso(time.end);
  return {
    type: 'tool_call', id, call_id: p.callID, name: p.tool, kind: kindOf(p.tool), input, status, ...(result && { result }),
    ...(str(st.title) && { title: st.title }), ...(started && { started_at: started }), ...(ended && { ended_at: ended }),
  };
}

function blockOf(p: unknown, id: string, marker: unknown, summary: string | null, c: Convert, lost: GradeCounts): SessionLogBlock {
  const harness = (kind: string, model_visible = false): HarnessBlock => ({
    type: 'harness', id, harness: c.h, kind, data: p, model_visible, ...(model_visible && { fallback_text: SUBTASK_TEXT }),
  });
  if (!isObj(p)) return harness('unknown');
  switch (p.type) {
    case 'text':
      return typeof p.text !== 'string' || p.ignored === true ? harness('text') : { type: 'text', id, text: p.text, ...(typeof p.synthetic === 'boolean' && { synthetic: p.synthetic }) };
    case 'reasoning':
      return typeof p.text !== 'string' ? harness('reasoning') : { type: 'reasoning', id, text: p.text };
    case 'file': {
      if (p.mime === 'text/plain' || p.mime === 'application/x-directory') return harness('file');
      return { type: 'attachment', id, ...attachment(p, c, lost), ...(str(p.filename) !== undefined && { name: p.filename }) };
    }
    case 'tool':
      return typeof p.callID === 'string' && typeof p.tool === 'string' && isObj(p.state) ? toolBlock(p, id, c, lost) : harness('tool');
    case 'step-start':
    case 'step-finish':
      return { type: 'step', id, phase: p.type === 'step-start' ? 'start' : 'finish' };
    case 'compaction': {
      if (p !== marker) return harness('compaction');
      const trigger = p.overflow === true ? 'overflow' : p.auto === true ? 'auto' : 'manual';
      return { type: 'compaction', id, summary, first_kept_message_id: str(p.tail_start_id) ?? null, trigger };
    }
    case 'subtask':
      return harness('subtask', true);
    default:
      return harness(str(p.type) || 'unknown');
  }
}

/** F2 block ids: the part id; `#<index>` without one; `<id>#<n>` for a repeat (see the module header). */
function blockIds(parts: unknown[]): string[] {
  const given = parts.map((p, i) => (isObj(p) && typeof p.id === 'string' && p.id ? p.id : `#${i}`));
  const taken = new Set(given);
  const seen = new Set<string>();
  return given.map((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      return id;
    }
    let n = 2;
    while (taken.has(`${id}#${n}`)) n++;
    taken.add(`${id}#${n}`);
    return `${id}#${n}`;
  });
}

function toMessage(row: V1Row, sum: V1Row | undefined, threadId: string, seq: number, superseded: boolean, c: Convert): { m: SessionLogMessage; lost: GradeCounts } {
  const info: J = isObj(row.info) ? row.info : {};
  const parts: unknown[] = Array.isArray(row.parts) ? row.parts : [];
  const marker = info.role === 'user' ? parts.find((p) => isObj(p) && p.type === 'compaction') : undefined;
  const sInfo: J | undefined = sum && isObj(sum.info) ? sum.info : undefined;
  const role = info.role === 'assistant' || info.role === 'user' ? info.role : 'system';
  const src = marker ? sInfo : role === 'assistant' ? info : undefined; // whose error, completion and usage
  const err = src && isObj(src.error) ? src.error : undefined;
  const aborted = err?.name === 'MessageAbortedError';
  const completedAt = src && isObj(src.time) ? iso(src.time.completed) : null;
  const open = c.live ? 'streaming' : 'interrupted';
  const settled: SessionLogMessage['status'] = !src ? (marker ? open : 'complete') : err ? (aborted ? 'aborted' : 'error') : completedAt ? 'complete' : open;
  const createdAt = iso(isObj(info.time) ? info.time.created : undefined) ?? '';
  const summary = sum ? (Array.isArray(sum.parts) ? sum.parts : []).flatMap((p) => (isObj(p) && p.type === 'text' && typeof p.text === 'string' ? [p.text] : [])).join('') : null;
  const lost: GradeCounts = { tool_input: 0, cut_point: 0, attachment: 0 };
  const ids = blockIds(parts);
  // blockIds returns one id per part.
  const blocks = parts.map((p, i) => blockOf(p, ids[i]!, marker, summary, c, lost));
  // An aborted reply stays in context only with something the model sees: an empty one would replay as an empty turn.
  const visible = blocks.some((b) => b.type === 'text' || b.type === 'attachment' || b.type === 'tool_call' || (b.type === 'harness' && b.model_visible));
  const inContext = !superseded && role !== 'system' && (marker ? settled === 'complete' : !err || (aborted && visible));
  // A live in-context reply with an open call still streams (pi completes a reply before its calls run; an abort lands before
  // its calls close): rule C2 exempts only a streaming message. A failed attempt is out of context and keeps its error.
  // At rest the closure rule closed the call.
  const status = c.live && inContext && settled !== 'streaming' && blocks.some((b) => b.type === 'tool_call' && (b.status === 'pending' || b.status === 'running')) ? 'streaming' : settled;
  // A compaction whose summary never arrived (or never finished) has no reason: nobody stopped it, nothing failed.
  const hidden = superseded ? 'superseded' : inContext || !err ? undefined : aborted ? 'aborted' : 'failed_attempt';
  if (marker && isObj(marker) && str(marker.tail_start_id) === undefined) lost.cut_point++;
  const m: SessionLogMessage = {
    ...V, message_id: str(info.id) ?? '', thread_id: threadId, seq, role, kind: marker ? 'compaction' : 'turn', status, in_context: inContext,
    ...(hidden && { hidden_reason: hidden }),
    agent: str(info.agent) ?? null,
    ...(role === 'assistant' && { reply_to: str(info.parentID) ?? null }),
    model: modelOf(info), usage: src ? usageOf(src) : null,
    finish: !src || marker ? null : aborted ? 'aborted' : err ? 'error' : FINISH_V2.get(info.finish) ?? null,
    error: err ? errorOf(err) : null,
    created_at: createdAt, completed_at: src || marker ? completedAt : createdAt || null,
    producer: PRODUCER, blocks,
  };
  return { m, lost };
}

/** Stores, on the message and its blocks, what `rowsOf` needs to rebuild the stored rows exactly. */
function keepResidual(m: SessionLogMessage, row: V1Row, sum: V1Row | undefined, threadNative: string | null, h: Harness) {
  const data: MessageData = {};
  if (row.runtime_session_id !== threadNative) data.runtime_session_id = row.runtime_session_id;
  const c: Ctx = { sessionID: row.runtime_session_id, messageID: m.message_id, created: msOf(m.created_at), fromV1: true };
  if (Array.isArray(row.parts)) {
    m.blocks.forEach((b, i) => {
      if (b.type === 'harness' || b.type === 'subtask') return;
      const change = diff(row.parts[i], partOf(b, c));
      if (change) b.ext = extOf(h, { data: change });
    });
  } else data.parts = row.parts;
  const info = diff(row.info, infoOf(m, c));
  if (info) data.info = info;
  const cb = m.blocks.find((b): b is CompactionBlock => b.type === 'compaction');
  if (sum && cb) {
    const change = diff({ info: sum.info, parts: sum.parts }, summaryOf(m, cb, c));
    if (change) data.summary = change;
  }
  if (Object.keys(data).length) m.ext = extOf(h, { data });
}

/**
 * The first tool call that names runtime session `id`: by `state.metadata.sessionId`, else anywhere in its state.
 * ponytail: the fallback is a substring match, so a call whose output merely lists an old root's id makes it a
 * child thread (still out of the root's context). The precise rule is `childSessionIdOf` in
 * `apps/api/src/projects/lib/session-transcript-mirror.ts`: hoist it here when a prod row shows a false positive.
 */
function spawnerOf(rows: V1Row[], id: string | null, text: (state: J) => string): { row: V1Row; part: J } | undefined {
  if (!id) return undefined; // null or '': a substring match on '' would name every call
  for (const exact of [true, false]) {
    for (const row of rows) {
      if (row.runtime_session_id === id || !Array.isArray(row.parts)) continue;
      for (const p of row.parts as unknown[]) {
        if (!isObj(p) || p.type !== 'tool' || !isObj(p.state)) continue;
        if (exact ? isObj(p.state.metadata) && p.state.metadata.sessionId === id : text(p.state).includes(id)) return { row, part: p };
      }
    }
  }
  return undefined;
}

/** v1 mirror -> session log. See the module header for every mapping decision. */
export function fromV1(v1: V1Transcript, options: FromV1Options = {}): SessionLog {
  const c: Convert = { h: options.harness ?? 'opencode', resolve: options.resolveAttachment ?? (() => null), counts: { tool_input: 0, cut_point: 0, attachment: 0 }, live: options.live === true };
  const rows = structuredClone(v1.rows).sort(rowOrder);
  const groups = new Map<string | null, V1Row[]>();
  for (const r of rows) {
    const list = groups.get(r.runtime_session_id);
    if (list) list.push(r);
    else groups.set(r.runtime_session_id, [r]);
  }
  // A null root, or one that names no row, falls back to the latest row's group (see the module header).
  const stated = v1.root_id;
  const usable = groups.has(stated);
  const texts = new Map<J, string>();
  const text = (state: J) => texts.get(state) ?? (texts.set(state, JSON.stringify(state)), texts.get(state)!);
  const spawners = new Map<string, { row: V1Row; part: J }>();
  for (const id of groups.keys()) {
    const s = usable && id === stated ? undefined : spawnerOf(rows, id, text);
    if (s) spawners.set(id!, s);
  }
  const latest = [...rows].reverse().find((r) => r.runtime_session_id === null || !spawners.has(r.runtime_session_id));
  const root = usable || !latest ? stated : latest.runtime_session_id;
  if (!groups.has(root)) groups.set(root, []);
  const rootThread = root || v1.session_id;
  const threadOf = (id: string | null) => (id !== null && spawners.has(id) ? id : rootThread);

  const sessionCreated = iso(rows.map(created).find(Number.isFinite)) ?? '';
  const threads: SessionLogThread[] = [];
  for (const [id, own] of groups) {
    if (id !== root && (id === null || !spawners.has(id))) continue; // an old root: merged into the root thread
    const isRoot = id === root;
    const superseded = isRoot ? rows.filter((r) => r.runtime_session_id !== root && threadOf(r.runtime_session_id) === rootThread) : [];
    const list = [...superseded, ...own];
    const old = new Set(superseded);
    // A compaction marker and its summary row, paired before the walk: the summary may sort first.
    const summaries = new Map<V1Row, V1Row>();
    const paired = new Set<V1Row>();
    for (const row of list) {
      const info: J = isObj(row.info) ? row.info : {};
      if (info.role !== 'user' || !Array.isArray(row.parts) || !row.parts.some((p) => isObj(p) && p.type === 'compaction')) continue;
      const sum = list.find((r) => !paired.has(r) && r.runtime_session_id === row.runtime_session_id && isObj(r.info) && r.info.role === 'assistant' && r.info.summary === true && r.info.parentID === info.id);
      if (!sum) continue;
      summaries.set(row, sum);
      paired.add(sum);
    }
    const messages: SessionLogMessage[] = [];
    for (const row of list) {
      if (paired.has(row)) continue;
      const sum = summaries.get(row);
      const { m, lost } = toMessage(row, sum, isRoot ? rootThread : id!, messages.length + 1, old.has(row), c);
      keepResidual(m, row, sum, id, c.h);
      if (m.in_context) for (const k of ['tool_input', 'cut_point', 'attachment'] as const) c.counts[k] += lost[k];
      messages.push(m);
    }
    const spawn = id === null ? undefined : spawners.get(id);
    const firstUser = messages.find((m) => m.role === 'user' && m.kind === 'turn');
    threads.push({
      ...V, thread_id: isRoot ? rootThread : id!,
      parent_thread_id: spawn ? threadOf(spawn.row.runtime_session_id) : null,
      spawned_by: spawn && typeof spawn.part.callID === 'string' ? { message_id: str(spawn.row.info?.id) ?? '', call_id: spawn.part.callID } : null,
      agent: firstUser?.agent ?? null, title: null, created_at: messages[0]?.created_at || sessionCreated, messages,
      ext: extOf(c.h, id === null ? {} : { native_id: id }),
    });
  }
  threads.sort((a, b) => (a.parent_thread_id === null ? -1 : b.parent_thread_id === null ? 1 : rowsIndex(a) - rowsIndex(b)));
  const lastUser = threads[0]?.messages.filter((m) => m.role === 'user' && m.kind === 'turn').at(-1);
  const partial = c.counts.tool_input + c.counts.cut_point + c.counts.attachment > 0;
  return {
    ...V, session_id: v1.session_id, title: null, created_at: sessionCreated,
    restore_grade: partial ? 'partial' : 'converted', grade_counts: c.counts,
    harness: { current: c.h, history: [] },
    selection: { agent: lastUser?.agent ?? null, model: lastUser?.model ?? null },
    todos: [], pending: { questions: [], permissions: [] }, threads,
    ...(root !== stated && { ext: extOf(c.h, { data: { root_id: stated } }) }),
  };

  function rowsIndex(t: SessionLogThread) {
    return rows.findIndex((r) => r.runtime_session_id === t.thread_id);
  }
}
