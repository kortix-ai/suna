import { PLATINUM_PROVIDER } from '@kortix/llm-catalog';
import { logger } from '../../lib/logger';
import { fetchPlatinumModels, PlatinumModelsError, type ManagedModel } from './managed-models';
import { platinumGatewayModel } from './catalog-models';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type GatewayModel = ReturnType<typeof platinumGatewayModel>;

const TTL_MS = 5 * 60_000;
// replica-local: a per-key cache of Platinum's model list; each replica reads
// it at most once per TTL per key, so copies differ by at most TTL_MS.
const cache = new Map<string, { at: number; models: ManagedModel[] }>();

/**
 * Platinum's models for one BYOK key, cached for 5 min. A failed read keeps the
 * last good list; a rejected key (401/403) has no models.
 */
export async function platinumModelsForKey(apiKey: string, fetchImpl?: FetchLike, now = Date.now()): Promise<ManagedModel[]> {
  const hit = cache.get(apiKey);
  if (hit && now - hit.at < TTL_MS) return hit.models;
  try {
    const models = await fetchPlatinumModels(PLATINUM_PROVIDER.api!, apiKey, fetchImpl);
    cache.set(apiKey, { at: now, models });
    return models;
  } catch (err) {
    const rejected = err instanceof PlatinumModelsError && (err.status === 401 || err.status === 403);
    if (rejected) cache.delete(apiKey);
    logger.warn('[platinum-byok] /models failed', { status: err instanceof PlatinumModelsError ? err.status : null, kept: !rejected && !!hit });
    return rejected ? [] : hit?.models ?? [];
  }
}

export function __clearPlatinumByokCacheForTest(): void {
  cache.clear();
}

/** The models a Platinum key may call, as `platinum/<id>` catalog entries. */
export async function platinumByokCatalog(key: string | null): Promise<Record<string, GatewayModel>> {
  if (!key) return {};
  const out: Record<string, GatewayModel> = {};
  for (const m of await platinumModelsForKey(key)) {
    out[`${PLATINUM_PROVIDER.id}/${m.id}`] = platinumGatewayModel(m, PLATINUM_PROVIDER.id, PLATINUM_PROVIDER.name);
  }
  return out;
}
