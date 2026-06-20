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
  },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T;

  while (true) {
    last = await read();
    if (opts.until(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${opts.description ?? 'condition'}`);
    }
    await sleep(opts.intervalMs);
  }
}
