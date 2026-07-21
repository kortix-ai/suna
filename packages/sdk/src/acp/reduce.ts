import { contentAttachments, contentText, textFromContent } from './content';
import { isLiveSessionLoadReplay } from './load-replay';
import type { AcpJsonRpcId, AcpSessionConfigOption } from './types';
import type {
  AcpChatItem,
  AcpPendingOption,
  AcpPendingPermission,
  AcpPendingPrompts,
  AcpPendingQuestion,
  AcpPendingQuestionItem,
  AcpPlan,
  AcpSessionInfo,
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
  /** `${direction}:${streamEventId}` of the most RECENT `DEDUPE_WINDOW` rows
   *  folded (across both directions combined), for O(1) duplicate detection
   *  — a fixed-size recency window, not an unboundedly-growing record of
   *  every row ever folded (see `boundedDedupeKeys`'s doc for why a window,
   *  rather than a high-water mark alone, is the right shape here: unlike
   *  `AcpSession`'s `historyOrdinals`/`historyHighWaterMark`, this backs a
   *  PUBLIC function — `reduceEnvelope`, and every `project*` wrapper over
   *  it — that any external caller can feed an arbitrarily-ordered `rows`
   *  array, so a bare "ordinal <= mark" test could silently misclassify a
   *  genuinely-new-but-out-of-order row as a duplicate). The correctness
   *  trade this makes: a genuine duplicate re-arriving after aging out of
   *  the window (more than `DEDUPE_WINDOW` distinct keys newer have since
   *  been folded) is no longer recognized as one — accepted because
   *  Last-Event-ID SSE replay only ever re-delivers a small, bounded tail of
   *  recent events (see `AcpClient.connect`'s `Last-Event-ID` header and its
   *  own `event.id <= lastEventId` filter in `client.ts`, which already
   *  screens out same-connection duplicates before they ever reach here),
   *  never a session's full history — `DEDUPE_WINDOW` only needs to be
   *  generous relative to that realistic reconnect/bootstrap-race overlap,
   *  not to the session's total length. */
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
  /** Still-open client `session/load` requests, keyed by `rpcIdKey(id)` and
   *  carrying their request ordinal. Native ACP agents replay the loaded
   *  conversation as `session/update` notifications before answering the
   *  load request; those notifications remain in `envelopes` as durable raw
   *  truth but must not be projected as brand-new chat turns. Optional for
   *  source compatibility with callers that persisted/constructed the
   *  previously-published reducer state shape. */
  openSessionLoadOrdinals?: Map<string, number>;
  /** Accumulated full text + last-growth ordinal per message/thought stream,
   *  keyed `role:messageId`. Backs the content-identity replay classification
   *  below: the API bridge splits the agent's single ordered stream into an
   *  SSE channel (notifications) and a POST round-trip (responses), so a
   *  `session/load` response row can overtake still-persisting replay frames
   *  — replayed chunks then land OUTSIDE the open-load window above and can
   *  only be recognized by what they carry, not by where they sit. Optional
   *  for source compatibility with previously-published state shapes. */
  messageStreams?: Map<string, { text: string; grewAt: number }>;
  /** Stream keys (`role:messageId`) classified as `session/load` replay
   *  re-deliveries — every later chunk under such a key is dropped. */
  replayMessageIds?: Set<string>;
  /** Active replay prefix-walk cursor per stream key: a same-id replay
   *  (claude paragraph fragments, opencode part re-delivery) re-walks the
   *  stream's accumulated text from position 0 in arbitrary granularity;
   *  each chunk matching the walk advances the cursor and is dropped. */
  replayWalks?: Map<string, number>;
  /** Ordinal of the most recent client `session/load` request. Every replay
   *  classification below requires a load to exist — a session that never
   *  reconnected can never misclassify a live chunk — and same-id walks
   *  additionally require the load to POSTDATE the stream's last growth. */
  lastSessionLoadOrdinal?: number;
  /** Folded `session_info_update` state (thread title/status) — see
   *  `AcpSessionInfo`'s doc comment. `null` until the first such notification
   *  arrives; fields merge across updates rather than replacing wholesale. */
  sessionInfo: AcpSessionInfo | null;
  /**
   * Latest full `configOptions` array from a live `config_option_update`
   * notification (verified real: claude-agent-acp/codex-acp emit this after
   * an in-transcript `/model`-style slash command changes a session config
   * option out from under the client, not only in response to
   * `session/set_config_option`'s own RPC result). `null` until the first
   * such notification arrives, distinct from an empty array (which means the
   * harness reported zero config options) — `AcpSession.applyReducerState`
   * uses the `null` state to know "no live update yet, keep whatever
   * bootstrap/`setConfigOption` already set" instead of clobbering it.
   */
  liveConfigOptions: AcpSessionConfigOption[] | null;
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
    openSessionLoadOrdinals: new Map(),
    messageStreams: new Map(),
    replayMessageIds: new Set(),
    replayWalks: new Map(),
    lastSessionLoadOrdinal: undefined,
    sessionInfo: null,
    liveConfigOptions: null,
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
 *  `usage_update` still feeds `projectAcpUsage`, `session_info_update` still
 *  feeds `sessionInfo`, and `config_option_update` still feeds
 *  `liveConfigOptions`, all via their own dedicated bookkeeping blocks below;
 *  this only excludes them from `chatItems`. Without `session_info_update`/
 *  `config_option_update` here, both fell through to the generic `raw` chat
 *  item and rendered as a user-visible "Unrecognized agent event" row even
 *  though they are legitimate, spec'd protocol notifications (verified live:
 *  claude-agent-acp sends `session_info_update` on session rename,
 *  codex-acp sends it for thread-status ticks; both send
 *  `config_option_update` when a config option changes out of band, e.g. an
 *  in-transcript `/model` slash command). */
