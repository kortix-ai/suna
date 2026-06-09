import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { LocalDockerProvider } from './local-docker';
import { PlatinumProvider } from './platinum';

/**
 * Sandbox provider lineup. Extensible registry — adding a new runtime is
 * a one-place change in `getProvider()` plus a value added to the
 * `ProviderName` union. Call sites depend on the `SandboxProvider`
 * interface, not the concrete class, so they stay untouched.
 *
 *   - daytona — managed cloud (Daytona)
 *   - local_docker — self-hosted/local Docker runtime
 */
export type ProviderName = 'daytona' | 'local_docker' | 'platinum';
export type { SandboxProviderName } from '../../config';

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
  /**
   * Daytona experimental warm-snapshot path. When set, the sandbox is created
   * from this memory-state warm base on the WARM target (~1.3s) and the session
   * daemon is started post-restore with `envVars` written to an env file — since
   * memory-restore freezes baked env and the entrypoint doesn't re-run. See
   * snapshots/warm-bake.ts. Daytona-only; other providers ignore it.
   */
  warmBaseSnapshot?: string;
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

export interface ProvisioningStage {
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
  /**
   * Resolve a reachable upstream URL for an arbitrary port — the data path the
   * `/v1/p/<externalId>/<port>` reverse proxy forwards to. Unlike resolveEndpoint
   * (fixed at the agent port), this takes any port so user preview apps work too.
   * EVERY provider must implement it: the proxy used to hardcode Daytona, which
   * silently broke every other provider's runtime connection (502/503). Keeping
   * it on the interface makes that regression a compile error.
   */
  resolvePreviewLink(externalId: string, port: number): Promise<{ url: string; token: string | null }>;
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
    case 'platinum':
      if (!config.PLATINUM_API_KEY) {
        throw new Error('Platinum provider requires PLATINUM_API_KEY to be set.');
      }
      provider = new PlatinumProvider();
      break;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown sandbox provider: ${exhaustive}`);
    }
  }

  providers.set(name, provider);
  return provider;
}

export function getDefaultProviderName(): ProviderName {
  return config.getDefaultProvider();
}

export function getAvailableProviders(): ProviderName[] {
  const available: ProviderName[] = [];
  if (config.isDaytonaEnabled()) available.push('daytona');
  if (config.isLocalDockerEnabled()) available.push('local_docker');
  if (config.isPlatinumEnabled()) available.push('platinum');
  return available;
}
