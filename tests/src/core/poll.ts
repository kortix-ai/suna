export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  read: () => Promise<T> | T,
  opts: {
    until: (value: T) => boolean;
    timeoutMs: number;
    intervalMs: number;
    description?: string;
    retryOnError?: (error: unknown) => boolean;
  },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last!: T;
  let lastRetryableError: unknown;

  while (true) {
    try {
      last = await read();
      lastRetryableError = undefined;
      if (opts.until(last)) return last;
    } catch (error) {
      if (!opts.retryOnError?.(error)) throw error;
      lastRetryableError = error;
    }
    if (Date.now() >= deadline) {
      const detail =
        lastRetryableError instanceof Error
          ? `; last retryable error: ${lastRetryableError.message}`
          : '';
      throw new Error(`Timed out waiting for ${opts.description ?? 'condition'}${detail}`);
    }
    await sleep(opts.intervalMs);
  }
}