const NON_VISUAL_UPDATES = new Set([
  'usage_update',
  'current_mode_update',
  'available_commands_update',
  'session_info_update',
  'config_option_update',
]);

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
  let openSessionLoadOrdinals = state.openSessionLoadOrdinals ?? new Map<string, number>();
  let messageStreams = state.messageStreams ?? new Map<string, { text: string; grewAt: number }>();
  let replayMessageIds = state.replayMessageIds ?? new Set<string>();
  let replayWalks = state.replayWalks ?? new Map<string, number>();
  let lastSessionLoadOrdinal = state.lastSessionLoadOrdinal;
  let sessionInfo = state.sessionInfo;
  let liveConfigOptions = state.liveConfigOptions;

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
  } else if (row.direction === 'client_to_agent' && envelope.method === 'session/load') {
    const id = envelope.id;
    if (typeof id === 'string' || typeof id === 'number') {
      openSessionLoadOrdinals = new Map(openSessionLoadOrdinals);
      openSessionLoadOrdinals.set(rpcIdKey(id), row.ordinal);
    }
    lastSessionLoadOrdinal = row.ordinal;
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
      // A tool_call carries a stable `toolCallId` and is deduped by `toolIndex`
      // below: a replayed copy merges onto the existing item by id rather than
      // appending a second one. So it does NOT need the bootstrap-replay guard —
      // and MUST NOT be caught by it, because a genuinely-NEW tool_call can
      // legitimately interleave with an open `session/load`. That is exactly D2:
      // on an error-terminated run the client fires repeated auto-resume
      // `session/load`s, and the daemon's async synthetic outputs `show` (a new
      // tool_call) landed inside one still-open load window; blanket-suppressing
      // it dropped the Outputs card's rows on reload. Message/thought chunks are
      // NOT id-deduped, so replaying them WOULD duplicate turns — they keep the
      // guard.
      const isToolUpdate = kind === 'tool_call' || kind === 'tool_call_update';
      if ((openSessionLoadOrdinals.size > 0 || isLiveSessionLoadReplay(row)) && !isToolUpdate) {
        // `session/load` rehydrates the native agent by replaying its existing
        // conversation as update notifications before the matching JSON-RPC
        // response. The API correctly persists those frames in the lossless
        // envelope log, but a semantic transcript must not interpret bootstrap
        // history as another live turn. Non-chat projections (usage/config)
        // still consume the row in their dedicated blocks below. Tool calls are
        // exempt (see above): they dedupe by id, so replay is safe and a new
        // one must not be lost.
      } else if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && (text || attachments.length)) {
        const role = kind === 'agent_thought_chunk' ? 'thought' : 'assistant';
        // Content-identity replay classification (duplicate-message bug,
        // session 52cb3a2c): replay frames can land AFTER the load response
        // row (see `messageStreams` on the state type), so the open-load
        // window above cannot bracket them, and codex interleaves replay
        // with live turn output so no ordering rule ever could. Each
        // harness replays in one of three shapes, all gated on a
        // `session/load` having been folded so a never-reconnected session
        // is byte-for-byte unaffected:
        //  - SAME-id re-walk (claude paragraph fragments, opencode parts):
        //    the stream's accumulated text is re-delivered from position 0
        //    in arbitrary granularity — matched by a prefix-walk cursor. A
        //    walk may only START when the latest load postdates the
        //    stream's last growth, so a live continuation delta that
        //    happens to echo its message's opening token is never eaten.
        //  - NEW-id consolidated chunk (codex `item-N`): full text
        //    byte-equals another same-role stream that finished growing
        //    before the latest load.
        //  - Id-LESS complete message (pi): full text byte-equals an
        //    existing complete same-role message item.
        const messageId = firstString(update.messageId);
        const streamKey = messageId ? `${role}:${messageId}` : null;
        const stream = streamKey ? messageStreams.get(streamKey) : undefined;
        const loadOrdinal = lastSessionLoadOrdinal;
        let isReplay = streamKey != null && replayMessageIds.has(streamKey);
        if (!isReplay && loadOrdinal !== undefined && text.length > 0) {
          if (streamKey && stream) {
            const cursor = replayWalks.get(streamKey);
            if (cursor !== undefined && cursor < stream.text.length && stream.text.startsWith(text, cursor)) {
              replayWalks = new Map(replayWalks);
              replayWalks.set(streamKey, cursor + text.length);
              isReplay = true;
            } else if (stream.grewAt < loadOrdinal && stream.text.startsWith(text)) {
              replayWalks = new Map(replayWalks);
              replayWalks.set(streamKey, text.length);
              isReplay = true;
            }
          } else if (streamKey) {
            // Codex consolidation is not byte-faithful (verified: `item-14`
            // drops the live stream's leading `\n\n`) — compare trimmed.
            const needle = text.trim();
            const matchesFinishedStream = needle.length > 0 && [...messageStreams].some(([key, other]) =>
              key !== streamKey && key.startsWith(`${role}:`) && other.grewAt < loadOrdinal && other.text.trim() === needle);
            if (matchesFinishedStream) {
              replayMessageIds = new Set(replayMessageIds);
              replayMessageIds.add(streamKey);
              isReplay = true;
            }
          } else {
            const needle = text.trim();
            isReplay = needle.length > 0 && chatItems.some((item) =>
              item.kind === 'message' && item.role === role && item.text.trim() === needle);
          }
        }
        if (!isReplay) {
          if (streamKey) {
            messageStreams = new Map(messageStreams);
            messageStreams.set(streamKey, { text: (stream?.text ?? '') + text, grewAt: row.ordinal });
            if (replayWalks.has(streamKey)) {
              replayWalks = new Map(replayWalks);
              replayWalks.delete(streamKey);
            }
          }
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

    // `session_info_update`: fold whatever fields THIS update carries onto
    // the running `sessionInfo` projection — merge, never replace wholesale.
    // claude-agent-acp sends `{title, updatedAt}` and codex-acp sends
    // `{_meta: {codex: {threadStatus}}}`; a session only ever sees ONE
    // harness's shape in practice, but merging (not overwriting) keeps this
    // correct even if a future/mixed adapter sends both across separate
    // updates — a threadStatus tick must never blank out a title set by an
    // earlier update, and vice versa.
    if (update && updateKind === 'session_info_update') {
      const extracted = extractSessionInfo(update);
      if (extracted.title !== undefined || extracted.updatedAt !== undefined || extracted.threadStatus !== undefined) {
        sessionInfo = {
          title: extracted.title ?? sessionInfo?.title ?? null,
          updatedAt: extracted.updatedAt ?? sessionInfo?.updatedAt ?? null,
          threadStatus: extracted.threadStatus ?? sessionInfo?.threadStatus ?? null,
        };
      }
    }

    // `config_option_update`: the harness's own out-of-band notification that
    // its session config options changed (e.g. an in-transcript `/model`
    // slash command) — the full, authoritative replacement list, same shape
    // `session/new`/`session/load`/`session/set_config_option` already
    // return. `AcpSession.applyReducerState` (session.ts) uses this to keep
    // `snapshot.configOptions` (and therefore the composer's model/mode
    // pills) live-accurate even when the change didn't originate from this
    // client's own `setConfigOption` call.
    if (update && updateKind === 'config_option_update' && Array.isArray(update.configOptions)) {
      liveConfigOptions = update.configOptions as AcpSessionConfigOption[];
    }
  }

  // ── responses: answer permission/question requests and prompt requests ──
  if ('id' in envelope && !('method' in envelope) && ('result' in envelope || 'error' in envelope)) {
    const key = rpcIdKey(envelope.id);
    const openSessionLoadOrdinal = openSessionLoadOrdinals.get(key);
    if (
      row.direction === 'agent_to_client'
      && openSessionLoadOrdinal !== undefined
      && openSessionLoadOrdinal < row.ordinal
    ) {
      openSessionLoadOrdinals = new Map(openSessionLoadOrdinals);
      openSessionLoadOrdinals.delete(key);
    }
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
    ? boundedDedupeKeys(state.dedupeKeys, `${row.direction}:${row.streamEventId}`)
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
    openSessionLoadOrdinals,
    messageStreams,
    replayMessageIds,
    replayWalks,
    lastSessionLoadOrdinal,
    sessionInfo,
    liveConfigOptions,
  };
}

