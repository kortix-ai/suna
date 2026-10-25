/**
 * The block turn model: a session-log thread as turns (a user message, its replies), with the
 * fields a transcript derives from a turn computed once. Framework-free; the v1 turn helpers in
 * `core/turns` are the behavioral spec (`oracle.test.ts` holds the equivalence).
 *
 * Rules (`group.test.ts`):
 * - A user `turn` message opens a turn; a `context` message and a `system` message do not. A
 *   `compaction` message is a turn: the marker, with its summary in its compaction block.
 * - A reply joins the turn `reply_to` names, else the latest prompt before it. A reply before
 *   every loaded prompt opens a `partial` turn (a stand-in user message with no blocks) when
 *   it names a prompt, else joins the first turn. A reply after a compaction that its turn
 *   precedes (pi compacts inside a turn and keeps naming the prompt) joins the compaction's
 *   continuation: a `partial` turn `<marker id>:continued` right after the marker, and the
 *   working turn when the working projection names the prompt or the marker. A reply shell with no block, no error and
 *   zero usage is not drawn. A message out of context stays (a failed attempt keeps its rows)
 *   unless `hideOutOfContext` leaves it out.
 * - `held` prompts (the inbox still holds them) go after the thread, in the order given.
 * - A turn keeps its identity while its messages and derived fields do.
 */
import type { SessionPrompt } from '../../rest/projects-client/sessions';
import { extractGatewayErrorDetails, rawErrorText, unwrapError, type GatewayErrorDetails } from '../../turns/errors';
import { hasRetryingAssistantTurn } from '../../turns/open-turn';
import { getChildSessionId, shouldShowToolPart } from '../../turns/parts';
import { resolveWorkingTurn } from '../../turns/segments/working-turn';
import { getTurnCost } from '../../turns/state';
import { toolKind } from '../../turns/tool-kind';
import type { ModelPricingLookup, TurnCostInfo } from '../../turns/types';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  type AttachmentBlock,
  type CompactionBlock,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogThread,
  type TextBlock,
  type ToolCallBlock,
} from '../types';
import { isV1Thread } from '../v1-view';
import { messageOfBlock, v1RowsOf } from './v1-parts';

/** The producer `fromV1` stamps on every message it converts. */
const V1_IMPORT = 'kortix-v1-import';

/** The turn's state: `pending` before a reply, else the last reply's `status` (`streaming` while a reply retries). */
export type SessionLogTurnStatus = 'pending' | SessionLogMessage['status'];

/** The effective status of a tool call on a turn, see {@link sessionLogCallStatus}. */
export type SessionLogCallStatus = ToolCallBlock['status'] | 'interrupted';

export interface SessionLogTurnError {
  /** The schema code (`SessionLogMessage['error']['code']`). */
  code: string;
  /** The sentence to show: the gateway's own, else the message unwrapped (`unwrapError`). */
  message: string;
  /** The gateway's structured fields, when the message carries its envelope. */
  details?: GatewayErrorDetails;
  /** The technical text behind `message`, when it says more than the sentence. */
  raw?: string;
}

export interface SessionLogCompaction {
  block: CompactionBlock | null;
  /** The summary is here and not blank. */
  hasContent: boolean;
  /** The compaction is still running (the marker streams). */
  inFlight: boolean;
}

/** {@link SessionLogTurn.continues}. */
export interface SessionLogContinuation {
  marker: string;
  prompt: string | null;
}

