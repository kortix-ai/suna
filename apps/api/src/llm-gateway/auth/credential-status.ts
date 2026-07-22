/**
 * Bridges the capability-matrix's `HarnessAuthKind` (what `composer-
 * capabilities.ts`'s connection listing is keyed by) to the auth-provider
 * registry's `(id, door)` (what `resolveCredentialStatus` needs), plus a
 * short-TTL in-process memo so a POLLED read surface (the harness-connections
 * listing, the two-door `GET /auth-providers` route) cannot hammer upstream
 * liveness probes on every render — docs/specs/2026-07-22-unified-auth-
 * gateway.md §4/§8/§11#5.
 *
 * The memo is ephemeral and per-replica (NOT a `project_secrets` column — the
 * spec explicitly recommends against pre-emptive DB caching, §11#5). Losing it
 * on a restart just means one extra live probe. `credentials/api-key.ts`
 * already rate-limits its own probes (30s); this adds the same bound to the
 * Claude live probe (which has none of its own) and to the whole
 * `resolveCredentialStatus` call so the listing route stays cheap.
 */
import type { HarnessAuthKind } from '@kortix/shared/harnesses';
import { type AuthDoor, authProvidersForKind } from './registry';
import {
  type CredentialRecord,
  type ResolveCredentialStatusDeps,
  resolveCredentialStatus,
} from './resolve-credential-status';

export interface AuthProviderRef {
  providerId: string;
  door: AuthDoor;
}

/**
 * The canonical `(providerId, door)` a `HarnessAuthKind` resolves through.
 * Each connectable kind maps to exactly one registry entry today (verified in
 * `registry.test.ts`); `managed_gateway`/`native_config` have no entry (they
 * are not user-connected credentials) and correctly return `null`.
 */
export function authProviderRefForKind(kind: HarnessAuthKind): AuthProviderRef | null {
  const [entry] = authProvidersForKind(kind);
  if (!entry) return null;
  return { providerId: entry.id, door: entry.door };
}

const STATUS_TTL_MS = 30_000;

interface Cached {
  at: number;
  record: CredentialRecord;
}

const statusCache = new Map<string, Cached>();

function cacheKey(projectId: string, userId: string | null, providerId: string, door: AuthDoor) {
  return `${projectId}:${userId ?? ''}:${providerId}:${door}`;
}

/**
 * {@link resolveCredentialStatus} with a short per-(project, user, provider,
 * door) TTL memo. Use this from any read surface that can be polled; call the
 * uncached resolver directly only when a fresh, post-write status is required
 * (e.g. immediately after a connect completes).
 */
export async function resolveCredentialStatusCached(
  projectId: string,
  userId: string | null,
  providerId: string,
  door: AuthDoor,
  deps: ResolveCredentialStatusDeps = {},
): Promise<CredentialRecord> {
  const key = cacheKey(projectId, userId, providerId, door);
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.record;

  const record = await resolveCredentialStatus(projectId, userId, providerId, door, deps);
  statusCache.set(key, { at: Date.now(), record });
  return record;
}

/** Drop any memoized status for a connection — call after a connect/disconnect
 *  so the next read reflects the write immediately rather than up to a TTL late. */
export function invalidateCredentialStatus(
  projectId: string,
  userId: string | null,
  providerId: string,
  door: AuthDoor,
): void {
  statusCache.delete(cacheKey(projectId, userId, providerId, door));
}
