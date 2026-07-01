import { platformConfig } from './config';

/**
 * UI side-effect sink. The SDK fires these during event handling; the host wires
 * them to its real toast / OS-notification surfaces via `configureKortix`. No
 * UI components live in the SDK — these just forward to injected callbacks.
 */

export function infoToast(message: string, options?: unknown): void {
  platformConfig().onToast?.('info', message, options);
}

export function notifyTaskComplete(sessionId: string, sessionTitle?: string): void {
  platformConfig().onNotify?.({ kind: 'task-complete', sessionId, sessionTitle });
}

export function notifySessionError(
  sessionId: string,
  errorTitle: string,
  sessionTitle?: string,
): void {
  platformConfig().onNotify?.({ kind: 'session-error', sessionId, errorTitle, sessionTitle });
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
