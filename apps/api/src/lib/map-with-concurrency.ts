/**
 * Map all items through a bounded worker pool.
 *
 * The output order matches the input order.
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

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}
