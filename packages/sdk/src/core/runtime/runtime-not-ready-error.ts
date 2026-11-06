/**
 * Thrown when the active runtime's sandbox URL hasn't resolved yet (e.g. a
 * cloud sandbox is still provisioning). Distinct from a plain `Error` so
 * callers (`classifySendError` in `../react/use-session`) can classify this
 * specific "try again in a moment" condition with `instanceof` instead of
 * string-matching the message. The message text is unchanged for any
 * remaining string-match fallback.
 */
export class RuntimeNotReadyError extends Error {
  constructor(message = '[kortix-runtime] Server URL not ready — sandbox is still loading') {
    super(message);
    this.name = 'RuntimeNotReadyError';
  }
}
