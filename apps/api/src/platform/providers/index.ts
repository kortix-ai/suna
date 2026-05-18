import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { LocalDockerProvider } from './local-docker';

/**
 * Sandbox provider lineup.
 *
 *   - daytona       — managed cloud (Daytona). Default for hosted deployments.
 *   - local_docker  — self-host. Spins the same image as cloud (apps/sandbox/
 *                     Dockerfile) as a local container, one per session.
 *
 * Reserved (not yet implemented):
 *   - docker_sbx    — Docker Inc.'s managed Sandboxes product
 *                     (https://docs.docker.com/ai/sandboxes/). Adding it here
 *                     in the future is a non-breaking widening of the union.
 */
export type ProviderName = 'daytona' | 'local_docker';
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
   * boots; falls back to the provider-wide default when absent (e.g.
   * for legacy sessions that pre-date per-project builds).
   */
  snapshot?: string;
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

  if (!config.ALLOWED_SANDBOX_PROVIDERS.includes(name)) {
    throw new Error(
      `Sandbox provider '${name}' is not allowed. ` +
      `Allowed: ${config.ALLOWED_SANDBOX_PROVIDERS.join(', ')}. ` +
      `Set ALLOWED_SANDBOX_PROVIDERS in your .env.`
    );
  }

  let provider: SandboxProvider;

  switch (name) {
    case 'daytona':
      if (!config.DAYTONA_API_KEY) {
        throw new Error('Daytona provider is allowed but not configured. Set DAYTONA_API_KEY.');
      }
      provider = new DaytonaProvider();
      break;
    case 'local_docker':
      provider = new LocalDockerProvider();
      break;
    default:
      throw new Error(`Unknown sandbox provider: ${name}`);
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
  return available;
}
