/**
 * May a failed create be re-queued for another attempt?
 *
 * A create runs on one of two paths:
 *
 * - INLINE — the caller is waiting, and the failure is returned to them in the
 *   same HTTP response. They then decide what to do: the guide tells them a 429
 *   or 503 is worth retrying, so they retry, usually with a fresh
 *   Idempotency-Key.
 * - QUEUED — nobody is waiting. The queue drainer owns the outcome, and
 *   retrying transient infrastructure failures is the entire point.
 *
 * Re-queueing an INLINE failure means the same request runs twice: once as the
 * caller's retry, once as the drainer's. Two billed sandboxes for one intent,
 * with the same end_user_ref, both executing the baked initial_prompt. The
 * caller cannot detect it — their retry succeeded.
 *
 * So retryability is a property of WHO OWNS THE OUTCOME, not of the error.
 */
export function mayRequeueFailedCreate(input: {
  /** True when the failure is being returned to a waiting caller. */
  answeredSynchronously: boolean;
  /** Whether the underlying error is transient (429/5xx). */
  errorIsRetryable: boolean;
}): boolean {
  // Answering the caller transfers ownership of the retry to them. Keeping a
  // copy for ourselves is how one intent becomes two sandboxes.
  if (input.answeredSynchronously) return false;
  return input.errorIsRetryable;
}
