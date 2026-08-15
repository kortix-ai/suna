/** Raw `/start` stage, or `null` while the first `/start` is still in flight. */
export type SessionStartStageValue =
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'failed'
  | null;

export interface SessionTerminalState {
  /** Raw `/start` stage — the ONLY server-declared terminal signal. */
  stage: SessionStartStageValue;
  /** `/start` `retriable`: true while polling can still make progress. */
  retriable: boolean;
  hasStartError: boolean;
  sandboxStatus?: string | null;
}

/**
 * Detect a terminal `/start` FAILURE that has no serialized sandbox row.
 *
 * Read `stage`, never `phase`. `useSession` collapses three unrelated
 * conditions into `phase === 'error'`: a terminal stage, a typed `/start`
 * error, AND a transient OpenCode REST error. Deriving "provisioning failed
 * before allocation" from `phase` therefore fired on states that are not a
 * provisioning failure at all — a session the server reports as `stopped`, and
 * a session still booting (`stage: 'starting'`, `sandbox: null`, `retriable:
 * true`) whose runtime list happened to error. Both painted a terminal
 * "Couldn't start session" card over a session that had not failed.
 *
 * `retriable` is the server's own "polling can still make progress" flag, so an
 * unfinished boot can never be reported as a dead end even if a future stage
 * value lands here.
 */
export function isUnmaterializedSessionFailure(state: SessionTerminalState): boolean {
  if (state.hasStartError || state.retriable) return false;
  if (state.stage !== 'failed') return false;
  return state.sandboxStatus == null;
}

/**
 * Detect a session the server reports as `stopped` with no serialized sandbox
 * row (`openSession`'s terminal branch for a `stopped`/`completed` session row).
 *
 * It needs its own branch because the page's `fatal` path reads
 * `sandbox.status`, which is unavailable here — so this state used to fall
 * through to the unmaterialized-FAILURE card and tell the user a session that
 * merely stopped had "failed before its computer was created".
 */
export function isDormantSessionWithoutRuntime(state: SessionTerminalState): boolean {
  if (state.hasStartError || state.retriable) return false;
  if (state.stage !== 'stopped') return false;
  return state.sandboxStatus == null;
}

/** The subset of `fatal`'s inputs this decision needs. */
export interface StoppedSandboxCacheState {
  /** `sandbox.status` from the route's `fatal` gate — only `'stopped'`/`'error'` matter here. */
  sandboxStatus: string | null | undefined;
  /**
   * Renderable content already exists for this session without a live
   * runtime — cached transcript messages (SDK sync store, painted from
   * IndexedDB/memory; see `use-session-sync.ts`) or an optimistic prompt in
   * flight. The cheapest truthful signal, read from the route's own
   * `hasTranscript`/pending-prompt state — never recomputed here.
   */
  hasCachedContent: boolean;
}

/**
 * A `stopped`/`error` sandbox whose session already has renderable cached
 * content should render the TRANSCRIPT with a calm waking affordance, not the
 * full-screen restart/waking card `fatal` used to force unconditionally.
 *
 * Reading what you already wrote never needs a sandbox — Gate B in
 * `session-chat.tsx` (`resolveSessionContentState`) already paints cached
 * messages without waiting on the runtime; this is the route-level gate that
 * used to defeat it by replacing the whole chat before Gate B ever ran.
 *
 * The composer stays gated separately: `sessionComposerReadiness` disables
 * nothing (it queues instead — see `message-queue-boundary.ts`'s
 * `runtimeReady` gate) but shows its own "waking" notice while the runtime is
 * down. Only the READ path is freed here; SENDING still waits on the runtime,
 * unchanged.
 *
 * A sandbox status outside `'stopped'`/`'error'` — or no cached content —
 * returns `false`: the terminal card stays exactly as it was, byte for byte.
 */
export function canRenderCachedTranscriptWhileSandboxDown(
  state: StoppedSandboxCacheState,
): boolean {
  const sandboxIsDown = state.sandboxStatus === 'stopped' || state.sandboxStatus === 'error';
  return sandboxIsDown && state.hasCachedContent;
}
