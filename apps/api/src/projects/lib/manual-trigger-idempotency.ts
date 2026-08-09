const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:+/=\-]{1,255}$/;

export function manualTriggerIdempotencyKey(
  projectId: string,
  triggerSlug: string,
  clientKey: string | undefined,
): string | undefined {
  if (clientKey === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(clientKey)) {
    throw new RangeError('Idempotency-Key must be 1-255 safe ASCII characters');
  }
  return `trigger:manual:${projectId}:${triggerSlug}:${clientKey}`;
}
