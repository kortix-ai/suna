import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { LocalDockerProvider } from './local-docker';

/**
 * Sandbox provider lineup. Extensible registry — adding a new runtime is
 * a one-place change in `getProvider()` plus a value added to the
 * `ProviderName` union. Call sites depend on the `SandboxProvider`
 * interface, not the concrete class, so they stay untouched.
 *
 *   - daytona — managed cloud (Daytona)
 *   - local_docker — self-hosted/local Docker runtime
 */
export type ProviderName = 'daytona' | 'local_docker';

export interface CreateSandboxOpts {
  accountId: string;
  userId: string;
  name: string;
  envVars?: Record<string, string>;
  serverType?: string;
  location?: string;
  /**
   * Override the provider's default snapshot/image with one built
   * specifically for this project. The snapshot builder
   * (apps/api/src/snapshots/builder.ts) populates this when a session
   * boots; falls back to the provider-wide default when absent.
   */
  snapshot?: string;
  /**
   * Provider auto-stop idle timeout in minutes. Defaults to the provider's own
   * value (15). Pass 0 to disable auto-stop — used for warm-pool sandboxes,
   * which must stay running until claimed (our own idle sweep hibernates them
   * once claimed). See docs/specs/warm-pool.md.
   */
  autoStopInterval?: number;
}

export interface ProvisionResult {
  externalId: string;
  baseUrl: string;
  metadata: Record<string, unknown>;
}

export type SandboxStatus = 'running' | 'stopped' | 'removed' | 'unknown';

export interface ResolvedEndpoint {
  url: string;
  headers: Record<string, string>;
}

interface ProvisioningStage {
  id: string;
  progress: number;
  message: string;
}

export interface ProvisioningTraits {
  async: boolean;
  stages: ProvisioningStage[];
}

export interface ProvisioningStatus {
  stage: string;
  progress: number;
  message: string;
  complete: boolean;
  error: boolean;
  errorMessage?: string;
}

export interface SandboxProvider {
  readonly name: ProviderName;
  readonly provisioning: ProvisioningTraits;

  create(opts: CreateSandboxOpts): Promise<ProvisionResult>;
  start(externalId: string): Promise<void>;
  stop(externalId: string): Promise<void>;
  remove(externalId: string): Promise<void>;
  getStatus(externalId: string): Promise<SandboxStatus>;
  resolveEndpoint(externalId: string): Promise<ResolvedEndpoint>;
  ensureRunning(externalId: string): Promise<void>;
  getProvisioningStatus(sandboxId: string): Promise<ProvisioningStatus | null>;
}

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
