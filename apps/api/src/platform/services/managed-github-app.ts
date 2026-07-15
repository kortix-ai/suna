/**
 * DB-backed managed GitHub App configuration — the self-host in-app setup flow
 * (routes/github-app.ts) writes here instead of requiring an operator to edit
 * `.env` and restart the container.
 *
 * Stored in kortix.platform_settings under key `managed_github_app` (one row,
 * jsonb value) — mirrors runtime-settings.ts: a sync accessor backed by a
 * 30s-TTL cache that refreshes in the background, so hot paths (App-JWT
 * signing, git backend auth) never block on the DB. `updateManagedGithubAppConfig`
 * awaits a fresh read-modify-write + cache refresh so a write takes effect for
 * the writing process immediately; other processes pick it up within the TTL
 * (or immediately, via `refreshManagedGithubAppConfig()`, when a caller needs a
 * guaranteed-fresh read right after a write on another route — see
 * routes/github-app.ts's install-callback, which forces a refresh before
 * minting an app JWT with creds a *different* request may have just stored).
 *
 * A cold cache / DB hiccup / missing row resolves to `{}` — every consumer
 * (projects/github.ts, projects/git-backends/github.ts) then falls back to its
 * existing env-var read, so self-host installs that still configure everything
 * via `.env` keep working unchanged.
 */

export const MANAGED_GITHUB_APP_KEY = 'managed_github_app';

export interface ManagedGithubAppConfig {
  appId?: string;
  slug?: string;
  /** PEM, real newlines — jsonb has no trouble with them (unlike a .env value). */
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  /** HMAC key backing the install-state token (`buildGitHubAppInstallUrl` /
   *  `verifyGitHubAppInstallStatePayload` in projects/github.ts). Generated
   *  once at manifest-callback time, left alone afterwards. */
  stateSecret?: string;
  /** GitHub login (user or org) the App is installed on. */
  owner?: string;
  installationId?: string;
}

const TTL_MS = 30_000;

let cache: { config: ManagedGithubAppConfig; at: number } | null = null;
let inflight: Promise<void> | null = null;

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseConfig(value: unknown): ManagedGithubAppConfig {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  return {
    appId: coerceString(v.appId),
    slug: coerceString(v.slug),
    privateKey: coerceString(v.privateKey),
    clientId: coerceString(v.clientId),
    clientSecret: coerceString(v.clientSecret),
    webhookSecret: coerceString(v.webhookSecret),
    stateSecret: coerceString(v.stateSecret),
    owner: coerceString(v.owner),
    installationId: coerceString(v.installationId),
  };
}

/** Force a fresh DB read into the cache. Safe to call with no DB configured
 *  (resolves to `{}`, same as a DB hiccup) — callers always have the env
 *  fallback for that case. */
export async function refreshManagedGithubAppConfig(): Promise<void> {
  let config: ManagedGithubAppConfig = {};
  try {
    const { hasDatabase, db } = await import('../../shared/db');
    if (hasDatabase) {
      const { platformSettings } = await import('@kortix/db');
      const { eq } = await import('drizzle-orm');
      const [row] = await db
        .select({ value: platformSettings.value })
        .from(platformSettings)
        .where(eq(platformSettings.key, MANAGED_GITHUB_APP_KEY))
        .limit(1);
      config = parseConfig(row?.value);
    }
  } catch {
    /* DB hiccup -> empty config; consumers fall back to env */
  }
  cache = { config, at: Date.now() };
}

function ensureFresh(): void {
  if (cache && Date.now() - cache.at < TTL_MS) return;
  if (!inflight) inflight = refreshManagedGithubAppConfig().finally(() => { inflight = null; });
}

/** Sync accessor — the one every DB-first/env-fallback accessor in
 *  projects/github.ts and projects/git-backends/github.ts reads through. */
export function managedGithubAppConfig(): ManagedGithubAppConfig {
  ensureFresh();
  return cache?.config ?? {};
}

export function invalidateManagedGithubAppConfig(): void {
  cache = null;
}

/**
 * Read-modify-write against the single `managed_github_app` row: merges
 * `patch` over whatever's already stored (so manifest-callback setting App
 * creds doesn't clobber an `owner`/`installationId` a prior install already
 * recorded, and vice versa for install-callback). Awaits a cache refresh
 * before returning so the writing request's own next reads (e.g.
 * install-callback minting an App JWT right after manifest-callback stored
 * the key) see the new value immediately regardless of the 30s TTL.
 */
export async function updateManagedGithubAppConfig(
  patch: Partial<ManagedGithubAppConfig>,
): Promise<ManagedGithubAppConfig> {
  const { hasDatabase, db } = await import('../../shared/db');
  if (!hasDatabase) {
    throw new Error('Database not configured — cannot store the managed GitHub App config');
  }
  const { platformSettings } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');

  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, MANAGED_GITHUB_APP_KEY))
    .limit(1);
  const existing = parseConfig(row?.value);
  const next: ManagedGithubAppConfig = { ...existing, ...patch };

  await db
    .insert(platformSettings)
    .values({ key: MANAGED_GITHUB_APP_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: next, updatedAt: new Date() } });

  invalidateManagedGithubAppConfig();
  await refreshManagedGithubAppConfig();
  return next;
}
