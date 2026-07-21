import { createAcpClient, type AcpClient } from './client';
import { clearOpenPrompts, emptyReducerState, pendingFromState, reduceEnvelope, type AcpReducerState } from './reduce';
import { markLiveSessionLoadReplay } from './load-replay';
import {
  type AcpAvailableCommand,
  type AcpChatItem,
  type AcpPendingPrompts,
  type AcpSessionInfo,
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
  /** Folded `session_info_update` state (thread title/status) — see
   *  `AcpSessionInfo`'s doc comment. `null` until the harness sends its first
   *  such notification for this session. */
  sessionInfo: AcpSessionInfo | null;
  /** Folded `available_commands_update` state — see `AcpAvailableCommand`'s
   *  doc comment. `[]` until the harness sends its first such notification
   *  for this session (or if it never advertises any commands). */
  availableCommands: AcpAvailableCommand[];
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
  /** Default {@link ACP_BOOTSTRAP_TIMEOUT_MS}; tests override with a small
   *  value so a deliberately-hung bootstrap RPC doesn't make the suite wait
   *  out the real production budget. */
  bootstrapTimeoutMs?: number;
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
  sessionInfo: null,
  availableCommands: [],
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

/** A repeat `initialize` against a still-running harness process — codex-acp
 *  answers `-32603` with `data.details: "Already initialized"`; other
 *  adapters put the phrase in the message. A healthy-process signal, not a
 *  bootstrap failure. */
function isAlreadyInitializedError(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) return false;
  const details =
    typeof error.data === 'object' && error.data !== null
      ? String((error.data as Record<string, unknown>).details ?? '')
      : '';
  return /already initialized/i.test(details) || /already initialized/i.test(error.message);
}

/**
 * Bounded wall-clock budget for ONE bootstrap attempt (`initialize` →
 * `session/new`|`session/load`, plus the `transcript()` fetch ahead of it).
 * Deliberately NOT applied to `send()`/`session/prompt` — a turn can
 * legitimately run for minutes once the session is live (see `send()`'s doc
 * comment).
 *
 * By the time bootstrap runs, the sandbox's own health check has already
 * reported the harness process running (`useSession`'s `switched` gate on
 * the backend's `/start` stage — see `openSession` in
 * `apps/api/src/projects/routes/shared.ts`), so a normal bootstrap answers
 * in well under this budget. Without a bound, a harness that never responds
 * to `session/new` — e.g. it blocks trying to resolve a model with no
 * connected provider, or the in-sandbox proxy silently drops the request —
 * leaves `runBootstrap` permanently pending: `error` never gets patched,
 * `connection` never reaches `'failed'`, and every consumer keyed off a
 * terminal state (the boot loader, `useSession`'s `phase`) spins on
 * "Connecting" forever instead of surfacing a failure the user can act on.
 */
export const ACP_BOOTSTRAP_TIMEOUT_MS = 30_000;

/** Thrown by `withBootstrapTimeout` when a bootstrap attempt outruns
 *  {@link ACP_BOOTSTRAP_TIMEOUT_MS}. Always terminal (see `toSessionError`'s
 *  `kind === 'bootstrap'` fallback) — a hung handshake has no automatic
 *  retry loop of its own, so `connect()`/`retry()` must be called again
 *  explicitly. */
export class AcpBootstrapTimeoutError extends Error {
  constructor() {
    super(
      'The session runtime did not respond in time. It may have no model or ' +
        'provider connected, or the sandbox may be stuck starting.',
    );
    this.name = 'AcpBootstrapTimeoutError';
  }
}

/**
 * Races `promise` against a timer. The loser's outcome is discarded (a
 * settled `Promise` ignores every subsequent `resolve`/`reject` call), but
 * `promise` itself keeps running in the background if the timer wins —
 * there is no way to cancel an in-flight `fetch` awaited deep inside it —
 * so callers that patch external state from within `promise` MUST guard
 * that with their own identity/generation check (see `performBootstrap`).
 */
function withBootstrapTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AcpBootstrapTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  /** True only while the bootstrap `session/load` RPC is awaiting its result.
   *  Native agents emit the loaded conversation over SSE inside this window;
   *  the stream does not echo the client load request, so those live row
   *  objects need an in-memory projection marker (see `load-replay.ts`). */
  private sessionLoadInFlight = false;
  /** High-water mark for `enqueueHistory`'s idempotency check — the largest
   *  `ordinal` ever accepted from history. Replaces the old `Set<number>` of
   *  every ordinal ever accepted (one entry retained for the life of the
   *  session per history row — O(session length) memory) with a single
   *  number: O(1).
   *
   *  This is sound (not merely an optimization with a correctness cost)
   *  because of two things holding together: ordinals are a
   *  `GENERATED ALWAYS AS IDENTITY` column (P1-b pinned this — strictly
   *  increasing, never reused, never reassigned), and `enqueueHistory` is
   *  ONLY ever called with the FULL persisted transcript (`runBootstrap`'s
   *  `client.transcript()` call passes no `after` cursor — see `client.ts`).
   *  Given that, any ordinal smaller than one already accepted must already
   *  have existed — and therefore already have been returned — at the
   *  moment the larger one was first accepted, since a full-transcript fetch
   *  is exhaustive up to its own point in time. A later re-delivery of that
   *  smaller ordinal (a bootstrap retry re-fetching the SAME full
   *  transcript, e.g. after a transient `initialize` failure) can therefore
   *  only ever be a genuine duplicate, never a row seen for the first time —
   *  remembering the single largest ordinal accepted is exactly as correct
   *  as remembering every individual one.
   *
   *  `enqueueHistory` computes each call's duplicate threshold from this
   *  mark's value from BEFORE that call's loop starts (not updated
   *  mid-loop), so a single call's own row array never needs to already be
   *  ordinal-sorted for this to stay correct — see `enqueueHistory`.
   *
   *  Scoped to history rows only (never advanced by a live/local `enqueue()`
   *  call) since server ordinals are authoritative and unique per
   *  transcript, while synthetic local/live ordinals
   *  (`localOrdinal`/`syntheticOrdinal`, both `Date.now()`-based) live in a
   *  disjoint (much larger) numeric range and would be meaningless to
   *  compare against this mark. */
  private historyHighWaterMark = -Infinity;
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
  /**
   * The single choke point for the race this guards against: `apps/web` has
   * (at least) three independent auto-answer mechanisms that can each call
   * `respondPermission`/`respondQuestion`/`rejectQuestion` for the SAME
   * request id before any of their round-trips resolve — the session-level
   * `autoApprovePermissions` toggle (`useAcpSession`), the project-policy
   * auto-answer effect, and the "allow everything" bulk path
   * (`PermissionPrompt`). Each of those keeps its OWN local dedupe ref, so
   * none of them can see the others firing — only `AcpSession` sees every
   * respond call, which is why the dedupe lives here and not in any one
   * caller.
   *
   * Keyed by `String(id)` (`AcpJsonRpcId` is `string | number`, and a `Set`
   * needs value equality, not the `===` a raw union would give inconsistent
   * results for). Marked SYNCHRONOUSLY at the top of `respondWithEcho`,
   * before the `await this.client.respond(...)` call — a second call
   * arriving on the same microtask (the exact StrictMode-double-invoke /
   * racing-effects shape this guards against) sees the mark before its own
   * network call would ever fire.
   *
   * Cleared ONLY on failure (see `respondWithEcho`'s catch) so a genuine
   * retry after a transient failure still sends. Never cleared on success —
   * a JSON-RPC id in this session is answered at most once; the *pending*
   * side of that (removing it from `pendingPrompts`) is already handled by
   * the reducer once the respond echo/history reconciles, which is an
   * orthogonal concern from "should a second respond call hit the network".
   */
  private respondingOrAnsweredIds = new Set<string>();
  /** Bumped once per `runBootstrap()` call — the identity guard `performBootstrap`
   *  and the timeout-race catch use to ignore a superseded attempt's result.
   *  See `runBootstrap`'s doc comment. */
  private bootstrapGeneration = 0;

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
          const row: AcpStoredEnvelope = {
            ordinal: syntheticOrdinal(event.id),
            direction: 'agent_to_client',
            streamEventId: event.id,
            envelope: event.envelope,
          };
          if (
            this.sessionLoadInFlight
            && (event.envelope as Record<string, unknown>).method === 'session/update'
          ) {
            markLiveSessionLoadReplay(row);
          }
          this.enqueue(row);
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

  /**
   * Returns `false` without sending when there's no live session, or a
   * request is already live-in-flight (`requestBusy`) FROM THIS CLIENT.
   *
   * Deliberately does NOT also gate on `snapshot.busy`/`turnState.busy` when
   * that's true purely from a reload-recovered persisted prompt (see
   * `openPromptIds` in `./reduce` and `clearStalePersistedBusy` below) — a
   * prompt orphaned by a page reload has no live request this client is
   * tracking, so there's nothing here for a NEW `send()` to collide with.
   * Sending proceeds, and the new prompt supersedes the stale orphan via the
   * busy-staleness policy (`reduce.ts`'s `session/prompt` branch) the same
   * way a `session/cancel` would. See `clearStalePersistedBusy` for the
   * complementary liveness guard: what happens when NEITHER a response nor a
   * new prompt/cancel ever arrives for that orphaned turn.
   */
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

  /**
   * De-duped at `respondWithEcho` (see its doc comment) — a second call for
   * an id already in flight or already answered is a documented no-op that
   * resolves `undefined`, same as a fresh success. Callers that already
   * `await`/`.catch()` this (`useAcpSession`'s `autoApprovePermissions`
   * effect, `PermissionPrompt`'s policy auto-answer effect, its "allow
   * everything" bulk path) see no behavior change on the happy path.
   */
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
    // Identity guard for the timeout race below: `performBootstrap()` keeps
    // running in the background even after `withBootstrapTimeout` gives up
    // on it (there is no way to cancel an in-flight `fetch` awaited deep
    // inside it), so a generation stamp — not just "did this promise
    // resolve" — is what stops a since-abandoned attempt's eventual result
    // from clobbering a NEWER attempt's (or the timeout's own) patched
    // state. Mirrors the `this.stream !== handle` identity guards in
    // `connect()` above.
    const generation = ++this.bootstrapGeneration;
    try {
      await withBootstrapTimeout(
        this.performBootstrap(generation),
        this.options.bootstrapTimeoutMs ?? ACP_BOOTSTRAP_TIMEOUT_MS,
      );
    } catch (error) {
      if (generation !== this.bootstrapGeneration) return;
      // Bump the generation HERE too, not only at the top of the next
      // `runBootstrap()` call: when the TIMEOUT is what won this race,
      // `performBootstrap(generation)` is still running in the background
      // and will eventually reach its own `generation !==
      // this.bootstrapGeneration` check before patching `ready: true` — this
      // is what makes that check actually fire instead of comparing the
      // still-current `generation` against itself.
      this.bootstrapGeneration += 1;
      const sessionError = toSessionError('bootstrap', error);
      this.patch({ error: sessionError, connection: 'failed' });
      // Wedge guard (see `clearStalePersistedBusy`'s doc): only a TERMINAL
      // bootstrap failure clears a reload-recovered persisted-busy prompt —
      // a transient one (e.g. a 500 on `initialize` that a retried
      // `connect()` will succeed past, `terminal: false` per
      // `toSessionError`) must NOT clear it, or a still-genuinely-pending
      // turn would flash "not busy" for the retry window even though
      // nothing about its liveness actually changed.
      if (sessionError.terminal) this.clearStalePersistedBusy();
      // Allow a subsequent connect() to retry bootstrap from scratch.
      this.bootstrap = null;
    }
  }

  /**
   * The actual bootstrap handshake (`initialize` → `session/new`|
   * `session/load`), split out of `runBootstrap` so the latter can race it
   * against `ACP_BOOTSTRAP_TIMEOUT_MS` (see that constant's doc comment for
   * WHY: a hung harness must become a terminal error, never an infinite
   * "Connecting"). Every `this.patch(...)` call here is gated on `generation`
   * still being the CURRENT attempt — see `runBootstrap`'s guard comment.
   */
  private async performBootstrap(generation: number): Promise<void> {
    const history = await this.client.transcript();
    this.enqueueHistory(history.envelopes);
    // A reload/reconnect reaches a harness process that already completed
    // its handshake; codex-acp (and other adapters) reject the repeat
    // `initialize` with `-32603` / "Already initialized". That is a healthy
    // process, not a failed bootstrap — proceed to `session/load` and keep
    // the capabilities/agentInfo already reduced from the persisted
    // transcript's original `initialize` result.
    let initialized: Awaited<ReturnType<AcpClient['initialize']>> | null = null;
    try {
      initialized = await this.client.initialize({
        protocolVersion: this.options.protocolVersion ?? 1,
        clientCapabilities: this.options.clientCapabilities ?? { auth: { _meta: { gateway: true } } },
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      });
    } catch (error) {
      if (!isAlreadyInitializedError(error)) throw error;
    }
    let id = this.options.acpSessionId ?? this.createdSessionId;
    let result: Awaited<ReturnType<AcpClient['loadSession']>>;
    if (id) {
      try {
        this.sessionLoadInFlight = true;
        try {
          result = await this.client.loadSession({ sessionId: id, cwd: this.cwd(), mcpServers: [] });
        } finally {
          this.sessionLoadInFlight = false;
        }
      } catch (error) {
        // The harness could not resume this ACP session (process restarted,
        // rollout/thread state gone — e.g. codex-acp's "no rollout found
        // for thread id …"). The DURABLE identity is the Kortix session and
        // its platform-persisted envelope log, not the harness-native ACP
        // session id — so mint a fresh one and continue instead of bricking
        // the session. Only RPC rejections take this path; transport
        // failures still abort bootstrap for the retry loop.
        if (!(error instanceof AcpRpcError)) throw error;
        id = null;
        result = await this.client.newSession({ cwd: this.cwd(), mcpServers: [] });
      }
    } else {
      result = await this.client.newSession({ cwd: this.cwd(), mcpServers: [] });
    }
    if (!id) {
      if (!result.sessionId) throw new Error('ACP session/new returned no sessionId');
      id = result.sessionId;
      this.createdSessionId = id;
    }
    // A since-abandoned attempt (superseded by a newer `runBootstrap()`, or
    // one the timeout race already reported as failed) must not resurrect
    // `ready: true` after the fact — see `runBootstrap`'s guard comment.
    if (generation !== this.bootstrapGeneration) return;
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
      // On a skipped re-initialize ("Already initialized"), keep whatever
      // the persisted transcript's original `initialize` result already
      // populated on the snapshot instead of blanking it.
      capabilities: initialized?.agentCapabilities ?? this.snapshot.capabilities,
      agentInfo: initialized?.agentInfo ?? this.snapshot.agentInfo,
      authMethods: initialized?.authMethods ?? this.snapshot.authMethods,
    });
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
    // Wedge guard (see `clearStalePersistedBusy`'s doc): `'failed'` is only
    // ever reported when the client's own retry loop has permanently given
    // up on a TERMINAL transport error (see `client.ts`'s `run()` —
    // `AcpTransportError && error.terminal`), never for an ordinary
    // reconnect hiccup, so it's always safe to treat as "this connection
    // will never again tell us what happened to an orphaned turn".
    // Deliberately excludes plain `'closed'`: that also fires for THIS
    // session's own `close()` (a deliberate, benign disconnect — e.g. a
    // consumer unmounting — that says nothing about the turn's liveness and
    // must not zero out state a later `connect()` on the SAME session would
    // still need to see as busy).
    if (state === 'failed') {
      this.clearStalePersistedBusy();
    }
    if (state === 'open' && this.snapshot.error?.kind === 'transport') {
      this.patch({ connection: state, error: null });
      return;
    }
    this.setConnection(state);
  }

  /**
   * The wedge guard promised by `send()`'s doc comment: a reload-recovered
   * persisted-busy prompt (`turnState.busy` true purely from `openPromptIds`
   * populated by bootstrap history — see `reduce.ts`) is cleared here when a
   * DEAD turn is detected, so it never wedges the UI busy indicator forever
   * when neither a response, a cancel, nor a new prompt is ever coming.
   *
   * Chosen guard: two connection-lifecycle SIGNALS, not a wall-clock
   * timeout — this store has no clock anywhere in its state-transition logic
   * today (`Date.now()` is used only to mint disjoint, always-increasing
   * ordinals/ids — `syntheticOrdinal`/`localOrdinal`/`send()`'s `localId` —
   * never compared against elapsed time to make a decision), and a
   * wall-clock bound would be the first such use, sacrificing this file's
   * deterministic-fixture testability for a benefit that's marginal here
   * (see the residual case below):
   *
   *   (a) A TERMINAL bootstrap failure (`runBootstrap`'s catch, gated on
   *       `sessionError.terminal`) — `session/load` (or `initialize`)
   *       itself failing unrecoverably (e.g. a 404/410: the harness/sandbox
   *       backing this session is gone) is the harness's own report that it
   *       cannot even confirm the session's current state, let alone that
   *       turn's outcome.
   *   (b) A live stream reaching connection-state `'failed'` (`onStreamState`
   *       above) — the ONE terminal, no-more-retries transport signal this
   *       client ever receives after bootstrap has already succeeded.
   *
   * RESIDUAL CASE, stated honestly: a harness that crashes WITHOUT the
   * bridge ever surfacing either signal — bootstrap succeeds, the live
   * stream reaches `'open'` and just stays there, idle, forever, because
   * nothing upstream detects the dead process — is not covered. `busy`
   * stays wedged true until the user manually intervenes (a new `send()` or
   * `cancel()`, both of which already supersede it unconditionally via the
   * busy-staleness policy — see `send()`'s doc comment). This residual is
   * accepted, not fixed, because: (1) no protocol-level signal exists today
   * for "the harness silently died" short of a heartbeat/timeout, which
   * would require the clock this store deliberately avoids; (2) the wedge
   * is a soft UI signal, not a functional lock — `send()` already proceeds
   * regardless of persisted-only busy (see its doc comment and
   * `session.test.ts`'s "send() proceeds when busy comes only from
   * persisted state" test), so a stuck spinner is the full extent of the
   * damage, always escapable by the user's own next action.
   *
   * Deliberately does NOT touch `requestBusy` — a LIVE `send()` await in
   * progress is tracked independently and has its own resolution path (the
   * `finally` in `send()`); `openPromptIds` (what `clearOpenPrompts` clears)
   * is populated ONLY by `enqueueHistory`'s one-time bootstrap replay, never
   * by a live/local echo — see `openPromptSessionIds`'s doc in `reduce.ts`.
   */
  private clearStalePersistedBusy(): void {
    if (this.reducerState.turnState.pendingPromptIds.length === 0) return;
    this.reducerState = clearOpenPrompts(this.reducerState);
    this.applyReducerState();
    this.emit();
  }

  /**
   * See `respondingOrAnsweredIds`'s doc comment for why this dedupe exists
   * and lives here. A second call for an id already in flight or already
   * answered resolves immediately as a no-op — it never reaches
   * `this.client.respond`, and never enqueues a second echo row.
   */
  private async respondWithEcho(id: AcpJsonRpcId, result: unknown): Promise<void> {
    const key = String(id);
    if (this.respondingOrAnsweredIds.has(key)) return;
    this.respondingOrAnsweredIds.add(key);
    try {
      await this.client.respond(id, result);
    } catch (error) {
      // Only a FAILURE clears the mark — a genuine retry (e.g. the caller's
      // own `.catch()` re-driving its auto-answer effect) must be able to
      // send again. Success leaves the id marked forever; see the doc
      // comment on `respondingOrAnsweredIds`.
      this.respondingOrAnsweredIds.delete(key);
      throw error;
    }
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
    // The duplicate threshold is fixed to the mark's value from BEFORE this
    // call (not re-read from `this.historyHighWaterMark` on every
    // iteration) and the mark itself is only advanced once, at the end —
    // see `historyHighWaterMark`'s doc for why this keeps a within-call
    // out-of-order row array (never observed in practice, not contractually
    // promised either) from having an earlier row in the SAME call
    // incorrectly raise the bar for a later, genuinely-new-but-smaller one.
    const dedupeThreshold = this.historyHighWaterMark;
    let newHighWaterMark = dedupeThreshold;
    for (const row of rows) {
      if (row.ordinal <= dedupeThreshold) continue;
      newHighWaterMark = Math.max(newHighWaterMark, row.ordinal);
      this.enqueue(row);
    }
    this.historyHighWaterMark = newHighWaterMark;
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
    const lastPriorEnvelope = priorEnvelopes[priorEnvelopes.length - 1];
    let cursor = lastPriorEnvelope !== undefined ? lastPriorEnvelope.ordinal : -Infinity;
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

  /** Derives `chatItems`/`pendingPrompts`/`usage`/`turnState`/`envelopes`/
   *  `sessionInfo` from `this.reducerState` and patches them onto
   *  `this.snapshot` without emitting.
   *
   *  `configOptions` is patched here too, but ONLY from a live
   *  `config_option_update` notification (`reducerState.liveConfigOptions`),
   *  and only once one has actually arrived (`liveConfigOptions` starts
   *  `null` and never reverts) — `performBootstrap`/`setConfigOption` are
   *  what set the INITIAL value (from `session/new`/`session/load`/
   *  `session/set_config_option`'s own RPC result), and this must never
   *  clobber that with `null` on an unrelated flush (a plain message chunk,
   *  say) that carries no live config update of its own. */
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
      sessionInfo: this.reducerState.sessionInfo,
      configOptions: this.reducerState.liveConfigOptions ?? this.snapshot.configOptions,
      availableCommands: this.reducerState.availableCommands,
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
