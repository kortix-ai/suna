export const FIRST_MESSAGE_SEND_BACKOFF_MS: readonly number[] = [
  400, 800, 1500, 3000, 5000, 8000, 8000, 8000,
];

export function isTransientSendStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

export function sendMaxAttempts(backoff: readonly number[]): number {
  return backoff.length + 1;
}

export function shouldRetrySend(
  status: number | undefined,
  attempt: number,
  backoff: readonly number[],
): boolean {
  return isTransientSendStatus(status) && attempt < sendMaxAttempts(backoff);
}

export function sendRetryDelayMs(attempt: number, backoff: readonly number[]): number {
  return backoff[attempt - 1] ?? 0;
}
