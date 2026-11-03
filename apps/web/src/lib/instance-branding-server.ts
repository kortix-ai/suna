import 'server-only';

import { type AccountBranding, getInstanceBranding } from '@kortix/sdk';

import { getServerPublicEnv } from '@/lib/public-env-server';
import { runtimeConfigIsBakedAtBuild } from '@/lib/runtime-config-mode';

/**
 * The instance branding (`GET /v1/access/branding`), read on the server so the
 * sign-in page renders the instance's logo and name in its first paint.
 *
 * Only a self-host instance with the enterprise license has one. Vercel hosts
 * the Kortix cloud, which never does, so a Vercel build makes no request.
 *
 * One read per 30 s per server process. A failed read keeps the last good
 * value, so a slow or restarting API costs at most one 1.5 s wait per 30 s and
 * never removes a logo that was showing.
 */
const TTL_MS = 30_000;
const TIMEOUT_MS = 1_500;

let cached: { at: number; value: AccountBranding | null } | null = null;

export async function readInstanceBranding(): Promise<AccountBranding | null> {
  if (runtimeConfigIsBakedAtBuild()) return null;
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const backendUrl = getServerPublicEnv().BACKEND_URL;
  if (!backendUrl) return null;
  let value = cached?.value ?? null;
  try {
    const body = await getInstanceBranding({
      backendUrl,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    value = body.branding ?? null;
  } catch {
    // Keep the last good value: default Kortix on a first failure.
  }
  cached = { at: now, value };
  return value;
}
