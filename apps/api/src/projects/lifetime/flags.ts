/**
 * BOUNDED SANDBOX LIFETIME — the rollout switches, and ONLY the rollout
 * switches.
 *
 * Deliberately a separate module from `constants.ts`, which is asserted in CI
 * to contain no `process.env` at all. The GRANTS must not be tunable in prod —
 * that is how 2026-06-24 happened, a one-line env-knob widening buried as item
 * 3 of an unrelated commit. WHETHER THE FEATURE ACTS is a different question,
 * and that one genuinely wants a switch an operator can throw at 3am.
 *
 * Every flag here defaults to the SAFE value, which for this change means "do
 * not act". This ships SHADOW ONLY: deadlines are written and logged, and
 * nothing kills or bills on them. Enforcement is a separate decision, taken
 * after the shadow counterfactual has a false-kill rate to show.
 */

function envFlag(name: string): boolean {
  return process.env[name] === 'true';
}

/**
 * THE KILL SWITCH, inverted: false means the expired-deadline sweep only LOGS
 * what it would have stopped. Default false at ship, and the flip is gated on
 * the twelve-item checklist in the design, not on this constant.
 */
export function sandboxDeadlineEnforcementEnabled(): boolean {
  return envFlag('KORTIX_SANDBOX_DEADLINE_ENFORCE');
}

/**
 * Whether boxes whose `progressChannel` is 'none' may be acted on at all. Kept
 * separate from the main switch because that bucket is precisely the one whose
 * emptiness (or genuine deadness) shadow mode has to establish first — a
 * bucket with no progress signal cannot distinguish "wedged" from "working
 * silently", and folding it into the main flag would hide that.
 */
export function sandboxDeadlineUnobservedEnforcementEnabled(): boolean {
  return envFlag('KORTIX_SANDBOX_DEADLINE_ENFORCE_UNOBSERVED');
}

/**
 * §2.1 W6 — require OBSERVED TURN INTENT before passive traffic may resurrect a
 * QUIESCED box. A real behaviour change (a passive call against a quiesced box
 * starts 503ing, and the user's next prompt resumes it), so it is off until the
 * kill path it protects is actually on. See shouldAutoResumeStoppedSandbox.
 */
export function sandboxDeadlineResumeGateEnabled(): boolean {
  return envFlag('KORTIX_SANDBOX_DEADLINE_RESUME_GATE');
}

/**
 * W4 — let a sandbox-reported turn end SHORTEN the deadline. Structurally
 * incapable of extending, so this is safe on its own; it has a flag purely so
 * it can be rolled back without touching anything else.
 */
export function sandboxDeadlineShortenOnTurnEndEnabled(): boolean {
  return envFlag('KORTIX_SANDBOX_DEADLINE_SHORTEN_ON_TURN_END');
}

/** W5 — PTY presence extends. Same rationale: independently revertible. */
export function sandboxDeadlinePtyPresenceEnabled(): boolean {
  return envFlag('KORTIX_SANDBOX_DEADLINE_PTY_PRESENCE');
}

/** How many boxes one shadow/kill pass may act on. Paces the initial drain. */
export function sandboxDeadlineKillBatch(): number {
  const raw = Number(process.env.KORTIX_SANDBOX_DEADLINE_KILL_BATCH);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25;
}

/**
 * Per-account cap per pass. `ORDER BY deadline_at ASC` alone, over a population
 * where ONE account holds 117 of 187 boxes with the oldest ages, drains that
 * account exhaustively before any other's — 117 sandboxes stopped inside ~25
 * minutes, which defeats the pacing entirely. Round-robin makes the drain prove
 * itself against a diverse population first.
 */
export function sandboxDeadlinePerAccountCap(): number {
  const raw = Number(process.env.KORTIX_SANDBOX_DEADLINE_PER_ACCOUNT_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}
