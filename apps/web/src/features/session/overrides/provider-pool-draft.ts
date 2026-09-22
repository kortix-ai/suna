export type ProviderPoolDrafts = Record<string, string[] | null>;
type SavedPool = { provider_id: string; secret_ids: string[] };

/** An empty pool is never saved: the gateway fails every turn on one. Empty means default. */
export function normalizePoolSelection(selection: string[] | null): string[] | null {
  return selection && selection.length > 0 ? selection : null;
}

export function updateProviderPoolDraft(
  drafts: ProviderPoolDrafts,
  providerId: string,
  rawSelection: string[] | null,
  saved: SavedPool[],
): ProviderPoolDrafts {
  const selection = normalizePoolSelection(rawSelection);
  const next = { ...drafts };
  const previous = saved.find((pool) => pool.provider_id === providerId)?.secret_ids ?? null;
  if (JSON.stringify(previous) === JSON.stringify(selection)) delete next[providerId];
  else next[providerId] = selection;
  return next;
}

export function effectiveProviderPools(saved: SavedPool[], drafts: ProviderPoolDrafts): Record<string, string[]> {
  const selection = Object.fromEntries(saved.map((pool) => [pool.provider_id, pool.secret_ids]));
  for (const [provider, ids] of Object.entries(drafts)) {
    if (ids === null) delete selection[provider];
    else selection[provider] = ids;
  }
  return selection;
}
