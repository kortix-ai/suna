import { createHash } from 'node:crypto';
import type { ProviderName } from '../../platform/providers';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

const BOUNDARY_ARM_TTL_MS = 10 * 60_000;
const BOUNDARY_ARM_CACHE_MAX = 2_000;
export const PROMPT_BOUNDARY_ARM_WAIT_MS = 1_500;
type BoundaryArmRecord = { digest: string; armedAt: number; secretIds: string[] };
export const armedNetworkBoundaries = new Map<string, BoundaryArmRecord>();
const inFlightNetworkBoundaries = new Map<string, { digest: string; done: Promise<void> }>();

export function __resetNetworkBoundaryArmCacheForTests(): void {
  armedNetworkBoundaries.clear();
  inFlightNetworkBoundaries.clear();
}

function networkBoundaryDigest(providerName: ProviderName, bindings: NetworkBoundarySecretBinding[]): string {
  const material = bindings
    .map((binding) => JSON.stringify([
      binding.secretId,
      binding.alias,
      [...binding.hosts].map((host) => host.toLowerCase()).sort(),
      binding.header?.toLowerCase() ?? null,
    ]))
    .sort()
    .join('\n');
  return createHash('sha256').update(`${providerName}\n${material}`).digest('hex');
}

function rememberNetworkBoundaryArm(externalId: string, digest: string, secretIds: string[]): void {
  armedNetworkBoundaries.delete(externalId);
  if (armedNetworkBoundaries.size >= BOUNDARY_ARM_CACHE_MAX) {
    const cutoff = Date.now() - BOUNDARY_ARM_TTL_MS;
    for (const [key, record] of armedNetworkBoundaries) {
      if (record.armedAt <= cutoff) armedNetworkBoundaries.delete(key);
    }
    while (armedNetworkBoundaries.size >= BOUNDARY_ARM_CACHE_MAX) {
      const oldest = armedNetworkBoundaries.keys().next();
      if (oldest.done) break;
      armedNetworkBoundaries.delete(oldest.value);
    }
  }
  armedNetworkBoundaries.set(externalId, { digest, armedAt: Date.now(), secretIds: [...secretIds] });
}

function startNetworkBoundaryArm(externalId: string, bindings: NetworkBoundarySecretBinding[], digest: string): Promise<void> {
  const previous = inFlightNetworkBoundaries.get(externalId);
  if (previous?.digest === digest) return previous.done;
  const done = (previous?.done ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      try {
        rememberNetworkBoundaryArm(externalId, digest, bindings.map((binding) => binding.secretId));
      } finally {
        if (inFlightNetworkBoundaries.get(externalId)?.done === done) {
          inFlightNetworkBoundaries.delete(externalId);
        }
      }
    });
  inFlightNetworkBoundaries.set(externalId, { digest, done });
  return done;
}

export async function syncProviderNetworkBoundary(
  providerName: ProviderName,
  externalId: string,
  bindings: NetworkBoundarySecretBinding[],
  opts?: { maxWaitMs?: number },
): Promise<'skipped' | 'armed' | 'pending'> {
  if (bindings.length === 0) return 'skipped';
  const digest = networkBoundaryDigest(providerName, bindings);
  const armed = armedNetworkBoundaries.get(externalId);
  if (armed?.digest === digest && Date.now() - armed.armedAt < BOUNDARY_ARM_TTL_MS) {
    return 'skipped';
  }
  const attempt = startNetworkBoundaryArm(externalId, bindings, digest);
  const maxWaitMs = opts?.maxWaitMs;
  if (!maxWaitMs) {
    await attempt;
    return 'armed';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      attempt.then(() => 'armed' as const, (error: unknown) => ({ error })),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), maxWaitMs);
      }),
    ]);
    if (typeof outcome === 'object') throw outcome.error;
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