export interface SessionLogTurn {
  /** The user message id, the turn's key. */
  id: string;
  user: SessionLogMessage;
  /** The replies, in record order. */
  assistant: SessionLogMessage[];
  /** The prompt is not loaded: `user` is a stand-in with its id and no blocks. */
  partial: boolean;
  /**
   * The work after a compaction inside a turn (a `partial` turn `<marker>:continued` right after
   * the marker): the marker's id and the prompt the replies name (null when they name none). The
   * working projection still names that prompt or the marker. Null on every other turn.
   */
  continues: SessionLogContinuation | null;
  /** Every block of every reply, in order. */
  blocks: SessionLogBlock[];
  status: SessionLogTurnStatus;
  /** The first error on the turn (the marker's on a compaction, else the first errored reply). */
  error: SessionLogTurnError | null;
  /** The replies' usage priced with the platform markup; null when no reply reports usage. */
  cost: TurnCostInfo | null;
  compaction: SessionLogCompaction | null;
  /** The sub-threads this turn spawned, by `spawned_by`, a subtask block, or a task call's child id. */
  threads: string[];
  /** This turn owns the plan card: the last turn that wrote the todo list, else the last turn. */
  plan: boolean;
  /** Shell mode: a synthetic prompt answered by one bare `bash` call, that call. */
  shell: ToolCallBlock | null;
  /** The response: the last non-blank text block of the replies. */
  response: TextBlock | null;
  /** The prompt's image and PDF attachments. */
  attachments: AttachmentBlock[];
  /** The agent is on this turn now (`busy` and the working turn). */
  live: boolean;
  /** The agent has not reached this prompt yet. */
  queued: boolean;
  /** The session's last reply is on this turn and retries a provider error (v1 records only: a native record carries no retry flag). */
  retrying: boolean;
  /**
   * The turn's prompt is the harness's own continuation, not a person's message: every block is
   * a `synthetic` text block the harness marked (an auto-recovery prompt, KRTX-2597). The
   * transcript renders no bubble for it; the turn exists so the live and working logic keep
   * working while the harness retries.
   */
  internal: boolean;
  /**
   * How an automatic-retry chain reads around this turn (KRTX-2597). `continued`: this turn
   * errored and a system continuation turn follows, so its error row yields to that turn's
   * outcome. `retries`: automatic retries before this turn's own error is the terminal one —
   * the one error row the chain shows. Present only when one of the two applies.
   */
  autoRetry?: { continued: boolean; retries: number };
}

export interface SessionLogTurnsOptions {
  /** Fold compactions and their continuation work into the preceding prompt. Default false. */
  foldCompactions?: boolean;
  /** The session is working (the composer shows Stop). Default false: no turn is live. */
  busy?: boolean;
  /** The user message id the working projection names (`WorkingProjection.turnId`), when it names one. */
  liveMessageId?: string | null;
  /** The user message ids the inbox still holds (`queued`, `waiting`, `delivering`), in the queue's order. */
  held?: readonly string[];
  /** The session's threads, so a turn lists the sub-threads it spawned. */
  threads?: ReadonlyArray<Pick<SessionLogThread, 'thread_id' | 'spawned_by'>>;
  /** Prices a reply whose usage reports no cost. */
  pricing?: ModelPricingLookup;
  /**
   * Leave out every message the model does not see (`in_context: false`: a failed attempt, an
   * aborted empty reply, an old root's history), except one still streaming (a compaction
   * marker until its summary lands). Default false: they keep their turns.
   */
  hideOutOfContext?: boolean;
}

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
/** The last item that passes `test` (the ES2023 array method needs a lib not every consumer compiles with). */
function last<T, U extends T>(list: readonly T[], test: (item: T) => item is U): U | undefined;
function last<T>(list: readonly T[], test: (item: T) => boolean): T | undefined;
function last<T>(list: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i]!)) return list[i];
  return undefined;
}
const isCall = (b: SessionLogBlock): b is ToolCallBlock => b.type === 'tool_call';
const isOpen = (b: ToolCallBlock) => b.status === 'pending' || b.status === 'running';
/** Closed by the harness, not by the tool (C2/F11 closure rule): the call never ended. Internal (not in the barrel). */
export const isClosedByRule = (b: ToolCallBlock) => b.status === 'error' && (b.result?.synthetic === true || b.result?.error?.code === 'interrupted');

/**
 * The status a tool call renders with. An open call (`pending`, `running`) and a call the
 * closure rule closed count as open: on a live turn they are in progress (`running` once
 * started, else `pending`); on any other turn they were interrupted. A call the tool ended
 * keeps its own status.
 */
export function sessionLogCallStatus(call: ToolCallBlock, live: boolean): SessionLogCallStatus {
  const closed = isClosedByRule(call);
  if (!isOpen(call) && !closed) return call.status;
  if (!live) return 'interrupted';
  return call.status === 'running' || (closed && call.started_at) ? 'running' : 'pending';
}

const prompts = new WeakMap<SessionPrompt, SessionLogMessage>();

/**
 * The user message of an inbox prompt the thread has not placed yet (a queued send), to
 * append after the thread's messages and name in `held`. Its id is the prompt's `message_id`,
 * else `queued-<prompt_id>`; its text block is `syn-<prompt_id>`. One message per prompt object.
 */
