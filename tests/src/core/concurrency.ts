export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const requestedWorkers = Number.isFinite(concurrency)
    ? Math.max(1, Math.trunc(concurrency))
    : 1;
  const workerCount = Math.min(requestedWorkers, items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
