/**
 * Composer state while a session is still waking.
 *
 * The transcript paints from the local cache before the sandbox is up (see
 * `session-transcript-cache` in the SDK), which is the point — reading back what
 * you already wrote should never wait on a VM.
 *
 * ## Why this no longer disables the composer
 *
 * It used to return `{ disabled: true }`, and the reasoning was sound as far as
 * it went: `send()` only checks that an opencode session id exists, not that its
 * runtime answers, so a live composer against a sleeping box takes a prompt and
 * drops it. Disabling the input made that impossible.
 *
 * It also made the composer indistinguishable from broken. A stopped sandbox
 * (`503 sandbox not ready (status: stopped)`) is not a state that clears on its
 * own, so what the user got was a dead input, a spinner where the send button
 * belongs, and nothing on screen saying why or for how long. Waiting is only
 * tolerable when you can see what you are waiting for.
 *
 * The prompt-dropping problem is now solved where it actually lives — in the
 * SERVER's prompt inbox, not in the input. A submit against a sleeping box is
 * POSTed to `.../prompts` and becomes a durable row; the admission gate holds
 * it until the sandbox answers, at which point it goes out by itself. So the
 * message is safe — safe across a closed tab, which a browser queue never was
 * — the composer stays usable, and this module's job shrinks to one thing:
 * saying what is going on.
 */
export interface SessionComposerReadiness {
  /** The runtime is up. False means a submit becomes a queued inbox row rather
   *  than a delivery. */
  ready: boolean;
  /**
   * What to show above the composer while `ready` is false, or `null`.
   *
   * A notice rather than a placeholder. The placeholder was the old channel for
   * this, and it is the wrong one twice over: it is invisible the moment there
   * is any text in the input — exactly when someone is composing the thing that
   * is about to be queued — and it cannot say what happens next.
   */
  notice: string | null;
  /**
   * Whether the notice should offer a manual retry.
   *
   * `useRuntimeReconnect` (SDK) keeps probing forever in the background either
   * way — `POLL_UNREACHABLE` (5s) once it gives up on a fast boot — so this is
   * never "retry because polling stopped" (that was a real bug: an uncaught
   * throw from the auth/config lookup used to kill the poll loop outright; see
   * `use-runtime-reconnect.ts`). It is "tell the truth about which kind of wait
   * this is." A booting sandbox and a sandbox that has been declared
   * unreachable after `FAIL_THRESHOLD_*` consecutive failures produced the
   * SAME "Waking this session up…" copy forever, with no visible change, no
   * elapsed time, and nothing to do — which is indistinguishable from stuck
   * even when the retry loop underneath is perfectly healthy. The only escape
   * hatch anyone found was a hard refresh (which works purely by accident: it
   * remounts the poller and resets its failure count, same as pressing retry
   * would — and does NOT help a wedged box, since a fresh mount reconnects to
   * the exact same stuck sandbox and reproduces the same "booting" loop). A
   * third case — `stalled` — covers exactly that: reachable-but-never-healthy
   * long enough that `FAIL_THRESHOLD_*` was never going to fire on its own
   * (see `useRuntimeBootStalled`). Surfacing the real phase and a
   * `requestRuntimeReconnect()` button gives the user that same reset without
   * the reload, and gives it even when no reload would have worked either.
   */
  retryable: boolean;
}

/**
 * Whether the CONTROL PLANE is holding a turn open for this session right now —
 * `WorkingProjection.serverOpenTurnToken`, the freshest `GET .../turn` read.
 *
 * `state === 'working' && source === 'server'` is NOT this question, though it
 * reads like it. The projection also reports `source: 'server'` for a durable
 * inbox row with no turn behind it (`projectWorking`'s second branch), and that
 * is the state where nothing is running at all: the box may be parked and 18.9s
 * –24.5s of resume away. Reading `source` therefore suppressed the waking
 * notice in exactly the case it was written for.
 *
 * The TOKEN, not the projection's `turnId` / the turn's `message_id`: a turn
 * delivered without a wire `messageID` — every trigger, Slack/Teams/Telegram,
 * approval-resume and email delivery, and every `/` command — reports
 * `message_id: null` while it runs. See `WorkingProjection.serverOpenTurnToken`.
 */