export function sessionLogPromptMessage(prompt: SessionPrompt, threadId: string): SessionLogMessage {
  const cached = prompts.get(prompt);
  if (cached) return cached;
  const ms = typeof prompt.client_sent_at_ms === 'number' ? prompt.client_sent_at_ms : Date.parse(prompt.created_at);
  const message: SessionLogMessage = {
    ...V, message_id: prompt.message_id || `queued-${prompt.prompt_id}`, thread_id: threadId, seq: Number.MAX_SAFE_INTEGER, role: 'user', kind: 'turn',
    status: 'complete', in_context: true, origin: 'prompt', model: null, usage: null, finish: null, error: null,
    created_at: Number.isFinite(ms) ? new Date(ms).toISOString() : '', completed_at: null,
    producer: { harness: 'kortix-inbox', harness_version: '', adapter_version: '1' },
    blocks: [{ type: 'text', id: `syn-${prompt.prompt_id}`, text: prompt.full_text ?? prompt.text }],
  };
  prompts.set(prompt, message);
  return message;
}

// ─── grouping ────────────────────────────────────────────────────────────────

type Draft = { user: SessionLogMessage; assistant: SessionLogMessage[]; partial: boolean; continues?: SessionLogContinuation };

const standIns = new WeakMap<SessionLogMessage, SessionLogMessage>();

/** The stand-in for an unloaded prompt, one per first reply object. */
function standInFor(reply: SessionLogMessage): SessionLogMessage {
  let m = standIns.get(reply);
  if (!m) {
    m = {
      ...V, message_id: reply.reply_to!, thread_id: reply.thread_id, seq: reply.seq, role: 'user', kind: 'turn', status: 'complete', in_context: true,
      model: null, usage: null, finish: null, error: null, created_at: reply.created_at, completed_at: null, producer: reply.producer, blocks: [],
    };
    standIns.set(reply, m);
  }
  return m;
}

const continuations = new WeakMap<SessionLogMessage, SessionLogMessage>();

/** The stand-in prompt of the work after a compaction inside a turn, one per marker object. */
function continuationOf(marker: SessionLogMessage): SessionLogMessage {
  let m = continuations.get(marker);
  if (!m) {
    m = {
      ...V, message_id: `${marker.message_id}:continued`, thread_id: marker.thread_id, seq: marker.seq, role: 'user', kind: 'turn', status: 'complete', in_context: true,
      model: null, usage: null, finish: null, error: null, created_at: marker.created_at, completed_at: null, producer: marker.producer, blocks: [],
    };
    continuations.set(marker, m);
  }
  return m;
}

/** An assistant shell the runtime persisted before any content: an audit record, not a response. */
const isEmptyShell = (m: SessionLogMessage) =>
  !m.error && m.blocks.length === 0 && !(m.usage && (m.usage.input || m.usage.output || m.usage.reasoning));

function drafts(messages: readonly SessionLogMessage[], held: ReadonlySet<string>): Draft[] {
  const turns: Draft[] = [];
  const byId = new Map<string, Draft>();
  for (const m of messages) {
    if (m.role !== 'user' || m.kind === 'context' || byId.has(m.message_id)) continue;
    const d = { user: m, assistant: [], partial: false };
    byId.set(m.message_id, d);
    turns.push(d);
  }
  const partials: Draft[] = [];
  const leading: SessionLogMessage[] = [];
  // The order prompts were read in, and each compaction's continuation, made at its first reply.
  const order = new Map<Draft, number>();
  const continued = new Map<Draft, Draft>();
  let last: Draft | null = null;
  let compaction: Draft | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      const d = byId.get(m.message_id);
      if (d && !held.has(m.message_id)) {
        last = d;
        if (!order.has(d)) order.set(d, order.size);
        if (d.user.kind === 'compaction') compaction = d;
      }
      continue;
    }
    if (m.role !== 'assistant' || isEmptyShell(m)) continue;
    const named = m.reply_to ? byId.get(m.reply_to) : undefined;
    let home = named ?? last;
    if (compaction && home && (home === compaction || (order.get(home) ?? Infinity) < order.get(compaction)!)) {
      let next = continued.get(compaction);
      if (!next) {
        next = { user: continuationOf(compaction.user), assistant: [], partial: true, continues: { marker: compaction.user.message_id, prompt: home === compaction ? null : home.user.message_id } };
        continued.set(compaction, next);
      }
      home = next;
    }
    if (home) {
      home.assistant.push(m);
      continue;
    }
    if (!m.reply_to) {
      leading.push(m);
      continue;
    }
    const current = partials[partials.length - 1];
    if (current && current.user.message_id === m.reply_to) current.assistant.push(m);
    else partials.push({ user: standInFor(m), assistant: [m], partial: true });
  }
  if (leading.length) {
    const first = turns[0] ?? partials[0];
    if (first) first.assistant.unshift(...leading);
    else turns.push({ user: leading[0]!, assistant: leading.slice(1), partial: false });
  }
  const shown = turns.filter((t) => !held.has(t.user.message_id)).flatMap((t) => {
    const next = continued.get(t);
    return next ? [t, next] : [t];
  });
  return [...partials, ...shown, ...[...held].flatMap((id) => byId.get(id) ?? [])];
}

