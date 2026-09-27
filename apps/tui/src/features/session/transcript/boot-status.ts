/**
 * What the session is doing while it is NOT ready, in words a person can act
 * on. The turn readout ("idle" / "working · 12s") is about the agent's turn,
 * and it is meaningless while the sandbox is still booting: a user who opens a
 * session and reads "idle" under a bare stage string concludes nothing is
 * happening, when `/start` fired the moment the session opened
 * (`packages/sdk/src/react/use-session.ts`, `startEnabled`).
 *
 * The labels are the web app's (`session-starting-loader.tsx`, `STEPS`), so
 * both products narrate the same boot the same way. Pure so every branch is
 * asserted without a renderer or a clock.
 */

/** The SDK's raw `/start` stage plus the two the hook derives. */
export type BootStage = 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';

export interface BootInput {
  /** `session.phase`. */
  phase: 'starting' | 'ready' | 'error';
  /** `session.stage`. */
  stage?: BootStage | string | null;
  /** `session.reason` — e.g. `runtime_wake_cooldown`. */
  reason?: string | null;
  /** `session.failure`, kept visible while a retry clock runs. */
  failure?: { evidence?: { attempts?: number; next_retry_at?: string | null } | null } | null;
  /** Milliseconds since the current stage was first seen. */
  msInStage: number;
  /** Milliseconds since the session opened. */
  msTotal: number;
  now: number;
}

export interface BootStatus {
  /** Present tense, no trailing punctuation. */
  label: string;
  /** A second line when the boot is not going to plan. */
  note: string | null;
}

/** `starting` splits into two labels after this long, as on the web. */
export const STARTING_SUBSTEP_MS = 5_000;
/** After this long the note says so; sandboxes occasionally wedge silently. */
export const SLOW_BOOT_MS = 45_000;

function bootLabel(stage: BootInput['stage'], msInStage: number): string {
  switch (stage) {
    case 'provisioning':
      return 'Reserving your computer';
    case 'starting':
      return msInStage >= STARTING_SUBSTEP_MS ? 'Waking the agent' : 'Loading your workspace';
    case 'stopped':
      return 'Waking your parked computer';
    case 'ready':
      return 'Connecting';
    default:
      return 'Starting';
  }
}

/** The retry note for a provider failure `/start` is waiting out. */
export function wakeCooldownNote(
  input: Pick<BootInput, 'reason' | 'failure' | 'now'>,
): string | null {
  if (input.reason !== 'runtime_wake_cooldown' || !input.failure) return null;
  const attempts = Math.max(1, input.failure.evidence?.attempts ?? 1);
  const nextAttempt = attempts + 1;
  const retryAt = Date.parse(input.failure.evidence?.next_retry_at ?? '');
  if (!Number.isFinite(retryAt)) {
    return `Computer did not start. Retrying automatically (attempt ${nextAttempt}).`;
  }
  const seconds = Math.max(0, Math.ceil((retryAt - input.now) / 1_000));
  if (seconds === 0) return `Computer did not start. Retrying now (attempt ${nextAttempt}).`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const duration = minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
  return `Computer did not start. Retrying in ${duration} (attempt ${nextAttempt}).`;
}

/**
 * The boot readout, or null once the session is ready or has failed — the
 * turn readout and the error banner own those two states.
 */
export function bootStatus(input: BootInput): BootStatus | null {
  if (input.phase !== 'starting') return null;
  const label = bootLabel(input.stage, input.msInStage);
  const cooldown = wakeCooldownNote(input);
  if (cooldown) return { label, note: cooldown };
  if (input.msTotal >= SLOW_BOOT_MS) {
    return {
      label,
      note: 'Taking longer than usual. The sandbox may be wedged; /new starts another.',
    };
  }
  return { label, note: null };
}
