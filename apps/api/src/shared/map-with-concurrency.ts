/**
 * Map all items through a bounded worker pool.
 *
 * The output order matches the input order. The first rejection stops the pool
 * from taking new items, waits for the workers still running, then rejects. The
 * call never settles while one of its workers is still running, so a caller's
 * in-flight guard stays true for as long as work does.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  configuredConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(items.length, Math.floor(configuredConcurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | null = null;

  const runWorker = async () => {
    while (nextIndex < items.length && !failure) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
