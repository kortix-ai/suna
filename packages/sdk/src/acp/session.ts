import { createAcpClient, type AcpClient } from './client';
import { emptyReducerState, pendingFromState, reduceEnvelope, type AcpReducerState } from './reduce';
import {
  type AcpChatItem,
  type AcpPendingPrompts,
  type AcpStoredEnvelope,
  type AcpTurnState,
  type AcpUsageProjection,
} from './transcript';
import {
  AcpRpcError,
  AcpTransportError,
  type AcpConnectionState,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpJsonRpcId,
  type AcpSessionConfigOption,
  type AcpStreamHandle,
} from './types';

// Re-exported for backward compatibility: `AcpConnectionState` used to be
// declared here. It now lives in `./types` (so `client.ts` can reference it
// without importing `./session` and creating a cycle), but the public name
// must keep resolving from this module too.
export type { AcpConnectionState } from './types';

export type AcpSessionError = {
  /**
   * RPC-shaped errors (an `AcpRpcError` surfaced through the JSON-RPC layer)
   * always report `kind: 'rpc'`, even when the failing call happened during
   * bootstrap (e.g. a rejected `initialize`/`session/new`) — only `terminal`
   * reflects bootstrap context in that case, not `kind`. See `toSessionError`.
   */
  kind: 'transport' | 'rpc' | 'bootstrap';
  message: string;
  status?: number;
  code?: number;
  terminal: boolean;
};

export type AcpSessionSnapshot = {
  envelopes: readonly AcpStoredEnvelope[];
  chatItems: readonly AcpChatItem[];
  pendingPrompts: AcpPendingPrompts;
  usage: AcpUsageProjection | null;
  turnState: AcpTurnState;
  connection: AcpConnectionState;
  ready: boolean;
  busy: boolean;
  error: AcpSessionError | null;
  acpSessionId: string | null;
  configOptions: AcpSessionConfigOption[];
  capabilities: Record<string, unknown>;
  agentInfo: NonNullable<AcpInitializeResult['agentInfo']> | null;
  authMethods: Array<Record<string, unknown>>;
};

