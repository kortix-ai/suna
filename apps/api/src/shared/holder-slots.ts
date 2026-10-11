/**
 * A counting semaphore whose waiters give up after a deadline.
 *
 * Caps the lock transactions one process holds at a time. A lock transaction
 * pins one pooled connection for its whole body, and the body issues its own
 * queries on OTHER pooled connections. When the holders reach the pool size,
 * every body waits for a connection that only another waiting body can free,
 * and every query in the process stalls. Keep the holders of every such lock
 * together below the smallest pool (`DB_POOL_MAX`).
 */
export function createHolderSlots(max: number, timeoutError: (timeoutMs: number) => Error) {
  let held = 0;
  const waiters: Array<() => void> = [];
  return {
    get held() {
      return held;
    },
    async acquire(timeoutMs: number): Promise<void> {
      if (held < max) {
        held += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer);
          held += 1;
          resolve();
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(grant);
          if (index >= 0) waiters.splice(index, 1);
          reject(timeoutError(timeoutMs));
        }, timeoutMs);
        waiters.push(grant);
      });
    },
    release(): void {
      held -= 1;
      const next = waiters.shift();
      if (next) next();
    },
  };
}
