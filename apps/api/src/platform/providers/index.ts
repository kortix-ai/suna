import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { LocalDockerProvider } from './local-docker';
import type { ProviderName, SandboxProvider } from './types';

/**
 * Sandbox provider lineup. Extensible registry — adding a new runtime is
 * a one-place change in `getProvider()` plus a value added to the
 * `ProviderName` union. Call sites depend on the `SandboxProvider`
 * interface, not the concrete class, so they stay untouched.
 *
 *   - daytona — managed cloud (Daytona)
 *   - local_docker — self-hosted/local Docker runtime
 */
export type {
  CreateSandboxOpts,
  ProviderName,
  ProvisioningStatus,
  ProvisioningTraits,
  ProvisionResult,
  ResolvedEndpoint,
  SandboxProvider,
  SandboxStatus,
} from './types';

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
    case 'local_docker':
      if (!config.DOCKER_HOST) {
        throw new Error('Local Docker provider requires DOCKER_HOST to be set.');
      }
      provider = new LocalDockerProvider();
      break;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown sandbox provider: ${exhaustive}`);
    }
  }

  providers.set(name, provider);
  return provider;
}
