import { config } from '../../config';

/**
 * DB-backed runtime toggles operators flip from the admin Providers panel —
 * NOT env vars. Stored in kortix.platform_settings (key -> jsonb value),
 * mirroring provider_distribution (provider-balancer.ts).
 *
 * Read through a SYNC accessor backed by a 30s-TTL cache that refreshes in the
 * background, so hot paths (warmPoolEnabled, warmSnapshotEnabled, provider
 * failover) never block on the DB. The admin PUT awaits refreshRuntimeSettings()
 * after writing, so a toggle takes effect immediately for the writing process;
 * other processes pick it up within the TTL.
 *
 * The admin DB row is the ONLY control surface for all three — NOT env vars.
 * warm_pool, provider_fallback AND warm_snapshot all default OFF and are opt-in
 * via the panel (the panel writes { enabled: true }). A cold cache / DB hiccup /
 * missing row resolves to OFF, so a fresh pod (e.g. right after a deploy) is
 * never warm on against the admin's setting before the first DB read completes —
 * boot awaits refreshRuntimeSettings() so the row is loaded before serving.
 * (Previously warm_snapshot hardcoded ON on the theory "a failed bake just
 * cold-clones"; the 2026-06-26 opencode wedge disproved it — a STALE warm seed
 * can hang a session — so off-until-explicitly-enabled is the safe direction.)
 */

export const WARM_POOL_KEY = 'warm_pool';
export const PROVIDER_FALLBACK_KEY = 'provider_fallback';
export const WARM_SNAPSHOT_KEY = 'warm_snapshot';

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
export interface WarmSnapshotSetting {
  /** Master gate for per-project warm-fork snapshots (the ~2s session start).
   *  ON by default — pure upside (a failed bake degrades to a cold clone). The
   *  per-provider sub-gates still apply: daytona also needs a warm target,
   *  platinum also needs a configured host (see shared/daytona warmSnapshots*). */
  enabled: boolean;
}

const TTL_MS = 30_000;
const MAX_WARM_SIZE = 25;

/** Fallback defaults used until the DB rows load and whenever the DB can't be
 *  read. ALL default OFF (fail-safe): warm_snapshot is now admin-OPT-IN — the
 *  admin Providers panel turns it on/off and that DB row is the ONLY control
 *  surface (no env knob). A cold cache / DB hiccup / no row therefore resolves to
 *  OFF, so a fresh pod (e.g. right after a deploy) never warm-forks against the
 *  admin's "off" — the 2026-06-26 stale-seed opencode wedge. The old "default ON,
 *  a failed bake just cold-clones" premise was wrong: a stale warm seed can hang. */
function envDefaults(): {
  warmPool: WarmPoolSetting;
  fallback: ProviderFallbackSetting;
  warmSnapshot: WarmSnapshotSetting;
} {
  return {
    warmPool: { enabled: config.KORTIX_WARM_POOL_ENABLED, size: Math.max(0, config.KORTIX_WARM_POOL_SIZE) },
    fallback: { enabled: false },
    warmSnapshot: { enabled: false },
  };
}

let cache: {
  warmPool: WarmPoolSetting;
  fallback: ProviderFallbackSetting;
  warmSnapshot: WarmSnapshotSetting;
  at: number;
} | null = null;
let inflight: Promise<void> | null = null;

export async function refreshRuntimeSettings(): Promise<void> {
  const def = envDefaults();
  let warmPool = def.warmPool;
  let fallback = def.fallback;
  let warmSnapshot = def.warmSnapshot;
  try {
    const { hasDatabase, db } = await import('../../shared/db');
    if (hasDatabase) {
      const { platformSettings } = await import('@kortix/db');
      const { inArray } = await import('drizzle-orm');
      const rows = await db
        .select({ key: platformSettings.key, value: platformSettings.value })
        .from(platformSettings)
        .where(inArray(platformSettings.key, [WARM_POOL_KEY, PROVIDER_FALLBACK_KEY, WARM_SNAPSHOT_KEY]));
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
        } else if (r.key === WARM_SNAPSHOT_KEY) {
          // The admin row is the ONLY control. With NO row warm-fork stays OFF
          // (envDefaults) — it is opt-in; the admin panel writes { enabled: true }.
          warmSnapshot = { enabled: v.enabled === true };
        }
      }
    }
  } catch {
    /* DB hiccup -> fail-safe defaults: warm_pool/fallback/warm_snapshot all OFF */
  }
  cache = { warmPool, fallback, warmSnapshot, at: Date.now() };
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

export function warmSnapshotSetting(): WarmSnapshotSetting {
  ensureFresh();
  return cache?.warmSnapshot ?? envDefaults().warmSnapshot;
}

export function invalidateRuntimeSettings(): void {
  cache = null;
}
