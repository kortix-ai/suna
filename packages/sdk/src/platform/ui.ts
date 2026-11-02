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
 * - `extra.projectId`: the session's project. The live stream and the turn-end
 *   hand-off (`react/turn-end-handoff.ts`) both set it when they know it. The
 *   page on screen may belong to another project, so the host must not take it
 *   from its current route.
 * - `extra.watchedSinceMs`: set only by the hand-off, for a session whose page
 *   was not mounted: when the watch started, on this host's clock. A host that
 *   also hears completions from elsewhere (another tab's stream) skips this one
 *   when it already announced the session after that instant.
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

/** `extra.projectId`: as for `notifyTaskComplete`. */
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

/** `extra.projectId`: as for `notifyTaskComplete`. */
export function notifyQuestion(
  sessionId: string,
  questionText: string,
  sessionTitle?: string,
  extra?: { projectId?: string },
): void {
  platformConfig().onNotify?.({
    kind: 'question',
    sessionId,
    questionText,
    sessionTitle,
    ...(extra?.projectId ? { projectId: extra.projectId } : {}),
  });
}

/** `extra.projectId`: as for `notifyTaskComplete`. */
export function notifyPermissionRequest(
  sessionId: string,
  toolName: string,
  sessionTitle?: string,
  extra?: { projectId?: string },
): void {
  platformConfig().onNotify?.({
    kind: 'permission',
    sessionId,
    toolName,
    sessionTitle,
    ...(extra?.projectId ? { projectId: extra.projectId } : {}),
  });
}
