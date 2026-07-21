export interface SessionChatMountInput {
  switched: boolean;
  fresh: boolean;
  shellSubmitted: boolean;
  chatReady: boolean;
}

/**
 * Decide whether the ACP chat subtree must stay mounted.
 *
 * Before first readiness, the runtime switch and fresh-session submit gates
 * still control the mount. After `AcpSessionChat` has reported ready,
 * `chatReady` is sticky for this route session: a recovery may temporarily
 * make `switched` false, but unmounting the chat then would leave the already
 * dismissed boot layer with nothing to render.
 */
export function shouldMountAcpChat(input: SessionChatMountInput): boolean {
  return input.chatReady || (input.switched && (!input.fresh || input.shellSubmitted));
}

export type SessionBootPhase = 'ready' | 'starting' | 'error';

/**
 * Decide whether the session-start boot chrome (`SessionStartingLoader` /
 * `SessionBootChecklistInline`, driven by `bootStage`) should stay mounted.
 *
 * Boot chrome is for BOOT only. It drops the instant the ACP session has
 * EVER been ready (`acpReady` is sticky-true on `useSession` — a later
 * mid-session failure is the chat surface's job to show, never a layout
 * regression back to "Kortix Session is starting"). It ALSO drops on a
 * TERMINAL pre-readiness error (`phase === 'error'`): without this, a
 * session whose ACP bootstrap fails or times out before ever reaching
 * ready (see `AcpSession.runBootstrap`'s bootstrap timeout in
 * `@kortix/sdk/acp`) would keep reporting whatever `SessionStartStage` the
 * backend's `/start` last returned — commonly still `'ready'`, since that
 * endpoint only reports on the SANDBOX/runtime process, not on whether the
 * client's own ACP handshake ever completed — leaving the boot loader
 * spinning on "Connecting" forever with nothing that ever flips it out of
 * boot mode. The page's `InlineSessionError` terminal-error branch is what
 * replaces the view once this returns `false` for that reason.
 */
export function shouldShowSessionBootLoader(input: {
  phase: SessionBootPhase;
  acpReady: boolean;
}): boolean {
  return input.phase !== 'ready' && input.phase !== 'error' && !input.acpReady;
}

/**
 * Decide whether the page's terminal "couldn't connect" card should replace
 * the boot loader / chat for a PRE-readiness ACP bootstrap failure (a
 * hung/rejected `initialize`/`session/new` handshake — see
 * `shouldShowSessionBootLoader`'s doc comment). Scoped to exclude `fatal`
 * (the sandbox-row-level 'error'/'stopped' terminal states, which already
 * have their own more specific cards with sandbox-provisioning detail and a
 * Restart action) so the two terminal branches never fight over the same
 * screen.
 */
export function shouldShowAcpBootstrapErrorCard(input: {
  isError: boolean;
  fatal: boolean;
}): boolean {
  return input.isError && !input.fatal;
}

/**
 * Wall-clock budget for the pre-ready boot chrome (whichever surface is
 * showing it right now — the instant shell's inline checklist, the
 * side-panel loader, or anything else keyed off `phase !== 'ready'`) before
 * the session is treated as having failed to connect, REGARDLESS of cause.
 *
 * This exists because `shouldShowAcpBootstrapErrorCard` above only fires
 * once `AcpSession.runBootstrap` reaches a terminal error — but that
 * requires the ACP handshake to have been ATTEMPTED at all. A server-side
 * wedge upstream of the handshake (e.g. `/start`'s orchestration never
 * resolving a usable model/provider for the session) can leave a session
 * with no ACP connect ever initiated, no bootstrap timeout ever armed, and
 * therefore no terminal signal ever produced — the exact "Connecting spins
 * forever, zero ACP traffic in the logs" failure mode. `AcpSession`'s own
 * 30s bootstrap timeout cannot help here; it never gets the chance to run.
 * This is a backstop of last resort, independent of the specific cause.
 */
export const SESSION_BOOT_TIMEOUT_MS = 90_000;

/**
 * Pure: has the pre-ready boot window been open longer than the budget, with
 * the session still neither ready nor already reporting its own terminal
 * error (which already has a more specific message via
 * `shouldShowAcpBootstrapErrorCard`)? `elapsedMs` is wall-clock time since
 * this session started booting — the caller resets its clock on every
 * session switch/retry.
 */
export function hasSessionBootTimedOut(input: {
  elapsedMs: number;
  ready: boolean;
  isError: boolean;
  budgetMs?: number;
}): boolean {
  if (input.ready || input.isError) return false;
  return input.elapsedMs >= (input.budgetMs ?? SESSION_BOOT_TIMEOUT_MS);
}
