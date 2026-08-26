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
 * `shellShowsFirstPrompt` pins the shell down while it is painting the user's
 * own first message. Their prompt reaches the transcript store — flipping
 * `hasTranscript` — well before the chat has crossfaded in, and without this
 * pin the overlay swaps the bubble and its "Thinking" row for a boot spinner
 * for the whole of that window. That is not a beat: `shouldMountSessionChat`
 * unblocks on the same flag flip, so the spinner is up for as long as
 * `SessionChat` takes to mount and reach its first paint. It reads as the shell
 * vanishing and the session starting over.
 *
 * It is deliberately NOT `submitted`/`submittedOnShell`. This flag once meant
 * "typed into the shell", which is only ONE of the two ways a first prompt gets
 * here — and not the common one. Sending from the project home creates the
 * session, POSTs the prompt as a durable inbox row, navigates, and leaves the
 * text in `useFirstPromptPreviewStore` for the shell to draw. Same bubble on
 * screen, same need to be pinned, but the send happened on the previous page,
 * so the old flag was false for exactly the flow most sessions start with.
 *
 * The caller must not widen this to any evidence a prompt EXISTS. The
 * start-stash can outlive the hand-off it describes; the pin is for a first
 * prompt this shell is painting right now.
 */
export function resolveSessionOverlay(
  input: SessionSurfaceInput & { shellShowsFirstPrompt: boolean },
): SessionOverlay {
  if (input.shellShowsFirstPrompt) return 'new-session-shell';
  return isNewSessionSurface(input) ? 'new-session-shell' : 'boot-loader';
}

/**
 * How the boot state is PRESENTED once the overlay's identity is settled.
 *
 * The two are different questions and collapsing them is what produced the
 * complaint this exists for: opening a hibernated session showed a full-screen
 * "Connecting…" for the whole wake (5-240 s) with the transcript hidden behind
 * it — even though, with a server-side transcript mirror, the conversation is
 * available on the first frame.
 *
 * The rule: an overlay may cover the chat only while there is nothing under it
 * worth reading. The moment a transcript exists, boot status becomes a compact
 * banner ABOVE the conversation instead of a wall in front of it. Sending is
 * unaffected either way — the composer carries its own "waking, your message
 * will be queued" notice, and a prompt submitted during a wake becomes a
 * durable inbox row.
 *
 * `new-session-shell` is never demoted: it is a typing surface, not a status
 * screen, and there is by definition no transcript under it.
 */
export type SessionBootPresentation = 'full-screen' | 'banner';

export function resolveBootPresentation(input: {
  overlay: SessionOverlay;
  hasTranscript: boolean;
}): SessionBootPresentation {
  if (input.overlay !== 'boot-loader') return 'full-screen';
  return input.hasTranscript ? 'banner' : 'full-screen';
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
