import { config, type SandboxProviderName } from '../../config';

// Weighted load-balancing of NEW sandboxes across ALLOWED_SANDBOX_PROVIDERS.
// Weights live in kortix.platform_settings under 'provider_distribution' as
// { [provider]: weight } (e.g. { platinum: 70, daytona: 30 }). Unset, empty,
// or all-zero -> fall back to getDefaultProvider() (the first allowed provider),
// so behavior is unchanged until an admin configures a split. Single allowed
// provider -> no DB read.
export const PROVIDER_DISTRIBUTION_KEY = 'provider_distribution';

let cache: { weights: Record<string, number>; at: number } | null = null;
const TTL_MS = 30_000;

async function loadWeights(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.weights;
  let weights: Record<string, number> = {};
  try {
    const { hasDatabase, db } = await import('../../shared/db');
    if (hasDatabase) {
      const { platformSettings } = await import('@kortix/db');
      const { eq } = await import('drizzle-orm');
      const [row] = await db
        .select({ value: platformSettings.value })
        .from(platformSettings)
        .where(eq(platformSettings.key, PROVIDER_DISTRIBUTION_KEY))
        .limit(1);
      if (row?.value && typeof row.value === 'object') weights = row.value as Record<string, number>;
    }
  } catch {
    /* DB hiccup -> default provider */
  }
  cache = { weights, at: Date.now() };
  return weights;
}

export function invalidateProviderDistributionCache(): void {
  cache = null;
}

/**
 * Pick a provider for a NEW sandbox by configured weights, restricted to the
 * allowed set. No/zero weights -> getDefaultProvider(). Callers that need a
 * specific runtime pass an explicit provider and never call this.
 */
export async function selectProvider(): Promise<SandboxProviderName> {
  const allowed = config.ALLOWED_SANDBOX_PROVIDERS;
  if (allowed.length <= 1) return config.getDefaultProvider();
  const weights = await loadWeights();
  const entries = allowed.map((p) => [p, Math.max(0, Number(weights[p] ?? 0))] as const);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return config.getDefaultProvider();
  let r = Math.random() * total;
  for (const [p, w] of entries) {
    r -= w;
    if (r < 0) return p;
  }
  return config.getDefaultProvider();
}
