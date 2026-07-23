/**
 * Pure decision core for the durable sandbox-provider migration workflow
 * (prepare → verify → activate). NO db / provider / config / env imports — every
 * input is passed in — so the concurrency, CAS, verification, and retry logic is
 * unit-testable in isolation and importable without booting the server. The
 * db-touching runner (provider-transition-runner.ts) and the resume worker
 * (provider-transition-worker.ts) call into these.
 */

export type ProviderTransitionStatus =
  | 'pending'
  | 'building'
  | 'ready'
  | 'activating'
  | 'activated'
  | 'failed'
  | 'superseded'
  | 'cancelled';

/** Statuses a resume worker may still drive (a live, non-terminal transition). */
export const LIVE_TRANSITION_STATUSES = [
  'pending',
  'building',
  'ready',
  'activating',
] as const satisfies readonly ProviderTransitionStatus[];

/** Statuses that never change again. */
export const TERMINAL_TRANSITION_STATUSES = [
  'activated',
  'failed',
  'superseded',
  'cancelled',
] as const satisfies readonly ProviderTransitionStatus[];

export function isLiveTransition(status: ProviderTransitionStatus): boolean {
  return (LIVE_TRANSITION_STATUSES as readonly string[]).includes(status);
}

export function isTerminalTransition(status: ProviderTransitionStatus): boolean {
  return (TERMINAL_TRANSITION_STATUSES as readonly string[]).includes(status);
}

/**
 * The resolved, buildable identity a transition prepares + verifies. Two
 * transitions with the same identity build the SAME image, so this is also the
 * dedup key (project + target + commit + base runtime).
 */
export interface PrepIdentity {
  projectId: string;
  targetProvider: string;
  /** Default-branch tip the image is baked at. */
  commitSha: string;
  /** Shared-default runtime fingerprint (the base snapshot name) on the target. */
  baseRuntimeIdentity: string;
  /** Resulting per-project ppwarm image name (perProjectWarmImageName). */
  snapshotName: string;
}

/**
 * Stable dedup key for a prep identity — repeated switch calls for the same
 * (project, target, commit, base runtime) must collapse onto ONE build. Mirrors
 * the DB's `uq_provider_transitions_live_identity` partial unique index, so the
 * in-process guard and the DB guard agree.
 */
export function transitionDedupKey(
  identity: Pick<PrepIdentity, 'projectId' | 'targetProvider' | 'commitSha' | 'baseRuntimeIdentity'>,
): string {
  return [
    identity.projectId,
    identity.targetProvider,
    identity.commitSha,
    identity.baseRuntimeIdentity,
  ].join('|');
}

/**
 * True iff the freshly-resolved identity still matches what a transition
 * prepared. A mismatch means a git push (commit) or a runtime/base-image bump
 * happened mid-build → the prepared image is STALE and must not be activated;
 * the new identity is built first. (Spec scenarios 6 + 7.)
 */
export function prepIdentityUnchanged(
  prepared: Pick<PrepIdentity, 'commitSha' | 'baseRuntimeIdentity'>,
  current: Pick<PrepIdentity, 'commitSha' | 'baseRuntimeIdentity'>,
): boolean {
  return (
    prepared.commitSha === current.commitSha &&
    prepared.baseRuntimeIdentity === current.baseRuntimeIdentity
  );
}

/**
 * Monotonic-generation CAS. Activation flips the project's active provider ONLY
 * when this transition's generation is STRICTLY GREATER than the generation the
 * project last recorded — so an older transition that settles late can never
 * overwrite a newer intent, and two workers activating different transitions
 * concurrently resolve deterministically (higher generation wins; the row lock
 * serializes them). (Spec scenarios 8 + 9.)
 */
export function canActivateGeneration(opts: {
  transitionGeneration: number;
  projectRecordedGeneration: number;
}): boolean {
  return opts.transitionGeneration > opts.projectRecordedGeneration;
}

/**
 * Whether an EXISTING live transition (older) is superseded by a NEW request.
 * A strictly-newer generation always supersedes; an equal generation is the
 * same request (idempotent), never a supersession.
 */
