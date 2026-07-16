import { contentAttachments, contentText, textFromContent } from './content';
import type { AcpJsonRpcId } from './types';
import type {
  AcpChatItem,
  AcpPendingOption,
  AcpPendingPermission,
  AcpPendingPrompts,
  AcpPendingQuestion,
  AcpPendingQuestionItem,
  AcpPlan,
  AcpStoredEnvelope,
  AcpToolCall,
  AcpTokenUsage,
  AcpTurnState,
  AcpUsageProjection,
} from './transcript';

/** `Array.prototype.findLastIndex` (ES2023) reimplemented as a manual reverse
 *  scan — this package targets an ES2017-safe runtime floor, and apps/api
 *  compiles this source through workspace paths under an older `lib`. Same
 *  semantics: index of the last element satisfying `predicate`, or -1. */
function findLastIndex<T>(items: readonly T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T, index)) return index;
  }
  return -1;
}

/**
 * Incremental, structurally-shared ACP transcript reducer.
 *
 * This is the ONE implementation `projectAcpChatItems` / `projectAcpUsage` /
 * `projectAcpTurnState` / `projectAcpPendingPrompts` (in `./transcript`) fold
 * from scratch over — `rows.reduce(reduceEnvelope, emptyReducerState())` plus
 * a selector. `AcpSession` (`./session`) instead folds row-by-row as
 * envelopes arrive, carrying `AcpReducerState` forward so a flush costs
 * O(batch) instead of O(n) full reprojection.
 *
 * `chatItems` is the only field under an explicit identity contract:
 * `reduceEnvelope` never mutates the previous state, `chatItems` is copied
 * shallowly, and only the item a given row actually touches gets a new
 * object identity — every other item keeps its previous reference so a
 * consumer diffing by reference (e.g. React) does no unnecessary work.
 */
export type AcpReducerState = {
  envelopes: AcpStoredEnvelope[];
  chatItems: AcpChatItem[];
  /** toolCallId -> index into `chatItems`, so a `tool_call_update` merges in
   *  O(1) instead of `items.find(...)`. */
  toolIndex: Map<string, number>;
  /** `rpcIdKey(id)` of every JSON-RPC request (any direction) that has since
   *  received a `result`/`error` response — grows monotonically, mirrors
   *  `projectAcpPendingPrompts`' whole-array "answered" pre-pass. */
  answeredIds: Set<string>;
  /** Still-unanswered permission/question chat items, keyed by
   *  `rpcIdKey(id)` — a response row deletes its entry. `pendingFromState`
   *  re-derives the full `AcpPendingPermission`/`AcpPendingQuestion` shape
   *  from the `params` each entry already carries. */
  openRequests: Map<string, AcpChatItem>;
  /** Ordinal-ordering backstop for `openRequests`: the `row.ordinal` of the
   *  request currently held open for a given `rpcIdKey(id)`. Old persisted
   *  logs used small numeric JSON-RPC ids, which a later, wholly unrelated
   *  request can legitimately reuse once its earlier occupant has been
   *  answered — a response only closes the entry it is ordinally paired
   *  with (its recorded ordinal must precede the response's), so a NEW
   *  request that reopens a reused id is never mistaken for already
   *  answered. With the string ids AcpClient mints for new traffic
   *  (`${epochMs}-${counter}`) this collision is practically impossible;
   *  this map exists to protect OLD persisted logs with numeric ids. */
  openRequestOrdinals: Map<string, number>;
  usage: AcpUsageProjection | null;
  turnState: AcpTurnState;

  // Internal bookkeeping below this line: not part of the documented
  // contract (`emptyReducerState`/`reduceEnvelope`/`pendingFromState`'s
  // callers never need to read these directly), but carried on the state so
  // a fold never re-scans `envelopes` to answer a dedup / usage / pending
  // prompt question — that scan is exactly the O(n) cost this reducer
  // exists to remove.
  /** `${direction}:${streamEventId}` of every row already folded, for O(1)
   *  duplicate detection. */
  dedupeKeys: Set<string>;
  usageContext: Omit<AcpUsageProjection, 'tokens'> | null;
  usageTokens: AcpTokenUsage | null;
  /** `rpcIdKey(id)` of `session/prompt` requests answered by an
   *  `agent_to_client` response — the narrower answered-set `turnState`
   *  uses (`projectAcpTurnState` only looks at `agent_to_client` responses,
   *  unlike `answeredIds` above which is direction-agnostic). */
  promptAnsweredIds: Set<string>;
  /** Still-unanswered `session/prompt` ids, keyed by `rpcIdKey(id)`,
   *  insertion-ordered (JS `Map` preserves insertion order) to match
   *  `projectAcpTurnState`'s row-order `pendingPromptIds` array. */
  openPromptIds: Map<string, AcpJsonRpcId>;
  /** Same ordinal-ordering backstop as `openRequestOrdinals`, for
   *  `openPromptIds`. */
  openPromptOrdinals: Map<string, number>;
  /** `params.sessionId` (when present) of each still-open `session/prompt`,
   *  keyed by `rpcIdKey(id)` — the busy-staleness policy uses this so a
   *  LATER `session/cancel` or superseding `session/prompt` only clears open
   *  prompts belonging to the SAME session, never a different one that might
   *  (in principle) appear in the same log. See `reduceEnvelope`'s
   *  `session/prompt`/`session/cancel` branches. */
  openPromptSessionIds: Map<string, string | undefined>;
};

