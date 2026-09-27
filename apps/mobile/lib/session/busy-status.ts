/**
 * The working row's words and clocks — pure, so every rule has a test.
 *
 * Ports of apps/web:
 * - `features/session/session-chat.tsx` — 2.5s status throttle, the 20s stall
 *   clock (`STATUS_STALL_AFTER_MS`), the retry countdown;
 * - `features/session/turn/status-elapsed.ts` — `statusElapsedFrame`;
 * - `features/session/session-busy-indicator.tsx` — the default label;
 * - `features/session/session-error-banner.tsx` — `GatewayMetaLine`,
 *   `GatewayAttemptFailureList`, `SessionRetryDisplay` copy.
 *
 * No React / React Native import.
 */
import { formatDuration, type GatewayAttemptFailure, type GatewayErrorDetails } from '@kortix/sdk';

/** A status change applies at most once per this window (web `2500`). */
export const STATUS_THROTTLE_MS = 2500;
/** After this long on one status the row shows the elapsed time (web `STATUS_STALL_AFTER_MS`). */
export const STATUS_STALL_AFTER_MS = 20_000;
/** The label before any status arrives (web `DEFAULT_STATUS`). */
export const BUSY_DEFAULT_STATUS = 'Thinking';
/** The label while a retry is scheduled (web `line3820JsxTextWaitingToRetry`). */
export const BUSY_RETRY_LABEL = 'Waiting to retry';

// ─── Elapsed clock ───────────────────────────────────────────────────────────

export interface StatusElapsedState {
  status: string;
  working: boolean;
  startedAtMs: number;
  elapsedMs: number;
}

export interface StatusElapsedInput {
  status: string;
  working: boolean;
  nowMs: number;
}

/** A new status or working flag restarts the clock; otherwise it advances. */
export function statusElapsedFrame(
  previous: StatusElapsedState | undefined,
  input: StatusElapsedInput,
): StatusElapsedState {
  if (!previous || previous.status !== input.status || previous.working !== input.working) {
    return { status: input.status, working: input.working, startedAtMs: input.nowMs, elapsedMs: 0 };
  }
  return {
    ...previous,
    elapsedMs: input.working ? Math.max(0, input.nowMs - previous.startedAtMs) : 0,
  };
}

// ─── Throttle ────────────────────────────────────────────────────────────────

export type StatusThrottleDecision = { type: 'keep' } | { type: 'apply' } | { type: 'defer'; delayMs: number };

/**
 * What to do with a fresh `getTurnStatus` value. An empty or unchanged status
 * keeps the label; a change inside the window waits for the rest of it.
 * `lastChangeAtMs` starts at mount, exactly as web's `lastStatusChangeRef`.
 */
export function statusThrottleDecision(input: {
  rawStatus: string;
  throttledStatus: string;
  lastChangeAtMs: number;
  nowMs: number;
  windowMs?: number;
}): StatusThrottleDecision {
  const windowMs = input.windowMs ?? STATUS_THROTTLE_MS;
  if (!input.rawStatus || input.rawStatus === input.throttledStatus) return { type: 'keep' };
  const elapsed = input.nowMs - input.lastChangeAtMs;
  if (elapsed >= windowMs) return { type: 'apply' };
  return { type: 'defer', delayMs: windowMs - elapsed };
}

/**
 * The phrase and the separate elapsed label. The phrase never carries the
 * time: folding a ticking value into it would change the roll-swap key every
 * second. Past the stall threshold the phrase drops its trailing ellipsis.
 */
export function busyStatusLabels(input: {
  throttledStatus: string;
  working: boolean;
  elapsedMs: number;
}): { phrase: string; elapsedLabel: string | undefined } {
  const stalled = Boolean(input.throttledStatus) && input.working && input.elapsedMs >= STATUS_STALL_AFTER_MS;
  return {
    phrase: stalled ? input.throttledStatus.replace(/(\.\.\.|…)$/, '') : input.throttledStatus,
    elapsedLabel: stalled ? formatDuration(input.elapsedMs) : undefined,
  };
}

// ─── Retry ───────────────────────────────────────────────────────────────────

/** Whole seconds until `nextMs`, rounded, never negative (web `Math.round`). */
export function retrySecondsLeft(nextMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nextMs - nowMs) / 1000));
}

export function retryTitle(secondsLeft: number): string {
  return secondsLeft > 0 ? `Retrying in ${secondsLeft}s` : 'Retrying now';
}

// ─── Gateway meta ────────────────────────────────────────────────────────────

export type GatewayMetaDetails = Pick<
  GatewayErrorDetails,
  'provider' | 'code' | 'suggestion' | 'requestId' | 'attemptFailures'
>;

/** `leading · provider · code · requestId`, present facts only. Empty → render nothing. */
export function gatewayMetaLine(leading: string | undefined, details: Partial<GatewayMetaDetails> | undefined): string {
  return [leading, details?.provider, details?.code, details?.requestId].filter(Boolean).join(' · ');
}

/** `provider/resolvedModel`, plus ` (route routeModel)` when the route resolved elsewhere. */
export function failureTarget(failure: GatewayAttemptFailure): string {
  const route = failure.resolvedModel !== failure.routeModel ? ` (route ${failure.routeModel})` : '';
  return `${failure.provider}/${failure.resolvedModel}${route}`;
}

/**
 * The text after the bold target in one failure row. Byte-identical to web's
 * JSX output, including the missing space after `HTTP 529 ·` (web renders
 * `{status}` and `{String(code)}` as adjacent expressions).
 */
export function failureLine(failure: GatewayAttemptFailure): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status} ·` : '';
  return ` · ${status}${String(failure.code)} · ${failure.message}`;
}

/** The collapsed failure list's summary (web `textce4c96225f63` = "1 attempt"). */
export function attemptFailuresSummary(count: number): string {
  return count === 1 ? '1 attempt' : `${count} attempts`;
}