/** Bound for `dedupeKeys`' recency window (see the field's doc comment on
 *  `AcpReducerState` for the full justification). Arbitrary but generous —
 *  no specific server-side replay-buffer size is documented for this
 *  protocol to derive an exact number from, and picking one far larger than
 *  any realistic reconnect/bootstrap-race overlap costs nothing but a few
 *  hundred strings of retained memory. Not exported: it is an
 *  implementation constant, not part of the documented contract (see
 *  `dedupeKeys`'s own doc). */
const DEDUPE_WINDOW = 256;

/** Adds `key` to a copy of `keys`, evicting the single oldest entry (`Set`
 *  iterates in insertion order, so `.values().next().value` is always the
 *  least-recently-added key) if that copy would exceed `DEDUPE_WINDOW` —
 *  bounds `dedupeKeys` to O(window) instead of O(session length). Only ever
 *  called with a genuinely new (not-yet-duplicate) key — the caller
 *  (`reduceEnvelope`) already early-returns on a duplicate before reaching
 *  this, so this never needs to check membership itself. */
function boundedDedupeKeys(keys: Set<string>, key: string): Set<string> {
  const next = new Set(keys).add(key);
  if (next.size > DEDUPE_WINDOW) {
    const oldest = next.values().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next;
}

/**
 * Liveness-guard clear for `AcpSession`'s reload-recovery wedge guard (see
 * `session.ts`'s `clearStalePersistedBusy`): unconditionally supersedes
 * every still-open `session/prompt` the exact same way a NEW `session/prompt`
 * or `session/cancel` row already does via the busy-staleness policy above
 * (`openPromptIds`/`openPromptOrdinals`/`openPromptSessionIds` all clear,
 * `turnState` collapses to `{ busy: false, pendingPromptIds: [] }`) — except
 * triggered by a CONNECTION-lifecycle signal (a live stream permanently
 * failing, or bootstrap itself never reaching the harness) instead of by an
 * actual transcript row, so unlike every other branch in this file it
 * deliberately does NOT touch `envelopes`/`chatItems`/`dedupeKeys` — there is
 * no row to append or dedupe against. A no-op (returns `state` itself,
 * reference-equal) when nothing is currently open, so a caller can call this
 * unconditionally without needing its own "is anything open" guard.
 */
export function clearOpenPrompts(state: AcpReducerState): AcpReducerState {
  if (state.openPromptIds.size === 0) return state;
  return {
    ...state,
    openPromptIds: new Map(),
    openPromptOrdinals: new Map(),
    openPromptSessionIds: new Map(),
    turnState: { busy: false, pendingPromptIds: [] },
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

/** Pulls whatever `session_info_update` fields a single update carries — see
 *  `AcpSessionInfo`'s doc comment for the two verified real shapes (claude
 *  `{title,updatedAt}` vs. codex `{_meta:{codex:{threadStatus}}}`). A field
 *  absent from THIS update is simply absent from the return value (not
 *  `null`) so the caller can tell "not carried by this update" apart from
 *  "carried and empty", and merge onto the running projection accordingly. */
function extractSessionInfo(update: Record<string, unknown>): {
  title?: string;
  updatedAt?: string;
  threadStatus?: { type: string | null; activeFlags: string[] };
} {
  const out: { title?: string; updatedAt?: string; threadStatus?: { type: string | null; activeFlags: string[] } } = {};
  const title = firstString(update.title);
  if (title !== undefined) out.title = title;
  const updatedAt = firstString(update.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  const meta = isRecord(update._meta) ? update._meta : null;
  const codexMeta = meta && isRecord(meta.codex) ? meta.codex : null;
  const threadStatus = codexMeta && isRecord(codexMeta.threadStatus) ? codexMeta.threadStatus : null;
  if (threadStatus) {
    out.threadStatus = {
      type: firstString(threadStatus.type) ?? null,
      activeFlags: Array.isArray(threadStatus.activeFlags)
        ? threadStatus.activeFlags.filter((flag): flag is string => typeof flag === 'string')
        : [],
    };
  }
  return out;
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