export function emptyReducerState(): AcpReducerState {
  return {
    envelopes: [],
    chatItems: [],
    toolIndex: new Map(),
    answeredIds: new Set(),
    openRequests: new Map(),
    openRequestOrdinals: new Map(),
    usage: null,
    turnState: { busy: false, pendingPromptIds: [] },
    dedupeKeys: new Set(),
    usageContext: null,
    usageTokens: null,
    promptAnsweredIds: new Set(),
    openPromptIds: new Map(),
    openPromptOrdinals: new Map(),
    openPromptSessionIds: new Map(),
  };
}

/**
 * Explicit exact-match classification for JSON-RPC methods that render as a
 * pending-response chat item instead of `raw`. Replaces the old
 * substring-sniffing `isPermissionMethod`/`isQuestionMethod` pair, which
 * misclassified e.g. `session/request` (contains `"request"`) as a
 * question — this table only matches methods it names exactly.
 */
export type AcpMethodKind = 'permission' | 'question' | 'raw';
export type AcpMethodClassifier = (method: string) => AcpMethodKind;

const METHOD_KINDS: Record<string, AcpMethodKind> = {
  'session/request_permission': 'permission',
  'elicitation/create': 'question',
  'elicitation/request': 'question',
  'session/request_input': 'question',
};

export const classifyAcpMethod: AcpMethodClassifier = (method) => METHOD_KINDS[method] ?? 'raw';

/** `session/update` kinds that carry no visual chat item of their own —
 *  `usage_update` still feeds `projectAcpUsage` via the usage bookkeeping
 *  block below; this only excludes them from `chatItems`. */
const NON_VISUAL_UPDATES = new Set(['usage_update', 'current_mode_update', 'available_commands_update']);

/** A tool call that has reached one of these statuses is done; a later
 *  update (e.g. a stray/out-of-order `in_progress`) must never regress it
 *  back to a non-terminal status. */
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled']);

type ReduceOptions = {
  /** Overrides `classifyAcpMethod` for this fold. Defaults to the table. */
  classifyMethod?: AcpMethodClassifier;
};

/**
 * Folds one persisted/live ACP envelope row onto `state`. Returns a NEW
 * state object; never mutates `state` or anything it references. A row
 * whose `streamEventId` matches an already-folded `(streamEventId,
 * direction)` pair is a no-op that returns `state` itself (reference-equal)
 * — callers use that identity to detect "nothing changed" without a second
 * dedup pass.
 */
