/** Raw `/start` stage, or `null` while the first `/start` is still in flight. */
export type SessionStartStageValue =
  'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed' | null;

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
 * nothing (a submit becomes a durable inbox row the control plane delivers once
 * the box answers) but shows its own "waking" notice while the runtime is down.
 * Only the READ path is freed here; SENDING still waits on the runtime,
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

/**
 * Which surface the session route paints, decided in ONE place.
 *
 * The route used to decide this with an ordered `if` chain over a dozen
 * booleans, and the order was the only transition table. This function is
 * that table. Every input is a fact the route already derives; the output
 * names a full-screen surface (`screen`), a terminal notice in the composer's
 * slot over a readable transcript (`notice`), or neither (the chat).
 *
 * Precedence, first match wins:
 * 1. switch-loading · 2. billing-gated · 3. missing (404) · 4. archived (the
 * session was deleted and its computer removed) · 5. repository-disconnected
 * · 6. waking (the wake ladder still has rungs) or start-failure · 7. dormant
 * (stopped, no sandbox row) · 8. runtime-lost · 9. stopped (`fatal`): the
 * auto-resume boot loader or the Restart card · 10. chat.
 *
 * A readable transcript turns 5, 6 (failure), 7 (legacy) and 8 into notices,
 * and a notice blocks the lower terminal checks (7, 8), as before. Step 9
 * still replaces the chat when no cached transcript may render.
 */
export type SessionRouteScreen =
  | 'switch-loading'
  | 'billing-gated'
  | 'missing'
  | 'archived'
  | 'repository-disconnected'
  | 'waking'
  | 'start-failure'
  | 'legacy-dormant'
  | 'stopped-dormant'
  | 'runtime-lost'
  | 'auto-resuming'
  | 'stopped';

export type SessionRouteNotice =
  | 'archived'
  | 'repository-disconnected'
  | 'start-failure'
  | 'legacy-dormant'
  | 'runtime-lost';

export interface SessionRouteSurfaceInput {
  sessionSwitchLoading: boolean;
  gated: boolean;
  sessionMissing: boolean;
  /** `sandbox.status === 'archived'`. */
  sandboxArchived: boolean;
  repositoryDisconnected: boolean;
  wakeLadderHolding: boolean;
  /** `recoverableFailure !== null`. */
  hasRecoverableFailure: boolean;
  dormantWithoutRuntime: boolean;
  legacyMigrated: boolean;
  runtimeIdentityUnavailable: boolean;
  previousRepositoryHistoryAvailable: boolean;
  /** `sandbox.status` is `stopped|error` and `shouldPaintFatalCard` says paint. */
  fatal: boolean;
  autoResuming: boolean;
  hasTranscript: boolean;
  showCachedTranscriptWhileDown: boolean;
}

export interface SessionRouteSurface {
  screen: SessionRouteScreen | null;
  notice: SessionRouteNotice | null;
}

export function resolveSessionRouteSurface(input: SessionRouteSurfaceInput): SessionRouteSurface {
  const screen = (kind: SessionRouteScreen): SessionRouteSurface => ({ screen: kind, notice: null });
  if (input.sessionSwitchLoading) return screen('switch-loading');
  if (input.gated) return screen('billing-gated');
  if (input.sessionMissing) return screen('missing');

  let notice: SessionRouteNotice | null = null;
  const screenOrNotice = (kind: SessionRouteScreen & SessionRouteNotice): SessionRouteSurface | null => {
    if (!input.hasTranscript) return screen(kind);
    notice = kind;
    return null;
  };

  if (input.sandboxArchived) {
    const surface = screenOrNotice('archived');
    if (surface) return surface;
  }
  if (!notice && input.repositoryDisconnected) {
    const surface = screenOrNotice('repository-disconnected');
    if (surface) return surface;
  }
  if (input.wakeLadderHolding) {
    if (!input.showCachedTranscriptWhileDown) return screen('waking');
  } else if (input.hasRecoverableFailure && !notice) {
    const surface = screenOrNotice('start-failure');
    if (surface) return surface;
  }
  if (!notice && input.dormantWithoutRuntime) {
    if (input.legacyMigrated) {
      const surface = screenOrNotice('legacy-dormant');
      if (surface) return surface;
    } else if (!input.hasTranscript) {
      // A deliberate stop with a readable transcript is not a dead end: the
      // conversation and a live composer stay (a send wakes the box).
      return screen('stopped-dormant');
    }
  }
  if (!notice && input.runtimeIdentityUnavailable && !input.previousRepositoryHistoryAvailable) {
    const surface = screenOrNotice('runtime-lost');
    if (surface) return surface;
  }
  if (input.fatal && !input.showCachedTranscriptWhileDown) {
    return screen(input.autoResuming ? 'auto-resuming' : 'stopped');
  }
  return { screen: null, notice };
}
