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