export function serverHoldsOpenTurn(working: { serverOpenTurnToken: string | null }): boolean {
  return working.serverOpenTurnToken !== null;
}

/**
 * What the composer says when the control plane holds a turn the runtime has
 * stopped answering for.
 *
 * This state is real and it is not short. `box-reaper` clears an unobservable
 * turn record only once `deadlineAt` passes, and an accepted turn's deadline is
 * `turnGrantMs()` — `KORTIX_SANDBOX_TURN_GRANT_MINUTES`, 240 by default. So a
 * wedged daemon on a box the provider still reports as running keeps `GET
 * .../turn` answering "open" for up to four hours while every health probe
 * fails. Suppressing the waking notice with nothing in its place left that
 * session showing a Stop button, accepting sends the inbox admission gate
 * cannot drain, and saying nothing at all.
 *
 * Not "waking": nothing is booting. It names the fact (contact lost mid-turn)
 * and what a send does, for the same reason the waking notice does — the send
 * button stays live.
 */
const RUNTIME_UNREACHABLE_NOTICE =
  'Lost contact with this session’s runtime while a turn is still open. Messages you send stay queued until it answers.';

export function sessionComposerReadiness(input: {
  runtimeReady: boolean;
  /**
   * The CONTROL PLANE holds an open turn for this session right now — pass
   * `serverHoldsOpenTurn(working)`, never `working.source === 'server'`.
   *
   * That is proof the box was up when the read was taken, and it outranks a
   * health probe that has not answered YET: a turn the server is watching is
   * not a session that is waking. Without this, a slow probe (or one the proxy
   * blamed on the user's own dev server) painted "Waking this session up…" over
   * a session whose turn was streaming in front of the user.
   */
  serverTurnLive?: boolean;
  /** `useRuntimePhase() === 'unreachable'` — confirmed unreachable, not
   *  merely still connecting/booting. See `retryable` above. */
  unreachable?: boolean;
  /**
   * `useRuntimeBootStalled()` — reachable-but-not-healthy for longer than
   * `RUNTIME_BOOT_STALL_MS` with no ready flip, even though the probe layer
   * never declared `unreachable`. A sandbox proxy that keeps answering with a
   * 503 (OpenCode wedged mid-boot) resets the failure counter every tick, so
   * `unreachable` can never fire through that path alone — without this flag
   * that case shows "Waking…" forever with no escape hatch, the exact
   * "indistinguishable from stuck" failure this module exists to prevent.
   */
  stalled?: boolean;
}): SessionComposerReadiness {
  if (input.runtimeReady) return { ready: true, notice: null, retryable: false };
  if (input.serverTurnLive) {
    // `ready` deliberately stays false either way: the probe still has not
    // answered, so a submit is still an inbox row. Only the claim that we are
    // WAKING is dropped — and only replaced when the probe has actually failed.
    // A retry is offered exactly then: contact was lost, and the reconnect
    // button is the same reset a hard refresh performs by accident.
    return {
      ready: false,
      notice: input.unreachable ? RUNTIME_UNREACHABLE_NOTICE : null,
      retryable: !!input.unreachable,
    };
  }
  if (input.unreachable) {
    return {
      ready: false,
      notice:
        "Lost contact with this session's sandbox. Messages you send will be queued until it reconnects.",
      retryable: true,
    };
  }
  if (input.stalled) {
    return {
      ready: false,
      notice:
        'Still waking this session up — taking longer than usual. Messages you send will be queued.',
      retryable: true,
    };
  }
  return {
    ready: false,
    // Says what is happening AND what a send will do, because the send button
    // stays live — without the second half, pressing it looks like nothing
    // happened. True for an unreachable box with no open turn too: that box is
    // parked, and the first send resumes it.
    notice: 'Waking this session up… messages you send will be queued and go out automatically.',
    retryable: false,
  };
}
