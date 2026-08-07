import {
  isClientRequestTimeoutMessage,
  isServerDeadlineNoiseMessage,
} from '@/lib/browser-error-noise';

interface TimeoutErrorLike {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

/** Request deadlines are background transport state, not actionable toast content. */
export function isSilentTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as TimeoutErrorLike;
  if (candidate.code === 'TIMEOUT' || candidate.code === 'request_deadline') return true;
  return candidate.status === 503 && isServerDeadlineNoiseMessage(candidate.message);
}

/** Backstop for direct `errorToast(error.message)` call sites that lose the typed code. */
export function isSilentTimeoutMessage(message: unknown): boolean {
  return isClientRequestTimeoutMessage(message) || isServerDeadlineNoiseMessage(message);
}
