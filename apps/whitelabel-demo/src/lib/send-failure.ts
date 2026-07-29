import type { KortixSendError } from '@kortix/sdk/react';

/**
 * A short, human title for a failed send.
 *
 * `useSession` surfaces a typed `sendError`, but the demo never read it — so a
 * rejected send was completely silent: the optimistic bubble vanished, the
 * typed text was gone, and nothing said why. For a wrapper's end-user that is
 * indistinguishable from the product being broken.
 *
 * The message itself is already formatted for display by the SDK; this only
 * adds the one-line "what kind of problem is this", because the three kinds
 * need different reactions from the user.
 */
export function sendFailureTitle(error: KortixSendError): string {
  switch (error.kind) {
    case 'billing':
      // Not retryable by the end-user — the operator has to act.
      return 'This session is out of credit';
    case 'runtime-not-ready':
      // Transient and self-healing; retrying is genuinely the right move.
      return 'The runtime is still starting';
    case 'runtime-error':
      return error.gateway?.provider
        ? `The ${error.gateway.provider} model failed`
        : 'The agent could not run that';
    default:
      return 'Your message was not sent';
  }
}
