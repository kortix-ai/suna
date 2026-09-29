import { config } from '../../config';
import type { ProviderName, SandboxProvider } from './contract';
import { DaytonaProvider } from './daytona';
import { E2BProvider } from './e2b';
import { PlatinumProvider } from './platinum';

export * from './contract';

const providers = new Map<ProviderName, SandboxProvider>();

export function getProvider(name: ProviderName): SandboxProvider {
  const existing = providers.get(name);
  if (existing) return existing;

  let provider: SandboxProvider;

  switch (name) {
    case 'daytona':
      if (!config.DAYTONA_API_KEY) {
        throw new Error('Daytona provider requires DAYTONA_API_KEY to be set.');
      }
      provider = new DaytonaProvider();
      break;
    case 'platinum':
      if (!config.PLATINUM_API_KEY) {
        throw new Error('Platinum provider requires PLATINUM_API_KEY to be set.');
      }
      provider = new PlatinumProvider();
      break;
    case 'e2b':
      if (!config.E2B_API_KEY) {
        throw new Error('E2B provider requires E2B_API_KEY to be set.');
      }
      provider = new E2BProvider();
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
 * provider (a legacy runtime deployed on a provider this box has since retired).
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
