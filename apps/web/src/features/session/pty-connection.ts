import { isSandboxNotReadyError } from '@kortix/sdk';

export type PtyCloseAction = 'ended' | 'reconnect' | 'replace';

/**
 * Why a terminal attach failed, answered by the HTTP path.
 *
 * A refused WebSocket upgrade reaches the browser as a bare `1006`: the `503
 * sandbox not ready` behind it is invisible. So after a failed attach the
 * terminal asks `GET /kortix/pty`, which passes the same control-plane gate and
 * returns a readable body. That GET never wakes a box.
 */
export type PtyAttachProbe = 'reachable' | 'not-ready' | 'unreachable';

/** `null` = the PTY list answered. Anything else is the error it threw. */
export function classifyPtyAttachProbe(error: unknown): PtyAttachProbe {
  if (error == null) return 'reachable';
  return isSandboxNotReadyError(error) ? 'not-ready' : 'unreachable';
}

/**
 * Should the terminal panel ask the session to start?
 *
 * The panel reaches the box through `GET /kortix/pty`, which by policy never
 * wakes a parked sandbox, and the `wake=1` attach in `PtyTerminal` mounts only
 * once a PTY exists. With no PTY yet, nothing in that chain can wake the box. A
 * visible panel is a person waiting for a shell, so it calls `/start` once per
 * waking episode.
 */
export function shouldRequestSessionWake(input: {
  /** PTY list or create answered with a sandbox readiness 503. */
  sandboxWaking: boolean;
  /** The panel is on screen. */
  visible: boolean;
  /** Both ids `/start` needs are known. */
  canStart: boolean;
  alreadyRequested: boolean;
}): boolean {
  return input.sandboxWaking && input.visible && input.canStart && !input.alreadyRequested;
}

/** Dial cadence while a wake is running. A readiness 503 costs one row read. */
export const PTY_WAKE_RETRY_MS = 2_000;
/** A Platinum wake measured ~60 s on dev and 16-31 s locally. */
export const PTY_WAKE_DEADLINE_MS = 3 * 60_000;
/** Consecutive non-wake failures before the terminal stops and offers Retry. */
export const PTY_MAX_ATTACH_FAILURES = 5;
const PTY_RECONNECT_BACKOFF_CAP_MS = 8_000;

export type PtyAttachPause = 'asleep' | 'failed';

export type PtyAttachStep =
  | { kind: 'retry'; delayMs: number; phase: 'waking' | 'reconnecting' }
  | { kind: 'pause'; reason: PtyAttachPause };

export function nextPtyAttachStep(input: {
  probe: PtyAttachProbe;
  /** The attach carries `wake=1`: the user opened the panel or pressed a control. */
  wakeArmed: boolean;
  /** Consecutive failed attaches, including this one. */
  failures: number;
  /** How long the box has reported not-ready while a wake was armed. */
  wakingForMs: number;
}): PtyAttachStep {
  if (input.wakeArmed && input.wakingForMs >= PTY_WAKE_DEADLINE_MS) {
    return { kind: 'pause', reason: 'failed' };
  }
  if (input.probe === 'not-ready') {
    // A parked box whose socket dropped on its own stays parked until a person
    // asks for it. Background retries must not resurrect it.
    if (!input.wakeArmed) return { kind: 'pause', reason: 'asleep' };
    return { kind: 'retry', delayMs: PTY_WAKE_RETRY_MS, phase: 'waking' };
  }
  if (input.failures > PTY_MAX_ATTACH_FAILURES) return { kind: 'pause', reason: 'failed' };
  return {
    kind: 'retry',
    delayMs: Math.min(1_000 * 2 ** (input.failures - 1), PTY_RECONNECT_BACKOFF_CAP_MS),
    phase: 'reconnecting',
  };
}

export type TerminalPanelState = 'connecting' | 'error' | 'empty' | 'terminal';

export function deriveTerminalPanelState(input: {
  hasServerUrl: boolean;
  serverWaitExpired: boolean;
  hasPty: boolean;
  isListLoading: boolean;
  isListError: boolean;
  isCreatePending: boolean;
  isCreateError: boolean;
  isEnsuring: boolean;
  /** The list/create failure is a sandbox readiness 503 (parked or booting
   *  box) — a pending state the panel must keep waiting through, never render
   *  as a terminal error. */
  isSandboxWaking?: boolean;
  /** A panel-local deadline elapsed while the runtime stayed pending. */
  connectionWaitExpired?: boolean;
}): TerminalPanelState {
  if (input.hasPty) return 'terminal';
  if (input.connectionWaitExpired) return 'error';
  if (!input.hasServerUrl) return input.serverWaitExpired ? 'error' : 'connecting';
  if (input.isListError || input.isCreateError) {
    return input.isSandboxWaking ? 'connecting' : 'error';
  }
  if (input.isListLoading || input.isCreatePending || input.isEnsuring) return 'connecting';
  return 'empty';
}

export function shouldExpirePtyConnect(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt >= timeoutMs;
}

export function classifyPtyClose(input: {
  code: number;
  reason: string;
  hadError: boolean;
}): PtyCloseAction {
  const reason = input.reason.trim().toLowerCase();

  // The daemon registry is intentionally process-local. A runtime restart, an
  // old persisted tab, or a create/attach race can leave the browser holding an
  // ID that can never succeed by reconnecting. The owner must mint a new PTY.
  if (reason.includes('pty not found')) return 'replace';

  // A clean shell exit is terminal. Everything that indicates transport loss
  // remains reconnectable even when an intermediary normalizes the code to
  // 1000 (the historical proxy behavior behind the user-visible failure).
  if (reason.includes('pty exited')) return 'ended';
  if (
    input.hadError ||
    reason.includes('idle timeout') ||
    reason.includes('upstream error') ||
    input.code !== 1000
  ) {
    return 'reconnect';
  }

  return 'ended';
}

/** Prevent a bad runtime from creating terminals forever in a replacement loop. */
export function shouldAutoReplaceTerminal(replacementAttempt: number): boolean {
  return replacementAttempt < 1;
}