export function isSupersededByGeneration(
  existingGeneration: number,
  incomingGeneration: number,
): boolean {
  return incomingGeneration > existingGeneration;
}

/**
 * Interpret a provider snapshot state for readiness WITHOUT ever mistaking a
 * provider outage / auth failure for "image missing". `unknown` is
 * INDETERMINATE (retry — the provider couldn't answer), NOT `absent` (which
 * would wrongly trigger a rebuild or a false "not ready"). This is the crux of
 * spec scenario 10: an auth/provider error must not be read as a missing image.
 */
export type ImageReadiness = 'ready' | 'building' | 'absent' | 'failed' | 'indeterminate';

export function interpretImageReadiness(state: string): ImageReadiness {
  switch (state) {
    case 'active':
      return 'ready';
    case 'building':
      return 'building';
    case 'missing':
      return 'absent';
    case 'build_failed':
      return 'failed';
    case 'removing':
    case 'unknown':
    default:
      return 'indeterminate';
  }
}

/** The action the verify+activate step should take after re-reading the world. */
export type ActivationDecision = 'activate' | 'rebuild' | 'supersede' | 'wait' | 'cancelled';

/**
 * Final gate before flipping the active provider. Re-reads must ALL agree before
 * we activate:
 *   - the transition wasn't cancelled and a newer request hasn't superseded it,
 *   - the prepared commit is still the tip,
 *   - the base runtime identity is unchanged,
 *   - the prepared image is actually READY on the target provider.
 * Anything else routes to a safe non-activating action instead of shipping a
 * stale/missing image. Ordering matters: cancellation/supersession first
 * (intent changed — don't waste a rebuild), then identity drift (rebuild the
 * NEW identity), then readiness (wait / rebuild).
 */
export function decideActivation(opts: {
  cancelled: boolean;
  supersededByNewer: boolean;
  tipMatches: boolean;
  runtimeMatches: boolean;
  imageReadiness: ImageReadiness;
}): ActivationDecision {
  if (opts.cancelled) return 'cancelled';
  if (opts.supersededByNewer) return 'supersede';
  // A moved tip or a bumped base runtime means the prepared image is for a stale
  // identity — rebuild the CURRENT identity, never activate the old one.
  if (!opts.tipMatches || !opts.runtimeMatches) return 'rebuild';
  switch (opts.imageReadiness) {
    case 'ready':
      return 'activate';
    case 'absent':
    case 'failed':
      return 'rebuild';
    case 'building':
    case 'indeterminate':
      // Not ready yet, or the provider couldn't confirm — never activate on
      // uncertainty; wait for the next drive (backoff) to re-check.
      return 'wait';
  }
}

// ─── Failure classification + bounded backoff ────────────────────────────────

/**
 * Auth / authorization / invalid-build errors are PERMANENT — retrying them
 * forever just burns build capacity and never succeeds. These fail the
 * transition immediately (source provider stays active). Everything else is
 * treated as transient (see isTransientTransitionError) up to MAX_ATTEMPTS.
 */
export function isPermanentTransitionError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('unauthorized') ||
    m.includes('forbidden') ||
    m.includes('authentication') ||
    m.includes('authorization') ||
    m.includes('invalid credentials') ||
    m.includes('permission denied') ||
    m.includes('invalid build') ||
    m.includes('invalid dockerfile') ||
    m.includes('build failed') ||
    m.includes(' 401') ||
    m.includes(' 403') ||
    // A genuine 400 that is NOT rate-limiting is a bad request we can't fix by
    // retrying (429 is handled as transient below and never reaches here).
    m.includes(' 400')
  );
}

/**
 * Transient = worth a bounded, backed-off retry: network blips, timeouts, rate
 * limits (429), 5xx, staging/context disturbances (API restart mid-build), and
 * an INDETERMINATE provider state. Anything permanent (above) is excluded.
 */
