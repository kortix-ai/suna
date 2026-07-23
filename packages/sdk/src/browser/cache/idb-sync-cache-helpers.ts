export function selectCacheKeysToPrune(
  entries: Array<{ cacheKey: string; updatedAt: number }>,
  maximumEntries: number,
): string[] {
  return [...entries]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(maximumEntries)
    .map((entry) => entry.cacheKey);
}
