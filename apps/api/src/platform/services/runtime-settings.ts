import { config } from '../../config';

/**
 * DB-backed runtime toggles operators flip from the admin Providers panel —
 * NOT env vars. Stored in kortix.platform_settings (key -> jsonb value),
 * mirroring provider_distribution (provider-balancer.ts).
 *
 * Read through a SYNC accessor backed by a 30s-TTL cache that refreshes in the
 * background, so hot paths (warmPoolEnabled, provider failover) never block on
 * the DB. The admin PUT awaits refreshRuntimeSettings() after writing, so a
 * toggle takes effect immediately for the writing process; other processes
 * pick it up within the TTL. Both settings DEFAULT OFF (fail-safe): a DB
 * hiccup, a missing row, or a cold cache all resolve to "off".
 */

export const WARM_POOL_KEY = 'warm_pool';
export const PROVIDER_FALLBACK_KEY = 'provider_fallback';

export interface WarmPoolSetting {
  /** Master gate. OFF = the warm pool subsystem is inert (no spares, every
   *  create cold-provisions). Per-template opt-in is AND-gated on this. */
  enabled: boolean;
  /** Default ready-count a template gets when first opted in (UI overrides). */
  size: number;
}
export interface ProviderFallbackSetting {
  /** When ON, a provider that fails to provision a session AT BIRTH hands off
   *  once to the next allowed provider before the session is marked failed. */
  enabled: boolean;
}

const TTL_MS = 30_000;
const MAX_WARM_SIZE = 25;

/** Env is only the FALLBACK default now (both ship OFF); the DB row is the real
 *  control surface, so operators never redeploy to toggle these. */
function envDefaults(): { warmPool: WarmPoolSetting; fallback: ProviderFallbackSetting } {
  return {
    warmPool: { enabled: config.KORTIX_WARM_POOL_ENABLED, size: Math.max(0, config.KORTIX_WARM_POOL_SIZE) },
    fallback: { enabled: false },
  };
}

let cache: { warmPool: WarmPoolSetting; fallback: ProviderFallbackSetting; at: number } | null = null;
let inflight: Promise<void> | null = null;

export async function refreshRuntimeSettings(): Promise<void> {
  const def = envDefaults();
  let warmPool = def.warmPool;
  let fallback = def.fallback;
  try {
    const { hasDatabase, db } = await import('../../shared/db');
    if (hasDatabase) {
      const { platformSettings } = await import('@kortix/db');
      const { inArray } = await import('drizzle-orm');
      const rows = await db
        .select({ key: platformSettings.key, value: platformSettings.value })
        .from(platformSettings)
        .where(inArray(platformSettings.key, [WARM_POOL_KEY, PROVIDER_FALLBACK_KEY]));
      for (const r of rows) {
        const v = r.value as Record<string, unknown> | null;
        if (!v || typeof v !== 'object') continue;
        if (r.key === WARM_POOL_KEY) {
          const size =
            typeof v.size === 'number' && Number.isInteger(v.size) && v.size >= 0
              ? Math.min(v.size, MAX_WARM_SIZE)
              : def.warmPool.size;
          warmPool = { enabled: v.enabled === true, size };
        } else if (r.key === PROVIDER_FALLBACK_KEY) {
          fallback = { enabled: v.enabled === true };
        }
      }
    }
  } catch {
    /* DB hiccup -> env defaults (fail-safe: both OFF) */
  }
  cache = { warmPool, fallback, at: Date.now() };
}

function ensureFresh(): void {
  if (cache && Date.now() - cache.at < TTL_MS) return;
  if (!inflight) inflight = refreshRuntimeSettings().finally(() => { inflight = null; });
}

export function warmPoolSetting(): WarmPoolSetting {
  ensureFresh();
  return cache?.warmPool ?? envDefaults().warmPool;
}

export function providerFallbackSetting(): ProviderFallbackSetting {
  ensureFresh();
  return cache?.fallback ?? envDefaults().fallback;
}

export function invalidateRuntimeSettings(): void {
  cache = null;
}
