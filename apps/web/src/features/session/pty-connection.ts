export type PtyCloseAction = 'ended' | 'reconnect' | 'replace';

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