export function reduceEnvelope(state: AcpReducerState, row: AcpStoredEnvelope, options?: ReduceOptions): AcpReducerState {
  const classifyMethod = options?.classifyMethod ?? classifyAcpMethod;
  if (row.streamEventId != null) {
    const dedupeKey = `${row.direction}:${row.streamEventId}`;
    if (state.dedupeKeys.has(dedupeKey)) return state;
  }

  const envelope = row.envelope as Record<string, any>;

  let chatItems = state.chatItems;
  let toolIndex = state.toolIndex;
  let answeredIds = state.answeredIds;
  let openRequests = state.openRequests;
  let openRequestOrdinals = state.openRequestOrdinals;
  let usageContext = state.usageContext;
  let usageTokens = state.usageTokens;
  let promptAnsweredIds = state.promptAnsweredIds;
  let openPromptIds = state.openPromptIds;
  let openPromptOrdinals = state.openPromptOrdinals;
  let openPromptSessionIds = state.openPromptSessionIds;

  // ── chat items + turn-state bookkeeping: a client's `session/prompt` ──
  if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
    const text = contentText(envelope.params?.prompt);
    const attachments = contentAttachments(envelope.params?.prompt);
    if (text || attachments.length) {
      chatItems = [...chatItems, {
        kind: 'message',
        id: `prompt-${row.ordinal}`,
        role: 'user',
        text,
        ...(attachments.length ? { attachments } : {}),
      }];
    }
    const id = envelope.id;
    const promptSessionId = firstString(envelope.params?.sessionId);
    // Busy-staleness policy, half (b): ANY new `session/prompt` request row
    // — including `AcpSession.send()`'s `local-` prefixed optimistic echo,
    // which never itself becomes a tracked pending prompt below — means a
    // still-open EARLIER prompt for the same session is no longer the live
    // turn. Without this, a reload mid-turn (which persists an orphaned,
    // never-answered/never-cancelled prompt) would wedge `busy` true
    // forever, even after the user successfully sends a brand-new message.
    const isLocalId = typeof id === 'string' && id.startsWith('local-');
    const newKey = isLocalId ? null : rpcIdKey(id);
    if (openPromptIds.size > 0) {
      const staleKeys = [...openPromptIds.keys()].filter(
        (openKey) => openKey !== newKey && sessionsMatch(openPromptSessionIds.get(openKey), promptSessionId),
      );
      if (staleKeys.length) {
        openPromptIds = new Map(openPromptIds);
        openPromptOrdinals = new Map(openPromptOrdinals);
        openPromptSessionIds = new Map(openPromptSessionIds);
        for (const staleKey of staleKeys) {
          openPromptIds.delete(staleKey);
          openPromptOrdinals.delete(staleKey);
          openPromptSessionIds.delete(staleKey);
        }
      }
    }
    if ((typeof id === 'string' || typeof id === 'number') && !(typeof id === 'string' && id.startsWith('local-'))) {
      const key = rpcIdKey(id);
      // Always (re)open on a new request row — an id previously answered
      // does NOT block reopening it. Old persisted logs reuse small numeric
      // ids across unrelated requests once the earlier occupant is done;
      // gating on `promptAnsweredIds` here would permanently mark every
      // future request reusing that id as pre-answered. The ordinal in
      // `openPromptOrdinals` is what lets a later response tell "this new
      // request" apart from "the old, already-closed one".
      openPromptIds = new Map(openPromptIds);
      openPromptIds.set(key, id);
      openPromptOrdinals = new Map(openPromptOrdinals);
      openPromptOrdinals.set(key, row.ordinal);
      openPromptSessionIds = new Map(openPromptSessionIds);
      openPromptSessionIds.set(key, promptSessionId);
    }
  } else if (row.direction === 'client_to_agent' && envelope.method === 'session/cancel') {
    // Busy-staleness policy, half (a): a `session/cancel` notification for a
    // session clears every currently-open prompt belonging to that session —
    // it is a notification (no `id`), so there is never a matching response
    // row to close them the ordinary way.
    const cancelSessionId = firstString(envelope.params?.sessionId);
    if (openPromptIds.size > 0) {
      const staleKeys = [...openPromptIds.keys()].filter((openKey) =>
        sessionsMatch(openPromptSessionIds.get(openKey), cancelSessionId));
      if (staleKeys.length) {
        openPromptIds = new Map(openPromptIds);
        openPromptOrdinals = new Map(openPromptOrdinals);
        openPromptSessionIds = new Map(openPromptSessionIds);
        for (const staleKey of staleKeys) {
          openPromptIds.delete(staleKey);
          openPromptOrdinals.delete(staleKey);
          openPromptSessionIds.delete(staleKey);
        }
      }
    }
  } else if (row.direction === 'agent_to_client' && typeof envelope.method === 'string') {
    if (envelope.method === 'session/update') {
      const update = envelope.params?.update ?? {};
      const kind = update.sessionUpdate ?? update.type;
      const text = textFromContent(update.content).join('');
      const attachments = contentAttachments(update.content);
      if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && (text || attachments.length)) {
        const role = kind === 'agent_thought_chunk' ? 'thought' : 'assistant';
        const previous = chatItems.at(-1);
        if (previous?.kind === 'message' && previous.role === role) {
          const merged: AcpChatItem = {
            ...previous,
            text: previous.text + text,
            ...(attachments.length ? { attachments: [...(previous.attachments ?? []), ...attachments] } : {}),
          };
          chatItems = [...chatItems.slice(0, -1), merged];
        } else {
          chatItems = [...chatItems, {
            kind: 'message',
            id: `${role}-${row.ordinal}`,
            role,
            text,
            ...(attachments.length ? { attachments } : {}),
          }];
        }
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = String(update.toolCallId ?? update.id ?? `tool-${row.ordinal}`);
        const projected = projectToolCall(id, update);
        const existingIndex = toolIndex.get(id);
        if (existingIndex != null) {
          const existing = chatItems[existingIndex] as Extract<AcpChatItem, { kind: 'tool' }>;
          const merged = mergeToolCall(existing, projected);
          const nextItems = chatItems.slice();
          nextItems[existingIndex] = { kind: 'tool', ...merged };
          chatItems = nextItems;
        } else {
          toolIndex = new Map(toolIndex);
          toolIndex.set(id, chatItems.length);
          chatItems = [...chatItems, { kind: 'tool', ...projected }];
        }
      } else if (kind === 'plan') {
        // Per-turn plan: a `plan` update creates/updates the plan item for
        // the CURRENT turn only. The current turn is everything after the
        // most recent user prompt (chat item at `lastUserIndex`); scanning
        // backwards from the tail and stopping at that boundary finds this
        // turn's existing plan item without ever touching a PRIOR turn's.
        const plan: AcpPlan = { entries: Array.isArray(update.entries) ? update.entries : [], data: update as Record<string, unknown> };
        const lastUserIndex = findLastIndex(chatItems, (item) => item.kind === 'message' && item.role === 'user');
        const existingIndex = findLastIndex(
          chatItems,
          (item, index) => index > lastUserIndex && item.kind === 'plan',
        );
        if (existingIndex !== -1) {
          const nextItems = chatItems.slice();
          nextItems[existingIndex] = { ...(chatItems[existingIndex] as Extract<AcpChatItem, { kind: 'plan' }>), ...plan };
          chatItems = nextItems;
        } else {
          chatItems = [...chatItems, { kind: 'plan', ...plan }];
        }
      } else if (typeof kind === 'string' && NON_VISUAL_UPDATES.has(kind)) {
        // No chat item: usage_update/current_mode_update/available_commands_update
        // are protocol bookkeeping, not something to render in the transcript.
        // usage_update still feeds `usage`/`usageContext` in the block below.
      } else {
        chatItems = [...chatItems, { kind: 'raw', method: String(kind ?? envelope.method), data: update }];
      }
    } else if ('id' in envelope && classifyMethod(envelope.method) === 'permission') {
      const item: AcpChatItem = { kind: 'permission', id: envelope.id, method: envelope.method, params: envelope.params ?? {} };
      chatItems = [...chatItems, item];
      const key = rpcIdKey(envelope.id);
      // See the `openPromptIds` comment above: always (re)open, never gated
      // on `answeredIds` — that set only guards against a reused numeric id
      // being mistaken for its own past occupant, via the ordinal backstop
      // at response time below.
      openRequests = new Map(openRequests);
      openRequests.set(key, item);
      openRequestOrdinals = new Map(openRequestOrdinals);
      openRequestOrdinals.set(key, row.ordinal);
    } else if ('id' in envelope && classifyMethod(envelope.method) === 'question') {
      const params = isRecord(envelope.params) ? envelope.params : {};
      const question = projectQuestion(envelope.id as AcpJsonRpcId, envelope.method, params);
      const item: AcpChatItem = { kind: 'question', id: envelope.id, method: envelope.method, questions: question.questions, params };
      chatItems = [...chatItems, item];
      const key = rpcIdKey(envelope.id);
      openRequests = new Map(openRequests);
      openRequests.set(key, item);
      openRequestOrdinals = new Map(openRequestOrdinals);
      openRequestOrdinals.set(key, row.ordinal);
    } else {
      chatItems = [...chatItems, { kind: 'raw', method: envelope.method, data: envelope.params }];
    }
  }

  // ── usage: latest `usage_update` context + latest response `usage` tokens ──
  if (row.direction === 'agent_to_client') {
    const params = isRecord(envelope.params) ? envelope.params : null;
    const update = params && isRecord(params.update) ? params.update : null;
    const updateKind = update ? firstString(update.sessionUpdate, update.type) : null;
    if (update && updateKind === 'usage_update') {
      const used = nonNegativeNumber(update.used);
      const size = nonNegativeNumber(update.size);
      if (used !== null && size !== null) {
        const rawCost = isRecord(update.cost) ? update.cost : null;
        const amount = rawCost ? nonNegativeNumber(rawCost.amount) : null;
        const currency = rawCost ? firstString(rawCost.currency) : null;
        usageContext = {
          used,
          size,
          percent: size > 0 ? Math.min(100, (used / size) * 100) : null,
          cost: amount !== null && currency ? { amount, currency } : null,
          source: 'usage_update',
        };
      }
    }

    const result = isRecord(envelope.result) ? envelope.result : null;
    const rawUsage = result && isRecord(result.usage) ? result.usage : null;
    if (rawUsage) {
      const total = nonNegativeNumber(rawUsage.totalTokens ?? rawUsage.total_tokens);
      const input = nonNegativeNumber(rawUsage.inputTokens ?? rawUsage.input_tokens);
      const output = nonNegativeNumber(rawUsage.outputTokens ?? rawUsage.output_tokens);
      if (total !== null && input !== null && output !== null) {
        usageTokens = {
          total,
          input,
          output,
          thought: nonNegativeNumber(rawUsage.thoughtTokens ?? rawUsage.thought_tokens),
          cachedRead: nonNegativeNumber(rawUsage.cachedReadTokens ?? rawUsage.cached_read_tokens),
          cachedWrite: nonNegativeNumber(rawUsage.cachedWriteTokens ?? rawUsage.cached_write_tokens),
        };
      }
    }
  }

  // ── responses: answer permission/question requests and prompt requests ──
  if ('id' in envelope && !('method' in envelope) && ('result' in envelope || 'error' in envelope)) {
    const key = rpcIdKey(envelope.id);
    if (!answeredIds.has(key)) {
      answeredIds = new Set(answeredIds);
      answeredIds.add(key);
    }
    // Ordinal-ordering backstop: only close the entry currently open for
    // this id if it was opened STRICTLY BEFORE this response — i.e. this
    // response answers the NEAREST PRECEDING open request with the same id,
    // never a request that (in a malformed/out-of-order log) hasn't
    // happened yet. In the normal, ordinal-ordered case this is always
    // true; it matters only for defending against corrupt input.
    const openRequestOrdinal = openRequests.has(key) ? openRequestOrdinals.get(key) : undefined;
    if (openRequestOrdinal !== undefined && openRequestOrdinal < row.ordinal) {
      openRequests = new Map(openRequests);
      openRequests.delete(key);
      openRequestOrdinals = new Map(openRequestOrdinals);
      openRequestOrdinals.delete(key);
    }
    if (row.direction === 'agent_to_client') {
      if (!promptAnsweredIds.has(key)) {
        promptAnsweredIds = new Set(promptAnsweredIds);
        promptAnsweredIds.add(key);
      }
      const openPromptOrdinal = openPromptIds.has(key) ? openPromptOrdinals.get(key) : undefined;
      if (openPromptOrdinal !== undefined && openPromptOrdinal < row.ordinal) {
        openPromptIds = new Map(openPromptIds);
        openPromptIds.delete(key);
        openPromptOrdinals = new Map(openPromptOrdinals);
        openPromptOrdinals.delete(key);
        openPromptSessionIds = new Map(openPromptSessionIds);
        openPromptSessionIds.delete(key);
      }
    }
  }

  const usageChanged = usageContext !== state.usageContext || usageTokens !== state.usageTokens;
  const usage: AcpUsageProjection | null = !usageChanged
    ? state.usage
    : usageContext
      ? { ...usageContext, tokens: usageTokens }
      : usageTokens
        ? { used: null, size: null, percent: null, cost: null, tokens: usageTokens, source: 'prompt_response' }
        : null;

  const turnStateChanged = openPromptIds !== state.openPromptIds;
  const turnState: AcpTurnState = turnStateChanged
    ? { busy: openPromptIds.size > 0, pendingPromptIds: [...openPromptIds.values()] }
    : state.turnState;

  // A row only returns `state` unchanged (reference-equal) when it is a
  // genuine (streamEventId, direction) duplicate of one already folded — the
  // dedupe check at the top of this function already returned early for
  // that case. Every OTHER row — including one that changes no projection
  // (e.g. a persisted `client_to_agent` row for a method none of the chat-item
  // branches above recognize, arriving with `streamEventId: null` the way
  // `client.transcript()` rows do) — must still extend `envelopes`, the
  // documented source-of-truth log (`snapshot.envelopes`). Callers
  // (`AcpSession`) that want a "did anything projected change" signal read
  // the individual projections (`chatItems`, `usage`, `turnState`, …), not
  // reference-equality of the whole state.

  const dedupeKeys = row.streamEventId != null
    ? new Set(state.dedupeKeys).add(`${row.direction}:${row.streamEventId}`)
    : state.dedupeKeys;

  return {
    envelopes: [...state.envelopes, row],
    chatItems,
    toolIndex,
    answeredIds,
    openRequests,
    openRequestOrdinals,
    usage,
    turnState,
    dedupeKeys,
    usageContext,
    usageTokens,
    promptAnsweredIds,
    openPromptIds,
    openPromptOrdinals,
    openPromptSessionIds,
  };
}

