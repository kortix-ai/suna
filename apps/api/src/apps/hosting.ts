import { createHash, createHmac } from 'node:crypto';
import { config, type SandboxProviderName } from '../config';
import {
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
  autoStopMinutes: number;
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
    const result = await this.dependencies.runtimeProvider(input.provider).create({
      accountId: input.accountId,
      userId: input.userId,
      name: input.name,
      snapshot: input.snapshotName,
      autoStopInterval: input.autoStopMinutes,
      workloadType: 'app',
      resourceSpec: input.machine,
      publishedPorts: [APP_CONTROL_PORT, APP_INGRESS_PORT],
      envVars: { ...input.envVars, KORTIX_APPD_TOKEN: token },
    });
    return {
      ...result,
      provider: input.provider,
      runtimeId: input.runtimeId,
      controlTokenHash: appControlTokenHash(token),
    };
  }

  async start(provider: SandboxProviderName, externalId: string): Promise<void> {
    await this.dependencies.runtimeProvider(provider).start(externalId);
  }

  async ensureRunning(provider: SandboxProviderName, externalId: string): Promise<void> {
    await this.dependencies.runtimeProvider(provider).ensureRunning(externalId);
  }

  async stop(provider: SandboxProviderName, externalId: string): Promise<void> {
    await this.dependencies.runtimeProvider(provider).stop(externalId);
  }

  async remove(provider: SandboxProviderName, externalId: string): Promise<void> {
    await this.dependencies.runtimeProvider(provider).remove(externalId);
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
