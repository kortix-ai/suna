/**
 * Polling helpers for async live resources (snapshot build, sandbox boot,
 * session status). On timeout we throw with the LAST SEEN state so
 * the report shows "stuck in provisioning for 600s", not a bare timeout.
 */

export interface PollOpts<T> {
  until: (value: T) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
}

export async function waitFor<T>(fn: () => Promise<T>, opts: PollOpts<T>): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = performance.now() + timeoutMs;
  let last: T | undefined;
  let lastErr: unknown;
  while (performance.now() < deadline) {
    try {
      last = await fn();
      if (opts.until(last)) return last;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  const desc = opts.description ?? "condition";
  const lastState = (() => {
    try {
      return JSON.stringify(last);
    } catch {
      return String(last);
    }
  })();
  const e = new Error(
    `Timed out after ${timeoutMs}ms waiting for ${desc}. Last seen: ${lastState}${
      lastErr ? ` (last error: ${(lastErr as Error)?.message ?? lastErr})` : ""
    }`,
  );
  // Provisioning/boot timeouts are infra-retryable, not assertion failures.
  (e as any).ke2eRetryable = true;
  throw e;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
