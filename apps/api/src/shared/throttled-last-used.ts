const THROTTLE_MS = 15 * 60 * 1000;

/** Each repository gets its own cache; the writer owns its table and liveness predicate. */
export function createLastUsedTracker(write: (id: string) => Promise<unknown>) {
  const lastUsedCache = new Map<string, number>();

  return async (id: string): Promise<void> => {
    const now = Date.now();
    const last = lastUsedCache.get(id) || 0;
    if (now - last < THROTTLE_MS) return;
    lastUsedCache.set(id, now);
    if (lastUsedCache.size > 1000) {
      const cutoff = now - THROTTLE_MS * 2;
      for (const [key, time] of lastUsedCache) {
        if (time < cutoff) lastUsedCache.delete(key);
      }
    }
    try {
      await write(id);
    } catch (err) {
      console.warn('Failed to update last_used_at:', err);
    }
  };
}
