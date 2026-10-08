/**
 * Backend errors a client can branch on (`code`), and the mapping that keeps
 * provider internals out of API fields.
 */
import { logger } from '../lib/logger';
import { PlatinumHttpError } from '../shared/platinum';

export class BackendOperationError extends Error {
  constructor(message: string, readonly code: string, readonly status: 400 | 404 | 409 | 502 | 503 = 409) {
    super(message);
  }
}

/**
 * A provider failure as a short reason a user can act on. Platinum's raw
 * message carries its route, the machine id and up to 300 bytes of its body,
 * so it goes to the log only, never into an API field. Returns null for an
 * error that did not come from the provider.
 */
export function backendProviderFailure(error: unknown): BackendOperationError | null {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new BackendOperationError('The backend machine did not answer in time. Try again.', 'backend_provider_timeout', 503);
  }
  if (!(error instanceof PlatinumHttpError)) return null;
  const code = error.code ?? '';
  if (code === 'sandbox_not_running') {
    return new BackendOperationError('The backend machine is not running. Try again in a minute.', 'backend_not_running', 409);
  }
  if (error.status === 402 || ['insufficient_credits', 'organization_deleted', 'creation_disabled'].includes(code)) {
    // Kortix's provider account cannot run machines: no user can fix this.
    logger.error('[backends] provider account cannot run machines', { status: error.status, code });
    return new BackendOperationError(
      'Kortix cannot start backend machines right now. Kortix is alerted; try again later.',
      'backend_provider_unavailable',
      503,
    );
  }
  if (error.status === 429 || error.status === 503 || ['capacity', 'rate_limited', 'pool_exceeded'].includes(code)) {
    return new BackendOperationError(
      'No machine capacity is free right now. Try again in a few minutes.',
      'backend_provider_busy',
      503,
    );
  }
  if (error.status === 404) {
    return new BackendOperationError('The backend machine no longer exists.', 'backend_machine_missing', 409);
  }
  return new BackendOperationError('The backend provider refused the request. Try again.', 'backend_provider_error', 502);
}

/** The reason to store on the row or return: mapped when the provider failed, the message otherwise. */
export function backendFailureMessage(error: unknown): string {
  return backendProviderFailure(error)?.message ?? (error instanceof Error ? error.message : String(error));
}