export type AcpSessionOptions = {
  endpoint: string;
  acpSessionId?: string | null;
  /** Working directory handed to `session/new` and `session/load`. Default `/workspace`. */
  cwd?: string;
  /** ACP JSON-RPC protocol version passed to `initialize`. Default `1`. */
  protocolVersion?: number;
  clientInfo?: { name: string; title?: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  fetch?: typeof fetch;
  streamTransport?: 'auto' | 'sse' | 'poll';
  /** Default `queueMicrotask`; tests inject a synchronous or manually-driven flush. */
  scheduleFlush?: (flush: () => void) => void;
};

const DEFAULT_CLIENT_INFO = { name: '@kortix/sdk', title: 'Kortix SDK', version: '0.2.0' };

const EMPTY_SNAPSHOT: AcpSessionSnapshot = {
  envelopes: [],
  chatItems: [],
  pendingPrompts: { permissions: [], questions: [] },
  usage: null,
  turnState: { busy: false, pendingPromptIds: [] },
  connection: 'idle',
  ready: false,
  busy: false,
  error: null,
  acpSessionId: null,
  configOptions: [],
  capabilities: {},
  agentInfo: null,
  authMethods: [],
};

/** Monotonic-enough ordinal for a live SSE event, kept out of the ordinal
 *  space that persisted transcript rows already occupy (small integers). */
function syntheticOrdinal(eventId: number): number {
  return Date.now() * 1_000 + eventId;
}

/** Ordinal for a locally-originated optimistic echo (prompt/response rows
 *  that never round-trip through the server's own ordinal sequence). */
function localOrdinal(): number {
  return Date.now() * 1_000;
}

/**
 * A locally-synthesized optimistic echo (`send()`'s `local-` prompt row,
 * `respondWithEcho`'s permission/question response row, `cancel()`'s
 * notification row) is always `client_to_agent` and NEVER carries
 * `createdAt` — only a row sourced from `AcpClient.transcript()`
 * (`AcpTranscriptRow`, always fully resolved) does. A live SSE/poll event
 * also lacks `createdAt` (see `connect()`'s `onEvent`), but is always
 * `agent_to_client`, so this single check is enough to tell "one of this
 * session's own optimistic rows" apart from any genuine server-originated
 * row without needing a separate marker/flag threaded through `enqueue()`.
 */
function isLocalEchoRow(row: AcpStoredEnvelope): boolean {
  return row.direction === 'client_to_agent' && row.createdAt === undefined;
}

/** A still-unreconciled `send()` optimistic prompt echo — identified by its
 *  synthetic `local-` id, which never round-trips (the REAL id is minted
 *  server-side, inside `AcpClient.prompt()`'s `request()` call, and `send()`
 *  never sees it). */
function isLocalPromptEcho(row: AcpStoredEnvelope): boolean {
  if (!isLocalEchoRow(row)) return false;
  const envelope = row.envelope as Record<string, unknown>;
  return envelope.method === 'session/prompt' && typeof envelope.id === 'string' && envelope.id.startsWith('local-');
}

/** A still-unreconciled `respondWithEcho` local response row — unlike a
 *  prompt echo, this one DOES carry the real JSON-RPC id (the id of the
 *  permission/question request it answers), so an exact id match is both
 *  correct and sufficient to pair it with its server-persisted counterpart. */
function isLocalRespondEcho(row: AcpStoredEnvelope): boolean {
  if (!isLocalEchoRow(row)) return false;
  const envelope = row.envelope as Record<string, unknown>;
  return 'id' in envelope && !('method' in envelope) && ('result' in envelope || 'error' in envelope);
}

function toSessionError(kind: AcpSessionError['kind'], error: unknown): AcpSessionError {
  if (error instanceof AcpRpcError) {
    return { kind: 'rpc', message: error.message, code: error.code, terminal: kind === 'bootstrap' };
  }
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/HTTP (\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  // An `AcpTransportError` (thrown by `AcpClient`'s HTTP layer — POST
  // request/notify/respond, or the SSE/poll `connect()` loop) already knows
  // whether it is terminal (4xx-except-408/429, see `isTerminalStatus` in
  // `client.ts`) — that is strictly more precise than inferring terminality
  // from `kind` alone. Without this, a mid-session terminal stream failure
  // (401/403/410 on an SSE reconnect — token expiry, session deleted) came
  // through as `kind: 'transport'` and was ALWAYS reported non-terminal
  // (`kind === 'bootstrap'` is false for a stream error), even though the
  // underlying client had already given up (`onState('failed')`, see
  // `client.ts`'s `run()`), leaving the failure invisible and unrecoverable
  // to any consumer keying UI off `error.terminal`. A non-`AcpTransportError`
  // (e.g. a plain thrown `Error`, or a transport-shaped RPC transport issue
  // with no `.terminal` field) has no such signal to propagate, so it falls
  // back to the previous `kind === 'bootstrap'` heuristic — bootstrap has no
  // automatic retry loop of its own, so any bootstrap failure is terminal by
  // construction; a stream failure without a typed transport error is
  // assumed non-terminal, matching the client's own default (keep retrying).
  const terminal = error instanceof AcpTransportError ? error.terminal : kind === 'bootstrap';
  return { kind, message, status, terminal };
}

/**
 * Framework-free store for one ACP session's live state: connection
 * lifecycle, the persisted+live envelope log, and the derived projections
 * (`chatItems`, `pendingPrompts`, `usage`, `turnState`) consumers render
 * from. `useAcpSession` (and, later, non-React hosts) subscribe to this
 * directly instead of re-deriving the bootstrap/streaming dance themselves.
 *
 * Envelope-driven changes are batched through `scheduleFlush` so a burst of
 * SSE events collapses into one snapshot emission; direct state changes
 * (bootstrap results, connection transitions) patch and emit immediately.
 */
export class AcpSession {
  private readonly client: AcpClient;
  private readonly listeners = new Set<() => void>();
  private readonly scheduleFlush: (flush: () => void) => void;
  private snapshot: AcpSessionSnapshot;
  /** The incremental, structurally-shared reducer state (`./reduce`) —
   *  `reducerState.envelopes` IS the committed envelope log; there is no
   *  separate array to keep in sync with it. */
  private reducerState: AcpReducerState = emptyReducerState();
  private pendingEnvelopes: AcpStoredEnvelope[] = [];
  private flushScheduled = false;
  private stream: AcpStreamHandle | null = null;
  private bootstrap: Promise<void> | null = null;
  private createdSessionId: string | null = null;
  private requestBusy = false;
  /** Every `ordinal` ever accepted from `enqueueHistory` — a bootstrap retry
   *  (or any future re-sync) re-fetches the FULL persisted transcript from
   *  scratch, and this makes that idempotent: a row whose ordinal is already
   *  here is skipped instead of folded a second time. Scoped to history rows
   *  only (never populated by a live/local `enqueue()` call) since server
   *  ordinals are authoritative and unique per transcript, while synthetic
   *  local/live ordinals (`localOrdinal`/`syntheticOrdinal`, both
   *  `Date.now()`-based) live in a disjoint numeric range and would be
   *  meaningless to dedupe against. See `enqueueHistory`. */
  private historyOrdinals = new Set<number>();
  /** Memoizes `pendingFromState` against the `openRequests` Map reference it
   *  was last derived from — `pendingFromState` itself always rebuilds fresh
   *  `permissions`/`questions` arrays (it has no way to know whether its
   *  input changed), so calling it unconditionally on every
   *  `applyReducerState` would hand consumers (e.g. `useAcpSession` ->
   *  `AcpChatItemRow`'s `pending` prop) a brand-new object identity on every
   *  flush — including flushes that only ever touched an unrelated streamed
   *  message chunk. `openRequests` (`./reduce`) is itself only ever
   *  reassigned to a new Map when a permission/question opens or closes
   *  (`reduceEnvelope`'s `openRequests = new Map(openRequests)` calls), so
   *  keying this cache on that reference is exactly the right invalidation
   *  signal: unrelated updates reuse the previous `AcpPendingPrompts` object,
   *  matching `chatItems`'s reference-stability contract. */
  private pendingPromptsCache: { openRequests: AcpReducerState['openRequests']; result: AcpPendingPrompts } | null = null;

  constructor(private readonly options: AcpSessionOptions) {
    this.client = createAcpClient({
      endpoint: options.endpoint,
      fetch: options.fetch,
      streamTransport: options.streamTransport,
    });
    this.scheduleFlush = options.scheduleFlush ?? ((flush) => queueMicrotask(flush));
    this.snapshot = { ...EMPTY_SNAPSHOT, acpSessionId: options.acpSessionId ?? null };
  }

  /**
   * Idempotent: a second call while a stream is already open is a no-op.
   * Bootstrap (`initialize` → `session/new`|`session/load`) is single-flight
   * via `this.bootstrap` — two overlapping `connect()`s (or a stream that
   * gets re-established after `close()`) share the one in-flight/settled
   * promise instead of re-running `session/new`.
   */
  connect(): void {
    if (!this.stream) {
      this.setConnection(this.snapshot.ready ? 'open' : 'connecting');
      const handle = this.client.connect({
        onEvent: (event) => {
          // A stream that's since been closed (or replaced by a later
          // reconnect) must not resurrect envelopes into this snapshot — the
          // callback closure outlives `close()`, so the guard is on identity,
          // not on the client-level stream having actually torn down.
          if (this.stream !== handle) return;
          this.enqueue({
            ordinal: syntheticOrdinal(event.id),
            direction: 'agent_to_client',
            streamEventId: event.id,
            envelope: event.envelope,
          });
        },
        onError: (error) => {
          if (this.stream !== handle) return;
          this.onStreamError(error);
        },
        onState: (state) => {
          if (this.stream !== handle) return;
          this.onStreamState(state);
        },
      });
      this.stream = handle;
    }
    // Independent of the stream half above: a bootstrap that failed nulls
    // `this.bootstrap` in its catch (see `runBootstrap`) but leaves the
    // stream alive, so this must always fall through and re-arm bootstrap
    // rather than being gated behind the `if (!this.stream)` branch — a
    // retry `connect()` after a bootstrap failure would otherwise never
    // re-run `initialize`/`session/new`.
    this.bootstrap ??= this.runBootstrap();
  }

  /**
   * Tears down the live stream and marks the connection closed, but
   * preserves `bootstrap` (and `createdSessionId`) so a later `connect()`
   * re-attaches to the already-minted session instead of re-running
   * `initialize`/`session/new`.
   */
  close(): void {
    this.stream?.close();
    this.stream = null;
    this.setConnection('closed');
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AcpSessionSnapshot {
    return this.snapshot;
  }

  /** Returns `false` without sending when there's no live session, or a
   *  request is already in flight. (Persisted-busy override — treating a
   *  reload-recovered in-flight prompt the same way — is a later task.) */
  async send(prompt: AcpContentBlock[]): Promise<boolean> {
    const sessionId = this.snapshot.acpSessionId;
    if (!sessionId || this.requestBusy) return false;
    this.patch({ error: null });
    this.setRequestBusy(true);
    // Sent PRE-await: `session/prompt` only resolves at end-of-turn, which
    // can take minutes, and the user's own message must appear immediately.
    // The `local-` prefixed id is what makes this row identifiable for
    // rollback below if the request turns out to fail.
    const localId = `local-${Date.now()}`;
    this.enqueue({
      ordinal: localOrdinal(),
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: { jsonrpc: '2.0', id: localId, method: 'session/prompt', params: { sessionId, prompt } },
    });
    try {
      await this.client.prompt(sessionId, prompt);
      return true;
    } catch (error) {
      // The optimistic echo above was wrong — the prompt never actually
      // went through — so it must not linger as a phantom chat row.
      this.removeLocalEnvelope(localId);
      this.patch({ error: toSessionError('rpc', error) });
      return false;
    } finally {
      this.setRequestBusy(false);
    }
  }

  async cancel(): Promise<void> {
    const sessionId = this.snapshot.acpSessionId;
    if (!sessionId) return;
    await this.client.cancel(sessionId);
    // `session/cancel` is a notification (no `id`) — the bridge only
    // replays `agent_to_client` events over the ACP SSE stream, so without
    // this local echo the busy-staleness policy in `reduce.ts` would never
    // see the cancel client-side until a reload re-fetches the transcript,
    // leaving `busy` wedged true for the remainder of the live session.
    // Mirrors `respondWithEcho`'s local echo for permission/question
    // responses.
    this.enqueue({
      ordinal: localOrdinal(),
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } },
    });
  }

  respondPermission(id: AcpJsonRpcId, optionId?: string): Promise<void> {
    return this.respondWithEcho(id, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  respondQuestion(id: AcpJsonRpcId, content: Record<string, unknown>): Promise<void> {
    return this.respondWithEcho(id, { action: 'accept', content });
  }

  rejectQuestion(id: AcpJsonRpcId): Promise<void> {
    return this.respondWithEcho(id, { action: 'decline' });
  }

  async setConfigOption(configId: string, value: unknown): Promise<boolean> {
    const sessionId = this.snapshot.acpSessionId;
    if (!sessionId) return false;
    this.patch({ error: null });
    try {
      const result = await this.client.setSessionConfigOption(sessionId, configId, value);
      this.patch({
        configOptions: result.configOptions
          ?? this.snapshot.configOptions.map((option) => (option.id === configId ? { ...option, currentValue: value } : option)),
      });
      return true;
    } catch (error) {
      this.patch({ error: toSessionError('rpc', error) });
      return false;
    }
  }

  private async runBootstrap(): Promise<void> {
    try {
      const history = await this.client.transcript();
      this.enqueueHistory(history.envelopes);
      const initialized = await this.client.initialize({
        protocolVersion: this.options.protocolVersion ?? 1,
        clientCapabilities: this.options.clientCapabilities ?? { auth: { _meta: { gateway: true } } },
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      });
      let id = this.options.acpSessionId ?? this.createdSessionId;
      const result = id
        ? await this.client.loadSession({ sessionId: id, cwd: this.cwd(), mcpServers: [] })
        : await this.client.newSession({ cwd: this.cwd(), mcpServers: [] });
      if (!id) {
        if (!result.sessionId) throw new Error('ACP session/new returned no sessionId');
        id = result.sessionId;
        this.createdSessionId = id;
      }
      this.patch({
        ready: true,
        connection: 'open',
        // A retried bootstrap that reaches here has, by definition,
        // superseded whatever BOOTSTRAP failure got it retried in the first
        // place — leaving `error` set would strand a stale failure message
        // (e.g. a consumer's error banner) next to a now fully-ready session.
        // Scoped to `kind === 'bootstrap'` only (mirrors `onStreamState`'s
        // same `kind`-gated clear for `'transport'`): a DIFFERENT error kind
        // — e.g. a live transport hiccup on the stream half of `connect()`,
        // racing concurrently with this same bootstrap — must not be wiped
        // out just because bootstrap happened to resolve after it landed.
        error: this.snapshot.error?.kind === 'bootstrap' ? null : this.snapshot.error,
        acpSessionId: id,
        configOptions: result.configOptions ?? [],
        capabilities: initialized.agentCapabilities ?? {},
        agentInfo: initialized.agentInfo ?? null,
        authMethods: initialized.authMethods ?? [],
      });
    } catch (error) {
      this.patch({ error: toSessionError('bootstrap', error), connection: 'failed' });
      // Allow a subsequent connect() to retry bootstrap from scratch.
      this.bootstrap = null;
    }
  }

  private onStreamError(error: unknown): void {
    // The underlying AcpClient already retries the SSE connection with
    // backoff internally (see client.ts's `run()`), so a transport error
    // here is surfaced for observability without forcing a connection-state
    // transition — the client keeps trying on its own. `onStreamState`
    // (driven by the client's own `onState` callback) clears this once the
    // retry reaches `'open'` again.
    this.patch({ error: toSessionError('transport', error) });
  }

  /** Mirrors the client's connection-lifecycle transitions onto
   *  `snapshot.connection`. Reaching `'open'` clears a lingering transient
   *  transport error (set by `onStreamError` above) — a successful reconnect
   *  is the signal that the earlier hiccup resolved itself; RPC (`'rpc'`) and
   *  bootstrap (`'bootstrap'`) errors are unrelated to live-stream health and
   *  are left alone here. */
  private onStreamState(state: AcpConnectionState): void {
    // The client's own SSE/poll loop (`client.ts`'s `run()`/`pollTranscript`)
    // has permanently stopped retrying once it reports `'failed'` (a
    // terminal transport error) or a clean `'closed'` it reached on its own
    // (the `reconnect: false` one-shot end-of-loop path) — as opposed to
    // `'closed'` from THIS session's own `close()`, which already nulls
    // `this.stream` itself right after calling `handle.close()`. Either way
    // `this.stream` still points at that now-dead handle, and `connect()`'s
    // `if (!this.stream)` guard would otherwise make a later retry a no-op
    // for the stream half — the dead handle looks "already open" forever.
    // Nulling it here re-arms that guard so the next `connect()` (e.g. the
    // hook's `retry()`) opens a genuinely NEW stream instead of doing
    // nothing. Safe to do unconditionally: re-nulling an already-null field
    // (the `close()` case) is a no-op, and every `onEvent`/`onError`/
    // `onState` callback closure guards on `this.stream !== handle` — which
    // a nulled `this.stream` fails identically to a stale OLD handle, so no
    // late event from a dead stream can resurrect state either way.
    if (state === 'failed' || state === 'closed') {
      this.stream = null;
    }
    if (state === 'open' && this.snapshot.error?.kind === 'transport') {
      this.patch({ connection: state, error: null });
      return;
    }
    this.setConnection(state);
  }

  private async respondWithEcho(id: AcpJsonRpcId, result: unknown): Promise<void> {
    await this.client.respond(id, result);
    // The bridge only replays `agent_to_client` events over the ACP SSE
    // stream — a `client_to_agent` response row never comes back on its
    // own, so without this local echo the pending permission/question card
    // would stay pending until a reload re-fetches the transcript.
    this.enqueue({
      ordinal: localOrdinal(),
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: { jsonrpc: '2.0', id, result },
    });
  }

  private setRequestBusy(value: boolean): void {
    this.requestBusy = value;
    this.patch({ busy: value || this.snapshot.turnState.busy });
  }

  private setConnection(connection: AcpConnectionState): void {
    // A same-state transition (e.g. `close()` called when already
    // 'closed') is a no-op: patching/emitting again would fire listeners for
    // a change that never happened, and `close()` unconditionally calls this
    // even when the stream was never opened or was already torn down.
    if (connection === this.snapshot.connection) return;
    this.patch({ connection });
  }

  private cwd(): string {
    return this.options.cwd ?? '/workspace';
  }

  /**
   * Idempotent across repeated calls with overlapping rows — a bootstrap
   * retry after a failed `initialize`/`session/new` (or a future re-sync)
   * calls this again with the FULL persisted transcript, which would
   * otherwise duplicate every already-folded row.
   *
   * This is the fix for a known carried bug: the old behavior deduped
   * purely via `reduceEnvelope`'s `(streamEventId, direction)` check, which
   * cannot see a `client_to_agent` row whose `streamEventId` is `null` (a
   * plain persisted prompt/response that never had a live SSE event of its
   * own — `null !== null` never matches, so `reduceEnvelope`'s dedupe guard
   * is skipped entirely for it, see its `row.streamEventId != null` check).
   * Ordinal dedupe has no such gap: every history row (`AcpTranscriptRow`)
   * carries a real, unique, authoritative ordinal regardless of
   * `streamEventId`.
   */
  private enqueueHistory(rows: readonly AcpStoredEnvelope[]): void {
    for (const row of rows) {
      if (this.historyOrdinals.has(row.ordinal)) continue;
      this.historyOrdinals.add(row.ordinal);
      this.enqueue(row);
    }
  }

  private enqueue(row: AcpStoredEnvelope): void {
    this.reconcileLocalEcho(row);
    this.pendingEnvelopes.push(row);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduleFlush(() => this.flush());
  }

  /**
   * Drops a still-present LOCAL optimistic echo (`send()`'s `local-` prompt
   * row, or a `respondPermission`/`respondQuestion`/`rejectQuestion` respond
   * echo) the instant a GENUINE server-originated row for the same action is
   * about to be enqueued — via a history re-fetch (the only transport that
   * ever redelivers a `client_to_agent` row; live SSE/poll only ever replay
   * `agent_to_client`, per `AcpClient`) or, in principle, a live event.
   * Keeps exactly one envelope/chat item per action instead of a permanent
   * local-id duplicate sitting next to the server's authoritative row.
   *
   * Matching:
   * - `session/prompt`: the local echo's id is a synthetic `local-...`
   *   string (`send()` never sees the REAL id `AcpClient.prompt()` mints
   *   internally), so ids can never literally match. `requestBusy` allows at
   *   most one outstanding prompt at a time, so it is always correct to drop
   *   every still-present local prompt echo the moment ANY genuine
   *   `session/prompt` row appears.
   * - Respond echoes (`respondWithEcho`): the local echo reuses the REAL
   *   request id it is answering, so an exact `(direction, id)` match is
   *   both correct and sufficient.
   * - `session/cancel`: a notification (no `id`) that never produces a chat
   *   item (see `reduce.ts`'s `session/cancel` branch — it only clears
   *   turn-state bookkeeping), so a duplicate cancel ROW cannot produce a
   *   duplicate chat bubble. Reconciling it is intentionally out of scope
   *   here.
   */
  private reconcileLocalEcho(row: AcpStoredEnvelope): void {
    if (isLocalEchoRow(row)) return; // never reconciles against itself
    const envelope = row.envelope as Record<string, unknown>;
    if (row.direction !== 'client_to_agent') return;

    if (envelope.method === 'session/prompt') {
      this.removeRows(isLocalPromptEcho);
      return;
    }
    if ('id' in envelope && !('method' in envelope) && ('result' in envelope || 'error' in envelope)) {
      const id = envelope.id;
      this.removeRows((candidate) => isLocalRespondEcho(candidate) && (candidate.envelope as Record<string, unknown>).id === id);
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.pendingEnvelopes.length) return;
    const batch = this.pendingEnvelopes;
    this.pendingEnvelopes = [];
    this.applyBatch(batch);
    this.emit();
  }

  /**
   * Folds each row in the batch onto `this.reducerState` via `reduceEnvelope`
   * (`./reduce`) — O(batch), not O(n): a duplicate `streamEventId` row is a
   * reducer no-op (detected by reference equality, no separate scan), and an
   * untouched `chatItems` entry keeps its previous identity.
   *
   * This is only correct as a straight fold if every accepted row's ordinal
   * is >= every previously-folded row's ordinal — true in the overwhelming
   * common case (history loads, then live events stream in), but not
   * guaranteed: a live SSE event can in principle reach `enqueue()` before a
   * concurrently in-flight history fetch resolves and enqueues its (smaller-
   * ordinal) rows. When that happens this falls back to a full
   * fold-from-scratch over the ordinal-sorted log — exactly what every flush
   * used to do — so correctness never regresses; only the common case gets
   * cheaper.
   */
  private applyBatch(batch: readonly AcpStoredEnvelope[]): void {
    let working = this.reducerState;
    const priorEnvelopes = working.envelopes;
    let cursor = priorEnvelopes.length ? priorEnvelopes[priorEnvelopes.length - 1].ordinal : -Infinity;
    let appendOnly = true;
    for (const row of batch) {
      const next = reduceEnvelope(working, row);
      if (next === working) continue; // duplicate streamEventId — reducer no-op
      if (row.ordinal < cursor) appendOnly = false;
      cursor = Math.max(cursor, row.ordinal);
      working = next;
    }
    if (working === this.reducerState) return;
    if (appendOnly) {
      this.reducerState = working;
      this.applyReducerState();
    } else {
      this.recomputeProjections([...working.envelopes].sort((a, b) => a.ordinal - b.ordinal));
    }
  }

  /**
   * Removes a locally-originated optimistic echo (matched by its `local-`
   * prefixed envelope id) from both the not-yet-flushed batch and the
   * committed log — used to roll back `send()`'s optimistic `session/prompt`
   * row when the underlying RPC call fails. Rare path.
   */
  private removeLocalEnvelope(localId: string): void {
    this.removeRows((row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).id === localId);
  }

  /**
   * Removes every row matching `predicate` from both the not-yet-flushed
   * batch and the committed log, rebuilding reducer state from scratch (via
   * `recomputeProjections`) iff the committed log actually changed. Shared
   * by `removeLocalEnvelope` (send() rollback) and `reconcileLocalEcho`
   * (server-row supersession) — both are rare, off-the-happy-path
   * corrections where a fold-from-scratch is an acceptable cost.
   */
  private removeRows(predicate: (row: AcpStoredEnvelope) => boolean): void {
    this.pendingEnvelopes = this.pendingEnvelopes.filter((row) => !predicate(row));
    const filtered = this.reducerState.envelopes.filter((row) => !predicate(row));
    if (filtered.length === this.reducerState.envelopes.length) return;
    this.recomputeProjections(filtered);
  }

  /** Rebuilds the reducer state from scratch over `envelopes` (already
   *  ordinal-sorted) via `reduceEnvelope`, and patches the derived snapshot
   *  fields onto `this.snapshot` without emitting — callers (`applyBatch`'s
   *  rare out-of-order path, `removeLocalEnvelope`) either emit separately
   *  (`flush`) or fold this into a subsequent `patch()` call that does. */
  private recomputeProjections(envelopes: readonly AcpStoredEnvelope[]): void {
    this.reducerState = envelopes.reduce((state, row) => reduceEnvelope(state, row), emptyReducerState());
    this.applyReducerState();
  }

  /** Derives `chatItems`/`pendingPrompts`/`usage`/`turnState`/`envelopes`
   *  from `this.reducerState` and patches them onto `this.snapshot` without
   *  emitting. */
  private applyReducerState(): void {
    const turnState = this.reducerState.turnState;
    this.snapshot = {
      ...this.snapshot,
      envelopes: this.reducerState.envelopes,
      chatItems: this.reducerState.chatItems,
      pendingPrompts: this.derivePendingPrompts(),
      usage: this.reducerState.usage,
      turnState,
      busy: this.requestBusy || turnState.busy,
    };
  }

  /** See `pendingPromptsCache`'s doc comment. */
  private derivePendingPrompts(): AcpPendingPrompts {
    const openRequests = this.reducerState.openRequests;
    if (this.pendingPromptsCache?.openRequests === openRequests) return this.pendingPromptsCache.result;
    const result = pendingFromState(this.reducerState);
    this.pendingPromptsCache = { openRequests, result };
    return result;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(partial: Partial<AcpSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emit();
  }
}

export function createAcpSession(options: AcpSessionOptions): AcpSession {
  return new AcpSession(options);
}
