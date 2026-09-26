/**
 * Process-local cache of GitHub App installation tokens.
 *
 * Why (2026-09-26): every git-backed read minted a fresh token with
 * `POST /app/installations/:id/access_tokens`. Measured on dev-api, that mint
 * is `http;dur=200–460` of every `/detail`, `/agents/:name/config`,
 * `/branches`, `/snapshots` and `/sandbox-templates` response, and
 * `/agents/:name/config` minted two. Opening one Customize page minted up to
 * four tokens for the same repository.
 *
 * GitHub issues installation tokens for 60 minutes. A cached token is reused
 * only while at least {@link MIN_REMAINING_MS} of its life remains, so:
 *   - a caller always receives a token valid for at least 45 minutes;
 *   - a revoked or uninstalled installation keeps a dead token for at most
 *     15 minutes (there is no GitHub webhook handler to evict on uninstall);
 *   - a permission change on the App reaches new tokens within 15 minutes.
 *
 * Failed mints are never cached: `resolveProjectGitAuth` turns a failure into
 * `installation_unusable`, and that signal must stay immediate.
 */

export interface CachedInstallationToken {
  token: string;
  expires_at: string;
}

/** A cached token is reused only while this much of its life remains. */
export const MIN_REMAINING_MS = 45 * 60_000;
/** Expired entries are swept once the map grows past this size. */
const SWEEP_THRESHOLD = 1_000;

interface Entry<T extends CachedInstallationToken> {
  installationId: string;
  expiresAtMs: number;
  value: T;
}

export function createInstallationTokenCache(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry<CachedInstallationToken>>();
  const inflight = new Map<string, Promise<CachedInstallationToken>>();

  function keyOf(appId: string, installationId: string, repositories: string[]): string {
    return `${appId}\u0000${installationId}\u0000${[...repositories].sort().join(',')}`;
  }

  function sweep() {
    if (entries.size < SWEEP_THRESHOLD) return;
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs - t < MIN_REMAINING_MS) entries.delete(key);
    }
  }

  return {
    async get<T extends CachedInstallationToken>(
      appId: string,
      installationId: string,
      repositories: string[],
      mint: (installationId: string, repositories: string[]) => Promise<T>,
    ): Promise<T> {
      const key = keyOf(appId, installationId, repositories);
      const hit = entries.get(key);
      if (hit && hit.expiresAtMs - now() >= MIN_REMAINING_MS) return hit.value as T;
      const pending = inflight.get(key);
      if (pending) return pending as Promise<T>;

      const request = mint(installationId, repositories)
        .then((value) => {
          const expiresAtMs = Date.parse(value.expires_at);
          if (Number.isFinite(expiresAtMs)) {
            sweep();
            entries.set(key, { installationId, expiresAtMs, value });
          }
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },

    /** Drop every cached token of one installation, whatever its repo scope. */
    invalidate(installationId: string) {
      for (const [key, entry] of entries) {
        if (entry.installationId === installationId) entries.delete(key);
      }
    },

    clear() {
      entries.clear();
    },
  };
}
