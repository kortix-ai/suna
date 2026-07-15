export interface InvalidatableObservation<T> {
  (): Promise<T>;
  /** Drop cached/in-flight observations after a provider-side mutation. */
  invalidate(): void;
}

/** Collapse concurrent provider catalog reads and briefly reuse a confirmed result. */
export function shortLivedObservation<T>(
  observe: () => Promise<T>,
  ttlMs = 2_000,
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
        if (generation === observationGeneration && shouldCache(value)) {
          cached = { value, expiresAt: Date.now() + ttlMs };
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