/** Keep the existing continuation ownership, but draw its work under the original prompt. */
function foldCompactionDrafts(list: Draft[], hint: string | null | undefined): { list: Draft[]; hint: string | null | undefined } {
  const folded: Draft[] = [];
  const homes = new Map<string, Draft>();
  let liveHint = hint;
  for (const draft of list) {
    const previous = folded[folded.length - 1];
    const home = draft.continues ? homes.get(draft.continues.marker)
      : draft.user.kind === 'compaction' && previous?.user.kind !== 'compaction' ? previous : undefined;
    if (!home) {
      folded.push({ ...draft, assistant: [...draft.assistant] });
      continue;
    }
    homes.set(draft.user.message_id, home);
    if (draft.user.kind === 'compaction') home.assistant.push(draft.user);
    home.assistant.push(...draft.assistant);
    if (hint === draft.user.message_id) liveHint = home.user.message_id;
  }
  return { list: folded, hint: liveHint };
}

/** The turn the working projection means: a prompt or a marker whose work continued below a compaction names its last continuation. */
function continuedHint(list: readonly Draft[], hint: string | null | undefined): string | null | undefined {
  if (!hint) return hint;
  let out = hint;
  for (const d of list) {
    const c = d.continues;
    if (c && (out === c.marker || out === c.prompt || hint === c.prompt)) out = d.user.message_id;
  }
  return out;
}

// ─── derived fields ──────────────────────────────────────────────────────────

function errorOf(d: Draft): SessionLogTurnError | null {
  const sources = d.user.kind === 'compaction' ? [d.user, ...d.assistant] : d.assistant;
  const m = sources.find((x) => x.error);
  if (!m?.error) return null;
  // The v1 error object: exact for a converted record (the gateway body an OpenCode `APIError`
  // keeps in `responseBody` is in the residual; the schema's `error.message` has only
  // `data.message`), `{ name, data: { message } }` for a native one.
  const error = (v1RowsOf(m)[0]?.info as { error?: unknown } | undefined)?.error ?? m.error.message;
  const details = extractGatewayErrorDetails(error);
  const raw = rawErrorText(error);
  return { code: m.error.code, message: details?.message || unwrapError(error), ...(details && { details }), ...(raw !== undefined && { raw }) };
}

/**
 * `getTurnCost` of the replies. A v1-derived message (`exact`: a `fromV1` thread, or a row
 * `fromV1` converted) is priced over its own v1 parts, so the result is v1's to the token
 * (OpenCode's `info.tokens` is not the sum of a multi-step reply's step-finish parts, and a
 * reply with no step part and no price counts nothing). A native record carries no step
 * totals: one synthetic step-finish per reply that reports usage prices it.
 */
function costOf(replies: SessionLogMessage[], exact: (m: SessionLogMessage) => boolean, lookup?: ModelPricingLookup): TurnCostInfo | null {
  if (replies.length && replies.every(exact)) {
    return getTurnCost(replies.flatMap((m) => v1RowsOf(m).flatMap((row) => row.parts.map((part) => ({ part, message: row })))), lookup) ?? null;
  }
  return usageCostOf(replies, lookup);
}

/**
 * `getTurnCost` over one synthetic step-finish per message that reports usage: every reply's
 * own `usage`, its `cost` as reported, else priced through the lookup. Internal: the thread
 * metrics (a context modal's totals) price every reply this way.
 */
