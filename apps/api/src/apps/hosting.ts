import { createHash, createHmac } from 'node:crypto';
import { config, type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import {
  effectiveAppMachine,
  getProvider,
  type ProvisionResult,
  type ResolvedSandboxIngress,
  type SandboxProvider,
} from '../platform/providers';
import {
  getSandboxProvider,
  type BuildLogTap,
  type SandboxProviderAdapter,
} from '../snapshots/providers';

export const APP_CONTROL_PORT = 7331;
export const APP_INGRESS_PORT = 8080;
const APP_PROVIDER_WAKE_TIMEOUT_MS = 30_000;
const APP_PROVIDER_WAKE_POLL_MS = 250;
const APPD_RESTART_INTERVAL_MS = 5_000;

export interface AppMachineSpec {
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
}

export interface BuildAppImageInput {
  provider: SandboxProviderName;
  snapshotName: string;
  slug: string;
  sourceDir?: string;
  dockerfile: string;
  runtimeSpec: Record<string, unknown>;
  machine: AppMachineSpec;
  logTap?: BuildLogTap;
}

export interface StartAppRuntimeInput {
  provider: SandboxProviderName;
  runtimeId: string;
  accountId: string;
  userId: string;
  name: string;
  snapshotName: string;
  machine: AppMachineSpec;
  envVars?: Record<string, string>;
}

export interface AppRuntimeHandle extends ProvisionResult {
  provider: SandboxProviderName;
  runtimeId: string;
  controlTokenHash: string;
}

export interface AppdStatus {
  status: string;
  ready: boolean;
  started_at?: string;
  restarts?: number;
  last_exit?: string;
}

interface HostingDependencies {
  snapshotProvider: (provider: SandboxProviderName) => SandboxProviderAdapter;
  runtimeProvider: (provider: SandboxProviderName) => SandboxProvider;
  fetch: typeof globalThis.fetch;
  controlSecret: string;
  sleep: (ms: number) => Promise<void>;
}

function defaultDependencies(): HostingDependencies {
  return {
    snapshotProvider: (provider) => getSandboxProvider(provider),
    runtimeProvider: (provider) => getProvider(provider),
    fetch: globalThis.fetch,
    controlSecret: config.API_KEY_SECRET,
    sleep: (ms) => Bun.sleep(ms),
  };
}

/**
 * The database stores only this hash. The API reconstructs the bearer from the
 * stable runtime id and a server secret after process restarts.
 */
export function appControlToken(runtimeId: string, secret: string): string {
  if (!runtimeId) throw new Error('runtimeId is required');
  if (secret.length < 16) throw new Error('App control secret must contain at least 16 characters');
  return createHmac('sha256', secret)
    .update('kortix-appd-control:v1\0')
    .update(runtimeId)
    .digest('base64url');
}

export function appControlTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AppHostingProvider {
  private readonly dependencies: HostingDependencies;

  constructor(dependencies: Partial<HostingDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  async buildImage(input: BuildAppImageInput): Promise<void> {
    await this.dependencies.snapshotProvider(input.provider).buildSnapshot(
      {
        snapshotName: input.snapshotName,
        userDockerfile: input.dockerfile,
        spec: {
          cpu: input.machine.cpuCores,
          memoryGb: input.machine.memoryGb,
          diskGb: input.machine.diskGb,
        },
        slug: input.slug,
        runtimeProfile: 'app',
        appContext: {
          sourceDir: input.sourceDir,
          runtimeSpec: input.runtimeSpec,
        },
      },
      input.logTap,
    );
  }

  async createRuntime(input: StartAppRuntimeInput): Promise<AppRuntimeHandle> {
    const token = appControlToken(input.runtimeId, this.dependencies.controlSecret);
    const provider = this.dependencies.runtimeProvider(input.provider);
    const result = await provider.create({
      accountId: input.accountId,
      userId: input.userId,
      name: input.name,
      snapshot: input.snapshotName,
      workloadType: 'app',
      resourceSpec: input.machine,
      publishedPorts: [APP_CONTROL_PORT, APP_INGRESS_PORT],
      envVars: { ...input.envVars, KORTIX_APPD_TOKEN: token },
    });
    try {
      await provider.ensureAppRuntimeStarted(result.externalId);
    } catch (error) {
      await provider.remove(result.externalId).catch(() => {});
      throw error;
    }
    return {
      ...result,
      provider: input.provider,
      runtimeId: input.runtimeId,
      controlTokenHash: appControlTokenHash(token),
    };
  }

  /**
   * The machine this provider will really allocate. Billing meters this, not
   * the requested specification — see effectiveAppMachine.
   */
  effectiveMachine(provider: SandboxProviderName, machine: AppMachineSpec): AppMachineSpec {
    return effectiveAppMachine(this.dependencies.runtimeProvider(provider), machine);
  }

  async start(provider: SandboxProviderName, externalId: string): Promise<void> {
    const runtimeProvider = this.dependencies.runtimeProvider(provider);
    try {
      await runtimeProvider.start(externalId);
    } catch (error) {
      // Concurrent cold requests can both observe the provider-stopped signal.
      // Treat an already-running provider as a successful idempotent start.
      const status = await runtimeProvider.getStatus(externalId).catch(() => 'unknown' as const);
      if (status !== 'running') throw error;
    }
    await this.waitForProviderRunning(runtimeProvider, externalId);
    await runtimeProvider.ensureAppRuntimeStarted(externalId);
  }

  async ensureRunning(provider: SandboxProviderName, externalId: string): Promise<void> {
    const runtimeProvider = this.dependencies.runtimeProvider(provider);
    await runtimeProvider.ensureRunning(externalId);
    await this.waitForProviderRunning(runtimeProvider, externalId);
    await runtimeProvider.ensureAppRuntimeStarted(externalId);
  }

  private async waitForProviderRunning(
    runtimeProvider: SandboxProvider,
    externalId: string,
  ): Promise<void> {
    const deadline = Date.now() + APP_PROVIDER_WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const providerStatus = await runtimeProvider.getStatus(externalId);
      if (providerStatus === 'running') return;
      if (providerStatus === 'removed' || providerStatus === 'terminal') {
        throw new Error(`App provider runtime ${externalId} entered ${providerStatus} while waking`);
      }
      await this.dependencies.sleep(APP_PROVIDER_WAKE_POLL_MS);
    }
    throw new Error(`App provider runtime ${externalId} did not become running within ${APP_PROVIDER_WAKE_TIMEOUT_MS}ms`);
  }

  /**
   * Resolve the runtime provider for a teardown operation, tolerating a
   * provider this deployment can no longer construct. A legacy runtime can name
   * a provider that has since been disabled (its API key is unset) or retired;
   * the remote sandbox is then unreachable regardless. Returning null lets stop
   * and remove complete as a no-op success instead of throwing a 500/502 that
   * blocks App delete, idle-reap, and deploy supersede.
   */
  private resolveRuntimeProvider(provider: SandboxProviderName): SandboxProvider | null {
    try {
      return this.dependencies.runtimeProvider(provider);
    } catch (error) {
      logger.warn('[apps] teardown skipped: sandbox provider is not resolvable', {
        provider,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async stop(provider: SandboxProviderName, externalId: string): Promise<void> {
    const runtimeProvider = this.resolveRuntimeProvider(provider);
    if (!runtimeProvider) return;
    try {
      await runtimeProvider.stop(externalId);
    } catch (error) {
      // Provider stop endpoints are not consistently idempotent. Daytona, for
      // example, rejects a second stop after it already archived the sandbox.
      // Confirm provider truth before deciding whether the operation failed.
      const status = await runtimeProvider.getStatus(externalId).catch(() => 'unknown' as const);
      if (status === 'stopped' || status === 'removed') return;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (provider status: ${status})`, { cause: error });
    }
  }

  async remove(provider: SandboxProviderName, externalId: string): Promise<void> {
    const runtimeProvider = this.resolveRuntimeProvider(provider);
    if (!runtimeProvider) return;
    await runtimeProvider.remove(externalId);
  }

  async ingress(
    provider: SandboxProviderName,
    externalId: string,
    transport: 'http' | 'websocket' = 'http',
  ): Promise<ResolvedSandboxIngress> {
    return this.dependencies.runtimeProvider(provider).resolveIngress(externalId, {
      port: APP_INGRESS_PORT,
      transport,
    });
  }

  async status(
    provider: SandboxProviderName,
    externalId: string,
    runtimeId: string,
  ): Promise<AppdStatus> {
    const response = await this.controlRequest(provider, externalId, runtimeId, '/v1/status');
    if (!response.ok) {
      throw new Error(`kortix-appd status returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return response.json() as Promise<AppdStatus>;
  }

  async logs(
    provider: SandboxProviderName,
    externalId: string,
    runtimeId: string,
    after = 0,
    limit = 200,
  ): Promise<unknown> {
    const query = new URLSearchParams({
      after: String(Math.max(0, Math.trunc(after))),
      limit: String(Math.max(1, Math.min(1000, Math.trunc(limit)))),
    });
    const response = await this.controlRequest(
      provider,
      externalId,
      runtimeId,
      `/v1/logs?${query}`,
    );
    if (!response.ok) {
      throw new Error(`kortix-appd logs returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  }

  async waitUntilReady(
    provider: SandboxProviderName,
    externalId: string,
    runtimeId: string,
    timeoutMs = 120_000,
  ): Promise<AppdStatus> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'runtime did not answer';
    let nextRestartAt = 0;
    while (Date.now() < deadline) {
      try {
        const status = await this.status(provider, externalId, runtimeId);
        if (status.ready && status.status === 'running') return status;
        if (status.status === 'failed') {
          throw new Error(`kortix-appd failed${status.last_exit ? `: ${status.last_exit}` : ''}`);
        }
        lastError = `status=${status.status} ready=${status.ready}`;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('kortix-appd failed')) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        const unauthorized = /kortix-appd status returned (?:401|403):/.test(lastError);
        if (!unauthorized && Date.now() >= nextRestartAt) {
          nextRestartAt = Date.now() + APPD_RESTART_INTERVAL_MS;
          try {
            await this.dependencies.runtimeProvider(provider).ensureAppRuntimeStarted(externalId);
          } catch (restartError) {
            lastError = `appd restart failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`;
          }
        }
      }
      await this.dependencies.sleep(500);
    }
    throw new Error(`App readiness timed out after ${timeoutMs}ms (${lastError})`);
  }

  private async controlRequest(
    provider: SandboxProviderName,
    externalId: string,
    runtimeId: string,
    path: string,
  ): Promise<Response> {
    const ingress = await this.dependencies.runtimeProvider(provider).resolveIngress(externalId, {
      port: APP_CONTROL_PORT,
      path,
      transport: 'http',
    });
    const token = appControlToken(runtimeId, this.dependencies.controlSecret);
    return this.dependencies.fetch(`${ingress.url.replace(/\/$/, '')}${path}`, {
      headers: {
        ...ingress.headers,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  }
}
