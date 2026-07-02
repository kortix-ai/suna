/**
 * DB-backed runtime toggles operators flip from the admin Providers panel —
 * NOT env vars. Stored in kortix.platform_settings (key -> jsonb value),
 * mirroring provider_distribution (provider-balancer.ts).
 *
 * Read through a SYNC accessor backed by a 30s-TTL cache that refreshes in the
 * background, so hot paths (provider failover) never block on the DB. The admin
 * PUT awaits refreshRuntimeSettings() after writing, so a toggle takes effect
 * immediately for the writing process; other processes pick it up within the TTL.
 *
 * The admin DB row is the ONLY control surface for these toggles — NOT env vars.
 * provider_fallback defaults OFF and is opt-in via the panel (the panel writes
 * { enabled: true }). A cold cache / DB hiccup / missing row resolves to OFF, so
 * a fresh pod (e.g. right after a deploy) is never on against the admin's setting
 * before the first DB read completes — boot awaits refreshRuntimeSettings() so
 * the row is loaded before serving.
 */

export const PROVIDER_FALLBACK_KEY = 'provider_fallback';

export interface ProviderFallbackSetting {
  /** When ON, a provider that fails to provision a session AT BIRTH hands off
   *  once to the next allowed provider before the session is marked failed. */
  enabled: boolean;
}

const TTL_MS = 30_000;

/** Fallback defaults used until the DB rows load and whenever the DB can't be
 *  read. Default OFF (fail-safe): the admin Providers panel turns provider
 *  failover on/off and that DB row is the ONLY control surface (no env knob). A
 *  cold cache / DB hiccup / no row therefore resolves to OFF. */
function envDefaults(): {
  fallback: ProviderFallbackSetting;
} {
  return {
    fallback: { enabled: false },
  };
}

let cache: {
  fallback: ProviderFallbackSetting;
  at: number;
} | null = null;
let inflight: Promise<void> | null = null;

export async function refreshRuntimeSettings(): Promise<void> {
  const def = envDefaults();
  let fallback = def.fallback;
  try {
    const { hasDatabase, db } = await import('../../shared/db');
    if (hasDatabase) {
      const { platformSettings } = await import('@kortix/db');
      const { inArray } = await import('drizzle-orm');
      const rows = await db
        .select({ key: platformSettings.key, value: platformSettings.value })
        .from(platformSettings)
        .where(inArray(platformSettings.key, [PROVIDER_FALLBACK_KEY]));
      for (const r of rows) {
        const v = r.value as Record<string, unknown> | null;
        if (!v || typeof v !== 'object') continue;
        if (r.key === PROVIDER_FALLBACK_KEY) {
          fallback = { enabled: v.enabled === true };
        }
      }
    }
  } catch {
    /* DB hiccup -> fail-safe defaults: fallback OFF */
  }
  cache = { fallback, at: Date.now() };
}

function ensureFresh(): void {
  if (cache && Date.now() - cache.at < TTL_MS) return;
  if (!inflight) inflight = refreshRuntimeSettings().finally(() => { inflight = null; });
}

export function providerFallbackSetting(): ProviderFallbackSetting {
  ensureFresh();
  return cache?.fallback ?? envDefaults().fallback;
}

export function invalidateRuntimeSettings(): void {
  cache = null;
}
