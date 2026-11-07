/**
 * What the session is doing while it is NOT ready, in words a person can act
 * on. The turn readout ("idle" / "working · 12s") is about the agent's turn,
 * and it is meaningless while the sandbox is still booting: a user who opens a
 * session and reads "idle" under a bare stage string concludes nothing is
 * happening, when `/start` fired the moment the session opened
 * (`packages/sdk/src/react/use-session.ts`, `startEnabled`).
 *
 * The labels are the boot steps the web app used to narrate before its wake
 * went silent. While the box provisions, `/start` also names the sandbox image
 * step (`boot.image`, read through `useSession(...).bootImage`): building the
 * first image can take minutes, and a bare "Reserving your computer" for that
 * long reads as a hang. The image phrases match the CLI's
 * (`apps/cli/src/session-boot.ts`). Pure so every branch is asserted without a
 * renderer or a clock.
 */

import type { SessionStartImageStep } from '@kortix/sdk';

/** The SDK's raw `/start` stage plus the two the hook derives. */
export type BootStage = 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';

export interface BootInput {
  /** `session.phase`. */
  phase: 'starting' | 'ready' | 'error';
  /** `session.stage`. */
  stage?: BootStage | string | null;
  /** `session.reason` — e.g. `runtime_wake_cooldown`. */
  reason?: string | null;
  /** `session.bootImage`: the sandbox image step while the box provisions. */
  image?: SessionStartImageStep | null;
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
  /**
   * True when `label` carries its own `m:ss` clock (an image step counts from
   * the server's `since`). The caller then adds no boot clock of its own.
   */
  timed: boolean;
}

/** `starting` splits into two labels after this long, as on the web. */
export const STARTING_SUBSTEP_MS = 5_000;
/** After this long the note says so; sandboxes occasionally wedge silently. */
export const SLOW_BOOT_MS = 45_000;

/** `SESSION_START_IMAGE_STATES`, in the CLI's words, sentence case. */
const IMAGE_STEP_TEXT: Record<SessionStartImageStep['state'], { text: string; note?: string }> = {
  resolving: { text: 'Choosing the image' },
  serving_last_ready: { text: 'Starting from the last ready image while the new one builds' },
  waiting_for_build: { text: 'Waiting for the first image for this workspace to finish building' },
  building: { text: 'Building the first image for this workspace' },
  copying_to_region: { text: "Copying the image to the session's region" },
  waiting_for_provider: { text: 'Waiting for the provider to finish the image', note: 'retrying' },
};

/** `0:42`, `12:05`, `1:02:03` — the CLI's image-step clock. */
export function formatStepElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * One image step as a label: `Building the first image for this workspace (0:42)`.
 * The clock counts from `step.since` to `now`. A state a newer API adds reads
 * humanized.
 */
export function imageStepLabel(step: SessionStartImageStep, now: number): string {
  const known = IMAGE_STEP_TEXT[step.state] as { text: string; note?: string } | undefined;
  const raw = String(step.state).replace(/_/g, ' ');
  const text = known?.text ?? raw.charAt(0).toUpperCase() + raw.slice(1);
  const since = Date.parse(step.since);
  const extras = [known?.note, Number.isFinite(since) ? formatStepElapsed(now - since) : undefined]
    .filter((part): part is string => Boolean(part));
  return extras.length > 0 ? `${text} (${extras.join(', ')})` : text;
}

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
  const image = input.stage === 'provisioning' ? (input.image ?? null) : null;
  const label = image ? imageStepLabel(image, input.now) : bootLabel(input.stage, input.msInStage);
  const timed = image !== null;
  const cooldown = wakeCooldownNote(input);
  if (cooldown) return { label, note: cooldown, timed };
  // A named image step is the server saying what the wait is: an image build
  // takes minutes, so the "may be wedged" note would be false there.
  if (!image && input.msTotal >= SLOW_BOOT_MS) {
    return {
      label,
      note: 'Taking longer than usual. The sandbox may be wedged; /new starts another.',
      timed,
    };
  }
  return { label, note: null, timed };
}
