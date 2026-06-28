// Retry policy for sending a prompt to the sandbox's OpenCode server.
//
// Two failure shapes flow through here:
//   1. A thrown error (transport failure — the request never completed). No
//      HTTP status is available.
//   2. A resolved SDK response carrying `{ error, response }` (the SDK resolves
//      rather than rejects on HTTP errors). `response.status` is the status.
//
// A freshly-created session points at a sandbox that may still be booting. The
// proxy comes up before opencode's binary binds its port, so it answers with a
// `503 "opencode not ready"` for a few seconds. That is a boot signal, not a
// real failure — retrying across the full boot window lets the first prompt
// land instead of flashing an "opencode not ready" error banner the user can't
// act on.

/** Generic transient blips (server restart, tunnel hiccup): short, snappy. */
const TRANSIENT_BACKOFF_MS = [400, 1000, 2000];

/**
 * Boot/wake window — covers a sandbox binding its opencode port, whether that's
 * a cold first-session boot OR a wake from auto-stop (sandbox resume + opencode
 * rebind, which is slower). Stretched to ~30s so the prompt lands instead of the
 * client giving up and reverting a message that actually ran once the box woke.
 */
const BOOT_BACKOFF_MS = [400, 800, 1500, 2500, 4000, 4000, 4000, 4000, 4000, 4000];

/** Pull a human-readable message out of any error/response-error shape. */
export function extractSendErrorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const err = error as Record<string, any>;
    const root = err.data ?? err;
    const msg = root?.message || err.message || root?.error || err.error;
    if (typeof msg === 'string') return msg;
    try {
      return JSON.stringify(err);
    } catch {
      return '';
    }
  }
  return String(error);
}

/**
 * The sandbox proxy returns `503 "opencode not ready"` while opencode's binary
 * is still booting inside a freshly-created sandbox — or while a sandbox is
 * waking from auto-stop and rebinding its port. Match the common "not ready /
 * waking / booting / provisioning" shapes, not just the exact string.
 */
export function isOpenCodeNotReadyError(error: unknown): boolean {
  return /opencode not ready|not ready|not yet ready|waking|booting|still booting|provision/i.test(
    extractSendErrorMessage(error),
  );
}

/**
 * A status the server might recover from on its own: no status (thrown
 * transport error), any 5xx, or a 408/429 backpressure signal. A 4xx is a real
 * client error (bad request / auth / unknown model) and is never retried.
 */
export function isTransientSendStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

/**
 * Delay (ms) to wait before the next send attempt, or `null` when the send
 * should stop retrying and surface the error.
 *
 * @param attempt 1-based index of the attempt that just failed (1 = first send).
 *                The returned delay precedes attempt `attempt + 1`.
 */
export function getSendRetryDelayMs(
  attempt: number,
  status: number | undefined,
  error: unknown,
): number | null {
  // A 503 from our sandbox proxy ALWAYS means "sandbox/opencode not ready" — a
  // cold boot or a wake from auto-stop — so give it the full boot/wake window,
  // not the short transient one, even when the error body didn't carry a tidy
  // message. Giving up early here is exactly what reverted a prompt that then
  // landed once the box finished waking.
  const isBoot = status === 503 || isOpenCodeNotReadyError(error);
  const schedule = isBoot
    ? BOOT_BACKOFF_MS
    : isTransientSendStatus(status)
      ? TRANSIENT_BACKOFF_MS
      : null;
  if (!schedule) return null;
  if (attempt < 1 || attempt > schedule.length) return null;
  return schedule[attempt - 1];
}
