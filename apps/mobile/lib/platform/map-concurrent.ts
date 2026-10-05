/**
 * Map `items` through async `fn` with at most `limit` calls in flight.
 *
 * Results keep the input order. Like `Promise.all`, the first rejection
 * rejects the whole call and no further items start; a caller that must keep
 * the other results catches inside `fn` per item.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const workers = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
