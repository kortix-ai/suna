/**
 * Keep a viewer still when a refetch brings back the same file.
 *
 * The agent's turn end refetches every open file (the SDK invalidates the
 * workspace file caches). React Query's structural sharing already keeps a
 * text result's reference when the JSON is equal, but it cannot compare Blobs:
 * every binary refetch would hand back a new Blob, a new object URL, and a
 * reloaded viewer — a video restarting, a deck back on slide one — for a file
 * the agent never touched. Comparing the bytes costs one read of each, on a
 * file that is already in memory.
 */
export async function keepBlobIfUnchanged(cached: Blob | undefined, next: Blob): Promise<Blob> {
  if (!cached || cached.size !== next.size || cached.type !== next.type) return next;
  const [a, b] = await Promise.all([cached.arrayBuffer(), next.arrayBuffer()]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return next;
  }
  return cached;
}
