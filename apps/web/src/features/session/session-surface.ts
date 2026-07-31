/**
 * What the session route paints, as one pure decision.
 *
 * The route used to decide this inline, from a pair of refs mutated DURING
 * RENDER (`lifecycleForRef` / `freshRef`) next to `setState` calls made in that
 * same render pass. Those two halves are not equally durable. Every client-side
 * navigation runs inside a transition, and React is free to throw a transition
 * render away and start over — a ref write survives that, a queued state update
 * does not. So the halves could disagree: `freshRef` saying "brand-new session"
 * while `shellSubmitted` was still false. And that pair DEADLOCKED —
 *
 *   the new-session shell suppressed mounting the chat
 *     → the chat was the only thing that could report readiness
 *       → readiness was the only thing that dismissed the shell
 *
 * — so an existing session with a full transcript painted the empty "give this
 * project something to work on" surface, and stayed there until a hard reload.
 * That is the bug this module exists to make unrepresentable. Two rules:
 *
 *  1. The new-session surface is DERIVED, never latched. Any evidence that this
 *     session already has a transcript revokes it, immediately.
 *  2. Nothing about that surface can permanently withhold the chat. The only
 *     thing gating the chat is whether there is a transcript pin to mount it on.
 *
 * The route feeds these from state it seeds once per session (it is keyed by
 * session id, so a switch remounts it) plus live data, and never from a ref it
 * edits mid-render.
 */

export interface SessionSurfaceInput {
  /**
   * This tab created this session, or arrived carrying its first prompt — i.e.
   * the local, optimistic "this is brand new" hint. Deliberately a hint: it
   * comes from in-memory/session-storage state that outlives the thing it
   * describes, so it is never trusted on its own.
   */
  newSessionHint: boolean;
  /** Any transcript content is known for this session (live runtime OR cache). */
  hasTranscript: boolean;
}

/**
 * Is this the brand-new-session surface (the instant shell) rather than a
 * session being resumed?
 *
 * `hasTranscript` is the veto, and it is the whole point: a stale hint can now
 * only ever cost a beat of the wrong overlay, never a dead end. The transcript
 * reaches the route from `useSession`'s own sync — which paints from the local
 * IndexedDB cache without waiting on a sandbox — so the veto lands even while
 * the box is still booting, and does not depend on the chat having mounted.
 */
export function isNewSessionSurface(input: SessionSurfaceInput): boolean {
  return input.newSessionHint && !input.hasTranscript;
}

export interface MountSessionChatInput extends SessionSurfaceInput {
  /** A transcript pin is known, so the chat has something to mount on. */
  contentAvailable: boolean;
  /** The user committed a first message on the instant shell. */
  submitted: boolean;
}

/**
 * May the real chat mount?
 *
 * A brand-new session holds it back until the user actually sends something —
 * the instant shell is the typing surface until then, and mounting a second
 * composer underneath it would fight for focus. That hold is safe ONLY because
 * {@link isNewSessionSurface} is revoked by transcript evidence: a session with
 * history is never "brand new", so it can never be held back.
 */
export function shouldMountSessionChat(input: MountSessionChatInput): boolean {
  if (!input.contentAvailable) return false;
  return !isNewSessionSurface(input) || input.submitted;
}

/** The pre-chat overlay: the typeable new-session shell, or the boot loader. */
export type SessionOverlay = 'new-session-shell' | 'boot-loader';

/**
 * Which overlay covers the chat while it cannot paint yet. The caller decides
 * WHETHER an overlay is up (it fades out on `chatReady`); this decides WHICH.
 *
 * `submittedOnShell` holds the shell in place once the user has typed into it:
 * their message is rendering there optimistically, and the moment it reaches the
 * transcript store `hasTranscript` would otherwise swap their own words out for
 * a boot spinner a beat before the chat crossfades in.
 */
export function resolveSessionOverlay(
  input: SessionSurfaceInput & { submittedOnShell: boolean },
): SessionOverlay {
  if (input.submittedOnShell) return 'new-session-shell';
  return isNewSessionSurface(input) ? 'new-session-shell' : 'boot-loader';
}

/**
 * Should the local "brand new session" hint be forgotten?
 *
 * The hint used to be dropped only once the chat reported ready — which never
 * happened on exactly the sessions where the hint was wrong, so a wrong hint was
 * self-preserving. Any of these means the hint has done its job (or was wrong):
 * the chat painted, the session turned out to have history, or the user sent
 * their first message.
 */
export function shouldForgetNewSessionHint(input: {
  chatReady: boolean;
  hasTranscript: boolean;
  submitted: boolean;
}): boolean {
  return input.chatReady || input.hasTranscript || input.submitted;
}