export function isTransientTransitionError(err: unknown): boolean {
  if (isPermanentTransitionError(err)) return false;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('network') ||
    m.includes('gateway') ||
    m.includes('socket') ||
    m.includes(' 429') ||
    m.includes('too many requests') ||
    m.includes(' 502') ||
    m.includes(' 503') ||
    m.includes(' 504') ||
    m.includes('staging incomplete') ||
    m.includes('does not exist') ||
    m.includes('no such file') ||
    m.includes('s3 upload') ||
    m.includes('unknown') ||
    m.includes('indeterminate') ||
    // Default: an unclassified error is treated as transient so a single odd
    // failure gets a bounded retry rather than dead-lettering the transition —
    // MAX_TRANSITION_ATTEMPTS still caps the total work.
    true
  );
}

export const MAX_TRANSITION_ATTEMPTS = 6;

/**
 * Bounded exponential backoff (with a ceiling) for the NEXT retry after
 * `attempts` failures. Deterministic given inputs (no jitter) so it's testable;
 * the worker's own poll interval provides natural spread across replicas.
 */
export function transitionBackoffMs(
  attempts: number,
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? 5_000;
  const maxMs = opts.maxMs ?? 5 * 60_000;
  const exp = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, maxMs);
}

/**
 * Decide what a build/prep failure does to the transition:
 *   - permanent error → 'fail' now (never retry an auth/invalid-build error),
 *   - transient but attempts exhausted → 'fail' (dead-letter),
 *   - transient with attempts left → 'retry' after transitionBackoffMs.
 * The caller keeps the SOURCE provider active in every case.
 */
export function classifyTransitionFailure(opts: {
  err: unknown;
  attempts: number;
  maxAttempts?: number;
}): { action: 'retry' | 'fail'; permanent: boolean; nextDelayMs: number } {
  const maxAttempts = opts.maxAttempts ?? MAX_TRANSITION_ATTEMPTS;
  const permanent = isPermanentTransitionError(opts.err);
  if (permanent || opts.attempts >= maxAttempts) {
    return { action: 'fail', permanent, nextDelayMs: 0 };
  }
  return { action: 'retry', permanent: false, nextDelayMs: transitionBackoffMs(opts.attempts) };
}

// ─── Request-time resolution ─────────────────────────────────────────────────

/** Normalize a raw provider value from the switch request. '' / null → null. */
export function normalizeTargetProvider(raw: unknown): string | null {
  return raw === null || raw === undefined || raw === '' ? null : String(raw);
}

/** The next monotonic generation for a project, given the max already seen. */
export function nextGeneration(maxExistingGeneration: number | null | undefined): number {
  return (maxExistingGeneration ?? 0) + 1;
}

/**
 * Classify a switch request into immediate vs prepared. Only a NON-default,
 * not-currently-active target needs the prepare→verify→activate workflow (its
 * per-project warm image may not exist yet). Switching to null (clear), to the
 * platform-default provider (always has images), or to the already-active
 * provider is safe + immediate. Pure — the caller injects the resolved
 * effective/default providers. (Red-team #2: routing/pin only moves to the
 * target through the prepared path, never eagerly.)
 */
export type SwitchKind = 'immediate_clear' | 'immediate_set' | 'noop' | 'prepare';

export function classifyProviderSwitch(opts: {
  target: string | null;
  effectiveActive: string;
  platformDefault: string;
}): SwitchKind {
  if (opts.target === null) return 'immediate_clear';
  if (opts.target === opts.effectiveActive) return 'noop';
  if (opts.target === opts.platformDefault) return 'immediate_set';
  return 'prepare';
}

/** Human-facing preparation state label for the API/UI (spec: product states). */
export function preparationLabel(
  status: ProviderTransitionStatus,
  targetProvider: string,
  sourceProvider: string,
): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  switch (status) {
    case 'pending':
    case 'building':
      return `Preparing ${cap(targetProvider)}`;
    case 'ready':
    case 'activating':
      return `${cap(targetProvider)} image ready`;
    case 'activated':
      return `Switched to ${cap(targetProvider)}`;
    case 'failed':
      return `Preparation failed; remains on ${cap(sourceProvider)}`;
    case 'superseded':
      return `Superseded by a newer switch request`;
    case 'cancelled':
      return `Cancelled; remains on ${cap(sourceProvider)}`;
  }
}