export function usageCostOf(replies: SessionLogMessage[], lookup?: ModelPricingLookup): TurnCostInfo | null {
  const parts = replies.flatMap((m) => {
    const u = m.usage;
    if (!u) return [];
    const part = { type: 'step-finish', cost: u.cost ?? 0, tokens: { input: u.input, output: u.output, reasoning: u.reasoning ?? 0, cache: { read: u.cache_read, write: u.cache_write } } };
    return [{ part, message: { info: { id: m.message_id, role: 'assistant', providerID: m.model?.provider, modelID: m.model?.model }, parts: [part] } }];
  });
  return getTurnCost(parts, lookup) ?? null;
}

function compactionOf(user: SessionLogMessage): SessionLogCompaction | null {
  if (user.kind !== 'compaction') return null;
  const block = user.blocks.find((b): b is CompactionBlock => b.type === 'compaction') ?? null;
  return { block, hasContent: !!block?.summary?.trim(), inFlight: user.status === 'streaming' };
}

function shellOf(d: Draft): ToolCallBlock | null {
  const prompt = d.user.blocks;
  if (!prompt.length || !prompt.every((b) => b.type === 'text' && b.synthetic)) return null;
  const only = d.assistant.length === 1 && d.assistant[0]!.blocks.length === 1 ? d.assistant[0]!.blocks[0]! : null;
  return only && isCall(only) && only.name === 'bash' ? only : null;
}

function threadsOf(d: Draft, blocks: SessionLogBlock[], heads: NonNullable<SessionLogTurnsOptions['threads']>, known: ReadonlySet<string>): string[] {
  if (!heads.length) return [];
  const replies = new Set(d.assistant.map((m) => m.message_id));
  const out = new Set<string>();
  for (const h of heads) if (h.spawned_by && replies.has(h.spawned_by.message_id)) out.add(h.thread_id);
  for (const b of blocks) {
    const id = b.type === 'subtask' ? b.thread_id : isCall(b) ? getChildSessionId(b) : undefined;
    if (id && known.has(id)) out.add(id);
  }
  return [...out];
}

const writesPlan = (d: Draft) => d.assistant.some((m) => m.blocks.some((b) => isCall(b) && toolKind(b.name) === 'todowrite' && shouldShowToolPart(b)));

/**
 * The harness's own continuation prompt (an auto-recovery, KRTX-2597): every block is a
 * `synthetic` text block the harness marked on the wire, so no person wrote this prompt. A
 * person's prompt with harness context attached (mixed synthetic + real text) is not internal;
 * an unloaded prompt's stand-in (no blocks) is not either.
 */
const isInternalPrompt = (m: SessionLogMessage) =>
  m.blocks.length > 0 && m.blocks.every((b) => b.type === 'text' && b.synthetic === true);

/**
 * The automatic-retry chain around each turn, from the turn list's order: a turn whose next
 * turn is an internal continuation yields its error row to that turn's outcome, and a chain's
 * terminal turn counts the automatic retries that led to it. `internal` is index-aligned with
 * the drafts (the same flags the turn fields read).
 */
function autoRetryOf(list: readonly Draft[], internal: readonly boolean[]): ({ continued: boolean; retries: number } | undefined)[] {
  const errored = list.map((d) => errorOf(d) !== null);
  const continued = list.map((_, i) => errored[i] === true && internal[i + 1] === true);
  return list.map((_, i) => {
    // A continued turn yields its row: it is never a chain's end, so its retries stay 0.
    if (continued[i]!) return { continued: true, retries: 0 };
    if (!errored[i]!) return undefined;
    let retries = 0;
    for (let j = i - 1; j >= 0 && continued[j]!; j--) retries += 1;
    return retries > 0 ? { continued: false, retries } : undefined;
  });
}

const cache = new WeakMap<SessionLogMessage, { assistant: SessionLogMessage[]; key: string; pricing: ModelPricingLookup | undefined; heads: unknown; turn: SessionLogTurn }>();
const NONE: readonly string[] = [];

/**
 * The thread's last reply is open and retries a provider error (`hasRetryingAssistantTurn`):
 * `SessionLogTurn.retrying` of its turn, read without grouping turns, so a host can feed it to
 * the busy state it then passes to {@link sessionLogTurns}. A native record carries no retry
 * flag: false.
 */
export function sessionLogRetrying(thread: Pick<SessionLogThread, 'messages'>): boolean {
  const reply = last(thread.messages, (m) => m.role === 'assistant');
  return !!reply && hasRetryingAssistantTurn(v1RowsOf(reply));
}

