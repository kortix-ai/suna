import { config, KNOWN_PROVIDERS } from '../../config';
import type { ProviderName, SandboxProvider } from './contract';
import { DaytonaProvider } from './daytona';
import { PlatinumProvider } from './platinum';

export * from './contract';

const providers = new Map<ProviderName, SandboxProvider>();

/**
 * Narrows a stored provider string (the DB enum still holds `e2b`) to a live
 * provider name. A legacy `e2b` row returns false: E2B support is discontinued.
 */
export function isProviderName(name: string): name is ProviderName {
  return (KNOWN_PROVIDERS as readonly string[]).includes(name);
}

export function getProvider(name: ProviderName): SandboxProvider {
  const existing = providers.get(name);
  if (existing) return existing;

  let provider: SandboxProvider;

  switch (name) {
    case 'platinum':
      if (!config.PLATINUM_API_KEY) {
        throw new Error('Platinum provider requires PLATINUM_API_KEY to be set.');
      }
      provider = new PlatinumProvider();
      break;
    case 'daytona':
      // Legacy fallback provider: removal scheduled, kept for existing sessions.
      if (!config.DAYTONA_API_KEY) {
        throw new Error('Daytona (legacy fallback) provider requires DAYTONA_API_KEY to be set.');
      }
      provider = new DaytonaProvider();
      break;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown sandbox provider: ${exhaustive}`);
    }
  }

  providers.set(name, provider);
  return provider;
}

/**
 * Best-effort provider resolution for teardown paths. Returns null instead of
 * throwing when the provider cannot be constructed — its API key is unset
 * (the provider is disabled on this deployment) or the name is not a known
 * provider (a legacy runtime deployed on a provider this box has since retired,
 * such as a stored `e2b` row: E2B support is discontinued).
 *
 * Teardown code (App delete, stop, idle-reap, deploy supersede) must never fail
 * because a long-gone sandbox lived on a provider we can no longer reach: the
 * remote box is unreachable regardless, so the caller skips the remote call and
 * still completes the local state change (soft-delete, mark stopped, pause the
 * compute session). A live request path that genuinely needs the provider keeps
 * calling getProvider() and still gets the hard error.
 */
export function tryGetProvider(name: string): SandboxProvider | null {
  try {
    return getProvider(name as ProviderName);
  } catch {
    return null;
  }
}
