import { platformConfig } from '../core/http/config';

/**
 * UI side-effect sink. The SDK fires these during event handling; the host wires
 * them to its real toast / OS-notification surfaces via `configureKortix`. No
 * UI components live in the SDK — these just forward to injected callbacks.
 */

export function infoToast(message: string, options?: unknown): void {
  platformConfig().onToast?.('info', message, options);
}

/**
 * `extra` is set for a completion the turn-end hand-off found
 * (`react/turn-end-handoff.ts`) for a session whose page was not mounted:
 * - `watchedSinceMs`: when the watch started, on this host's clock. A host that
 *   also hears completions from elsewhere (another tab's stream) skips this one
 *   when it already announced the session after that instant.
 * - `projectId`: the session's project. The page on screen may belong to
 *   another project, so the host must not take it from its current route.
 * Absent: the live stream of the session page on screen.
 */
export function notifyTaskComplete(
  sessionId: string,
  sessionTitle?: string,
  extra?: { watchedSinceMs?: number; projectId?: string },
): void {
  platformConfig().onNotify?.({
    kind: 'task-complete',
    sessionId,
    sessionTitle,
    ...(extra?.watchedSinceMs !== undefined ? { watchedSinceMs: extra.watchedSinceMs } : {}),
    ...(extra?.projectId ? { projectId: extra.projectId } : {}),
  });
}

/** Whether the host wired a notification sink at all. */
export function hasNotifySink(): boolean {
  return typeof platformConfig().onNotify === 'function';
}

/** `extra.projectId`: as for `notifyTaskComplete`, set by the turn-end hand-off. */
export function notifySessionError(
  sessionId: string,
  errorTitle: string,
  sessionTitle?: string,
  extra?: { projectId?: string },
): void {
  platformConfig().onNotify?.({
    kind: 'session-error',
    sessionId,
    errorTitle,
    sessionTitle,
    ...(extra?.projectId ? { projectId: extra.projectId } : {}),
  });
}

export function notifyQuestion(
  sessionId: string,
  questionText: string,
  sessionTitle?: string,
): void {
  platformConfig().onNotify?.({ kind: 'question', sessionId, questionText, sessionTitle });
}

export function notifyPermissionRequest(
  sessionId: string,
  toolName: string,
  sessionTitle?: string,
): void {
  platformConfig().onNotify?.({ kind: 'permission', sessionId, toolName, sessionTitle });
}