/** Session-id comparison used by the busy-staleness policy: `undefined` on
 *  either side is treated as a wildcard match. Neither ACP transcript rows
 *  nor `AcpSession`'s locally-originated echoes are guaranteed to carry a
 *  `sessionId` on every code path, and this SDK only ever tracks one ACP
 *  session's log at a time — being permissive here is what keeps a plain
 *  (no-sessionId) cancel/prompt row able to clear a plain open prompt,
 *  while still scoping correctly when both sides do carry one. */
function sessionsMatch(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/** Derives `AcpPendingPrompts` (still-unanswered permission/question cards)
 *  from a reducer state's `openRequests`, re-projecting the full
 *  `AcpPendingPermission`/`AcpPendingQuestion` shape from each entry's
 *  stored `params` — the same projection `projectAcpPendingPrompts` used to
 *  compute in one pass over the whole row log. */
export function pendingFromState(state: AcpReducerState): AcpPendingPrompts {
  const permissions: AcpPendingPermission[] = [];
  const questions: AcpPendingQuestion[] = [];
  for (const item of state.openRequests.values()) {
    if (item.kind === 'permission') {
      const params = isRecord(item.params) ? item.params : {};
      permissions.push(projectPermission(item.id as AcpJsonRpcId, item.method, params));
    } else if (item.kind === 'question') {
      const params = isRecord(item.params) ? item.params : {};
      questions.push(projectQuestion(item.id as AcpJsonRpcId, item.method, params));
    }
  }
  return { permissions, questions };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function projectToolCall(id: string, update: Record<string, unknown>): AcpToolCall {
  return {
    id,
    title: firstString(update.title, update.name, update.kind, id) ?? id,
    toolKind: firstString(update.kind) ?? null,
    status: firstString(update.status) ?? null,
    content: Array.isArray(update.content) ? update.content : [],
    locations: Array.isArray(update.locations) ? update.locations : [],
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
    data: update,
  };
}

function mergeToolCall(previous: AcpToolCall, next: AcpToolCall): AcpToolCall {
  // Terminal statuses never regress: once a tool call has completed/failed/
  // errored/cancelled, a later (e.g. stray or out-of-order) update reporting
  // a non-terminal status must not resurrect it as still-running.
  const status = TERMINAL_TOOL_STATUSES.has(previous.status ?? '') && !TERMINAL_TOOL_STATUSES.has(next.status ?? '')
    ? previous.status
    : next.status ?? previous.status;
  return {
    ...previous,
    ...next,
    title: next.title === next.id ? previous.title : next.title || previous.title,
    toolKind: next.toolKind ?? previous.toolKind,
    status,
    content: next.content.length ? next.content : previous.content,
    locations: next.locations.length ? next.locations : previous.locations,
    rawInput: next.rawInput ?? previous.rawInput,
    rawOutput: next.rawOutput ?? previous.rawOutput,
    data: { ...previous.data, ...next.data },
  };
}

function projectPermission(
  id: AcpJsonRpcId,
  method: string,
  params: Record<string, unknown>,
): AcpPendingPermission {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
  const permission = firstString(
    params.permission,
    params.title,
    params.name,
    toolCall.title,
    toolCall.kind,
    params.kind,
    method,
  ) ?? method;
  return {
    id,
    method,
    sessionId: firstString(params.sessionId),
    permission,
    patterns: stringArray(params.patterns),
    options: normalizeOptions(params.options),
    params,
  };
}

function projectQuestion(
  id: AcpJsonRpcId,
  method: string,
  params: Record<string, unknown>,
): AcpPendingQuestion {
  const explicit = Array.isArray(params.questions)
    ? params.questions
        .filter(isRecord)
        .map((question) => ({
          key: firstString(question.key, question.name),
          question: firstString(question.question, question.label, question.title) ?? firstString(params.message, params.prompt) ?? method,
          header: firstString(question.header, params.message, params.title),
          options: normalizeOptions(question.options),
          allowText: question.allowText === true || question.type === 'text',
        }))
    : [];

  const schemaQuestions = questionItemsFromSchema(params);
  const fallback = explicit.length || schemaQuestions.length
    ? []
    : [{
        question: firstString(params.message, params.prompt, params.question, params.title) ?? method,
        header: firstString(params.title),
        options: normalizeOptions(params.options),
        allowText: params.mode !== 'url',
      }];

  return {
    id,
    method,
    sessionId: firstString(params.sessionId),
    questions: [...explicit, ...schemaQuestions, ...fallback],
    params,
  };
}

function questionItemsFromSchema(params: Record<string, unknown>): AcpPendingQuestionItem[] {
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = schema && isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return [];
  return Object.entries(properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {};
    return {
      key,
      question: firstString(property.title, property.description, key) ?? key,
      header: firstString(params.message, params.title),
      options: normalizeSchemaOptions(property),
      allowText: property.type !== 'boolean',
    };
  });
}

function normalizeSchemaOptions(property: Record<string, unknown>): AcpPendingOption[] {
  const enumValues = Array.isArray(property.enum) ? property.enum : [];
  if (enumValues.length > 0) {
    const options: AcpPendingOption[] = [];
    for (const value of enumValues) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        options.push({ label: String(value), value: String(value) });
      }
    }
    return options;
  }
  const choices = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : [];
  return choices.filter(isRecord).map((choice) => {
    const value = firstString(choice.const, choice.value, choice.enum);
    const label = firstString(choice.title, choice.name, choice.label, value) ?? 'Option';
    return {
      label,
      value,
      description: firstString(choice.description),
      hint: firstString(choice.hint),
    };
  });
}

function normalizeOptions(value: unknown): AcpPendingOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((option) => {
    const optionId = firstString(option.optionId, option.id);
    const value = firstString(option.value, optionId);
    const label = firstString(option.label, option.name, option.title, optionId, value) ?? 'Option';
    return {
      optionId,
      id: firstString(option.id),
      kind: firstString(option.kind),
      label,
      value,
      hint: firstString(option.hint),
      description: firstString(option.description),
    };
  });
}

function rpcIdKey(id: unknown): string {
  return JSON.stringify(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
