/**
 * ONE answer to "what is this session's runtime doing", for every surface that
 * draws it.
 *
 * ## Why this exists
 *
 * The frontend had four independent sources for that question — the control
 * plane's session row, a health probe, the runtime's SSE frames, and the
 * control plane's turn ledger — and every surface picked its own subset. The
 * composer's notice read the probe, the sidebar dot read the row, the Stop
 * button read the ledger and the stream. Each source has its own latency and
 * its own failure mode, so on a cold load they answer in an arbitrary order and
 * the surfaces disagree with each other and with the screen.
 *
 * Worse, the composer's notice treated the ABSENCE of an answer as an answer.
 * A page reload of a session whose sandbox is up and mid-turn showed "Waking
 * this session up…" for seconds before the runtime replied (screen recording,
 * essentia 2026-08-24) — a negative claim asserted from having asked nobody.
 *
 * ## The rule
 *
 * A negative claim needs positive evidence. `unknown` is a real state and it is
 * the honest one until something answers; nothing may render an alarm from it.
 *
 * Pure, so each rule below is a test rather than a habit.
 */
export type SessionConnection =
  /** Nothing has answered yet. Say nothing; this is a cold load, not a fault. */
  | 'unknown'
  /** The control plane says the sandbox is not up. THIS is when "waking" is true. */
  | 'waking'
  /** The sandbox is up and the runtime has not answered this tab yet. */
  | 'connecting'
  /** The runtime is answering — a health pass, or its own output arriving. */
  | 'live'
  /** Probed and failed past the threshold, or reachable-but-never-healthy. */
  | 'unreachable';

/** The control plane's statement about the sandbox behind this session. `null`
 *  when the session row has not loaded — which is NOT the same as "stopped". */
export type SandboxLifecycle =
  /** Every value `ProjectSessionStatus` can take, plus `null` for "the row has
   *  not loaded" — which is NOT the same as "stopped" and must never be read as
   *  one. `archived` is accepted for a caller reading a sandbox row rather than
   *  a session row. */
  | 'queued'
  | 'branching'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'archived'
  | 'failed'
  | 'completed'
  | null;

export interface SessionConnectionInputs {
  /** `project_sessions.status` — the control plane's view of the box. */
  sandbox: SandboxLifecycle;
  /** The health probe passed (`useRuntimeReady`). */
  runtimeReady: boolean;
  /** The probe has given up (`useRuntimePhase() === 'unreachable'`). */
  unreachable?: boolean;
  /** Reachable, but never healthy for longer than the boot-stall grace period. */
  stalled?: boolean;
  /** The runtime's OWN OUTPUT is arriving right now — see `WorkingActivityInput`.
   *  The strongest evidence there is: not a report about the runtime, the
   *  runtime itself. */
  activityFresh?: boolean;
}

export function projectSessionConnection(input: SessionConnectionInputs): SessionConnection {
  // Content outranks every probe, including one that has given up: a runtime
  // that is emitting parts is reachable by definition, whatever a health check
  // on a different path concluded.
  if (input.activityFresh) return 'live';
  if (input.runtimeReady) return 'live';
  if (input.unreachable || input.stalled) return 'unreachable';
  // Positive evidence, and the ONLY thing that earns the word "waking".
  if (input.sandbox === 'stopped' || input.sandbox === 'archived') return 'waking';
  if (
    input.sandbox === 'provisioning' ||
    input.sandbox === 'queued' ||
    input.sandbox === 'branching'
  ) {
    return 'waking';
  }
  // A finished session has no runtime to reach and nothing to wake. Nothing is
  // wrong with it, so nothing is announced.
  if (input.sandbox === 'completed') return 'unknown';
  if (input.sandbox === 'failed') return 'unreachable';
  // The box is up; we simply have not reached it yet. Not an alarm.
  if (input.sandbox === 'running') return 'connecting';
  // The row has not loaded. We know nothing, and we say nothing.
  return 'unknown';
}

/** Whether a surface may draw an alarm (a notice, a warning colour) from this
 *  state. `unknown` and `connecting` are waits, not faults. */
export function connectionIsFaulted(connection: SessionConnection): boolean {
  return connection === 'unreachable';
}

/**
 * Map the LIVE `kortix.control.runtime` frame's `sandbox_status`
 * (`session_sandboxes.status`) onto the `SandboxLifecycle` that
 * {@link projectSessionConnection} reads.
 *
 * This is the bridge that lets the connection state react to the STREAM instead
 * of a polled `project_sessions.status` row: the control channel pushes the
 * box's live status (and a `waking` flag while a resume is in flight), so a box
 * going down or coming up is reflected the instant the frame arrives, not at the
 * next poll. `waking === true` means a resume is DRIVING the box right now, so
 * it reads as `provisioning` (coming up) rather than a bare `stopped`. `null` /
 * an unknown value means "the frame said nothing usable" — the caller falls
 * back to the row, and `null` is NOT read as stopped (see `SandboxLifecycle`).
 */
export function sandboxStatusToLifecycle(
  status: string | null | undefined,
  waking?: boolean,
): SandboxLifecycle {
  if (waking === true) return 'provisioning';
  switch (status) {
    case 'active':
      return 'running';
    case 'provisioning':
      return 'provisioning';
    case 'stopped':
      return 'stopped';
    case 'archived':
      return 'archived';
    case 'error':
      return 'failed';
    default:
      return null;
  }
}
