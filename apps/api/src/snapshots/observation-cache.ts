export interface InvalidatableObservation<T> {
  (): Promise<T>;
  /** Drop cached/in-flight observations after a provider-side mutation. */
  invalidate(): void;
}

/**
 * Collapse concurrent provider catalog reads and briefly reuse a confirmed
 * result. `ttlMs` may be a function of the observed value so callers can hold
 * a confirmed-positive result longer than a transient/negative one.
 */
export function shortLivedObservation<T>(
  observe: () => Promise<T>,
  ttlMs: number | ((value: T) => number) = 2_000,
  shouldCache: (value: T) => boolean = () => true,
): InvalidatableObservation<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let generation = 0;
  let inflight: { generation: number; promise: Promise<T> } | null = null;

  const observation = async (): Promise<T> => {
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    if (inflight?.generation === generation) return inflight.promise;

    const observationGeneration = generation;
    const promise = observe()
      .then((value) => {
        const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
        if (generation === observationGeneration && ttl > 0 && shouldCache(value)) {
          cached = { value, expiresAt: Date.now() + ttl };
        }
        return value;
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { generation: observationGeneration, promise };
    return promise;
  };

  observation.invalidate = () => {
    generation += 1;
    cached = null;
    inflight = null;
  };
  return observation;
}
