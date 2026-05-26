import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { PlatinumProvider } from './platinum';
import { LocalDockerProvider } from './local-docker';

/**
 * Sandbox provider lineup. Extensible registry — adding a new runtime is
 * a one-place change in `getProvider()` plus a value added to the
 * `ProviderName` union. Call sites depend on the `SandboxProvider`
 * interface, not the concrete class, so they stay untouched.
 *
 *   - daytona      — managed cloud (Daytona).
 *   - platinum     — Cloud Hypervisor microVMs (api.platinum.dev). No
 *                    per-project snapshot system yet — every sandbox boots
 *                    from a shared template (default: `pt-base`).
 *   - local_docker — self-hosted/local Docker runtime.
 */
export type ProviderName = 'daytona' | 'platinum' | 'local_docker';
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
   * Declarative image spec. Currently only the Platinum provider consumes
   * this — when present, the provider sends `image: {...}` to Platinum's
   * `POST /v1/sandboxes`, which hashes the spec, cache-hits a prior build
   * or materializes a new template on-demand, then boots the sandbox in
   * the same call. Lets a project carry its own Dockerfile-as-code env
   * without an out-of-band build step. Ignored by Daytona today.
   */
  imageSpec?: ImageSpec;
}

export interface ImageSpec {
  base_image: string;
  steps?: Array<Record<string, unknown>>;
  entrypoint?: string;
  ready_cmd?: string;
  default_cpu?: number;
  default_ram_mb?: number;
  default_disk_gb?: number;
  size_mb?: number;
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
    case 'platinum':
      if (!config.PLATINUM_API_KEY || !config.PLATINUM_API_URL) {
        throw new Error('Platinum provider requires PLATINUM_API_KEY and PLATINUM_API_URL to be set.');
      }
      provider = new PlatinumProvider();
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

export function getDefaultProviderName(): ProviderName {
  return config.getDefaultProvider();
}

export function getAvailableProviders(): ProviderName[] {
  // Delegate to the per-provider credential probe — the same gate
  // getProvider() throws against. Keeps the list honest: a provider that
  // can't actually be instantiated never advertises itself.
  return (['daytona', 'platinum', 'local_docker'] as ProviderName[])
    .filter((p) => config.isProviderEnabled(p));
}