const inContext = new WeakMap<SessionLogThread, SessionLogThread>();
/** `thread` without the messages the model does not see, a streaming one kept; one object per thread. */
function inContextOnly(thread: SessionLogThread): SessionLogThread {
  let out = inContext.get(thread);
  if (!out) {
    const messages = thread.messages.filter((m) => m.in_context || m.status === 'streaming');
    out = messages.length === thread.messages.length ? thread : { ...thread, messages };
    inContext.set(thread, out);
  }
  return out;
}

/** The turns of `thread`, see the module header. */
export function sessionLogTurns(source: SessionLogThread, options: SessionLogTurnsOptions = {}): SessionLogTurn[] {
  const thread = options.hideOutOfContext ? inContextOnly(source) : source;
  const held = new Set(options.held ?? NONE);
  const raw = drafts(thread.messages, held);
  const continued = continuedHint(raw, options.liveMessageId);
  const { list, hint } = options.foldCompactions ? foldCompactionDrafts(raw, continued) : { list: raw, hint: continued };
  const lastReply = last(thread.messages, (m) => m.role === 'assistant');
  const retrying = sessionLogRetrying(thread);
  const working = resolveWorkingTurn({
    turns: list.map((d) => ({
      userMessage: { info: { id: d.user.message_id } },
      assistantMessages: d.assistant.map((m) => ({ info: { time: m.status === 'streaming' ? {} : { completed: 1 }, error: m.error ?? undefined } })),
    })),
    hintMessageId: hint,
    unrunTurnIds: held,
  });
  const anchor = last(list, writesPlan) ?? list[list.length - 1];
  const internalPrompts = list.map((d) => !d.partial && isInternalPrompt(d.user));
  const autoRetry = autoRetryOf(list, internalPrompts);
  const v1Thread = isV1Thread(thread);
  const exact = (m: SessionLogMessage) => v1Thread || m.producer.harness === V1_IMPORT;
  const heads = options.threads ?? [];
  const known = new Set(heads.map((h) => h.thread_id));
  return list.map((d, i) => {
    const live = options.busy === true && working.workingTurnId === d.user.message_id;
    const queued = working.pendingTurnIds.includes(d.user.message_id);
    const retries = retrying && d.assistant.includes(lastReply!);
    const chain = autoRetry[i];
    const key = `${d.partial}|${live}|${queued}|${d === anchor}|${retries}|${chain ? (chain.continued ? 'c' : '') + chain.retries : '-'}`;
    const prev = cache.get(d.user);
    if (prev && prev.key === key && prev.pricing === options.pricing && prev.heads === options.threads && prev.assistant.length === d.assistant.length && prev.assistant.every((m, i) => m === d.assistant[i])) return prev.turn;
    const blocks = d.assistant.flatMap((m) => m.blocks);
    for (const m of d.assistant) for (const b of m.blocks) messageOfBlock.set(b, m);
    const threads = threadsOf(d, blocks, heads, known);
    const reply = d.assistant[d.assistant.length - 1];
    const turn: SessionLogTurn = {
      internal: internalPrompts[i]!,
      autoRetry: chain,
      id: d.user.message_id,
      user: d.user,
      assistant: d.assistant,
      partial: d.partial,
      continues: d.continues ?? null,
      blocks,
      status: retries ? 'streaming' : reply ? reply.status : d.user.kind === 'compaction' ? d.user.status : 'pending',
      error: errorOf(d),
      // A prompt has no usage. A compaction's is its summary reply's (folded onto the marker), and a
      // thread with no prompt heads its turn with a reply: both are priced like any reply.
      cost: costOf([d.user, ...d.assistant], exact, options.pricing),
      compaction: compactionOf(d.user),
      threads,
      plan: d === anchor,
      shell: shellOf(d),
      response: last(blocks, (b): b is TextBlock => b.type === 'text' && !!b.text.trim()) ?? null,
      attachments: d.user.blocks.filter((b): b is AttachmentBlock => b.type === 'attachment' && (b.mime.startsWith('image/') || b.mime === 'application/pdf')),
      live,
      queued,
      retrying: retries,
    };
    cache.set(d.user, { assistant: d.assistant, key, pricing: options.pricing, heads: options.threads, turn });
    return turn;
  });
}
