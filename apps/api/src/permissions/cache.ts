import type { Database } from '@kortix/db';

import { listOverrides, type MemberScopeOverrides } from './overrides';

interface Entry {
  value: MemberScopeOverrides;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, Entry>();

function key(sandboxId: string, userId: string): string {
  return `${sandboxId}:${userId}`;
}

export async function getOverridesCached(
  db: Database,
  sandboxId: string,
  userId: string,
): Promise<MemberScopeOverrides> {
  const k = key(sandboxId, userId);
  const cached = cache.get(k);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const fresh = await listOverrides(db, sandboxId, userId);
  cache.set(k, { value: fresh, expiresAt: Date.now() + TTL_MS });
  return fresh;
}

export function invalidateOverrides(sandboxId: string, userId: string): void {
  cache.delete(key(sandboxId, userId));
}

export function invalidateSandboxOverrides(sandboxId: string): void {
  const prefix = `${sandboxId}:`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

export function invalidateUserOverrides(userId: string): void {
  const suffix = `:${userId}`;
  for (const k of cache.keys()) {
    if (k.endsWith(suffix)) cache.delete(k);
  }
}

export function clearOverrideCache(): void {
  cache.clear();
}
