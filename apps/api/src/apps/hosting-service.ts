import { config, type SandboxProviderName } from '../config';
import type { ResolvedSandboxIngress, SandboxStatus } from '../platform/providers';
import type { BuildLogTap } from '../snapshots/providers';
import {
  AppHostingProvider as SandboxAppHostingBackend,
  type AppMachineSpec,
  type AppdStatus,
} from './hosting';
import {
  lightsailPowerForMachine,
  type AppHostingSelection,
  type ManagedContainerProviderName,
} from './hosting-backends';
import {
  LightsailAppHostingBackend,
  type LightsailRuntimeInput,
} from './lightsail';

export type AppHostingProviderName = SandboxProviderName | ManagedContainerProviderName;
export type AppHostingType = AppHostingSelection['type'];

interface AppRuntimeTargetBase {
  runtimeId: string;
  externalId: string;
}

export type AppRuntimeTarget =
  | (AppRuntimeTargetBase & {
    hostingType: 'sandbox';
    provider: SandboxProviderName;
  })
  | (AppRuntimeTargetBase & {
    hostingType: 'managed_container';
    provider: ManagedContainerProviderName;
  });

export interface AppRuntimeCreateInput {
  runtimeId: string;
  deploymentId: string;
  accountId: string;
  userId: string;
  name: string;
  snapshotName: string;
  imageReference: string;
  machine: AppMachineSpec;
  envVars?: Record<string, string>;
}

export type AppRuntimeHandle = AppRuntimeTarget & {
  controlTokenHash: string | null;
  originTokenHash: string | null;
  metadata: Record<string, unknown>;
};

interface Dependencies {
  sandbox: SandboxAppHostingBackend;
  lightsail: LightsailAppHostingBackend | null;
}

function configuredLightsail(): LightsailAppHostingBackend | null {
  if (!config.KORTIX_APPS_LIGHTSAIL_ENABLED) return null;
  if (
    !config.KORTIX_APPS_AWS_REGION
    || !config.KORTIX_APPS_BUILD_BUCKET
    || !config.KORTIX_APPS_ECR_REPOSITORY_URI
    || !config.KORTIX_APPS_CODEBUILD_PROJECT
  ) return null;
  return LightsailAppHostingBackend.fromEnvironment({
    region: config.KORTIX_APPS_AWS_REGION,
    buildBucket: config.KORTIX_APPS_BUILD_BUCKET,
    ecrRepositoryUri: config.KORTIX_APPS_ECR_REPOSITORY_URI,
    codebuildProject: config.KORTIX_APPS_CODEBUILD_PROJECT,
    environment: config.INTERNAL_KORTIX_ENV,
    controlSecret: config.API_KEY_SECRET,
  });
}

function sandboxProvider(selection: AppHostingSelection): SandboxProviderName {
  if (selection.type !== 'sandbox' || !selection.provider) {
    throw new Error('A resolved sandbox hosting selection requires a provider');
  }
  return selection.provider;
}

/** One provider-neutral control plane for every Apps hosting backend. */
export class AppHostingService {
  private readonly dependencies: Dependencies;

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      sandbox: dependencies.sandbox ?? new SandboxAppHostingBackend(),
      lightsail: dependencies.lightsail === undefined ? configuredLightsail() : dependencies.lightsail,
    };
  }

  assertAvailable(selection: AppHostingSelection): void {
    if (selection.type === 'managed_container' && !this.dependencies.lightsail) {
      throw new Error('AWS Lightsail Apps hosting is not configured');
    }
  }

  async buildImage(
    selection: AppHostingSelection,
    input: {
      deploymentId: string;
      snapshotName: string;
      slug: string;
      sourceDir?: string;
      dockerfile: string;
      runtimeSpec: Record<string, unknown>;
      machine: AppMachineSpec;
      logTap?: BuildLogTap;
    },
  ): Promise<{ buildId: string; imageReference: string }> {
    this.assertAvailable(selection);
    if (selection.type === 'sandbox') {
      await this.dependencies.sandbox.buildImage({
        ...input,
        provider: sandboxProvider(selection),
      });
      return { buildId: input.snapshotName, imageReference: input.snapshotName };
    }
    return this.dependencies.lightsail!.buildImage(input);
  }

  async createRuntime(
    selection: AppHostingSelection,
    input: AppRuntimeCreateInput,
  ): Promise<AppRuntimeHandle> {
    this.assertAvailable(selection);
    if (selection.type === 'sandbox') {
      const provider = sandboxProvider(selection);
      const handle = await this.dependencies.sandbox.createRuntime({
        provider,
        runtimeId: input.runtimeId,
        accountId: input.accountId,
        userId: input.userId,
        name: input.name,
        snapshotName: input.snapshotName,
        machine: input.machine,
        envVars: input.envVars,
      });
      return {
        hostingType: 'sandbox',
        provider,
        runtimeId: input.runtimeId,
        externalId: handle.externalId,
        controlTokenHash: handle.controlTokenHash,
        originTokenHash: null,
        metadata: handle.metadata ?? {},
      };
    }
    const handle = await this.dependencies.lightsail!.createRuntime(
      this.lightsailRuntimeInput(input),
    );
    return {
      hostingType: 'managed_container',
      provider: 'aws_lightsail',
      runtimeId: input.runtimeId,
      externalId: handle.externalId,
      controlTokenHash: null,
      originTokenHash: handle.originTokenHash,
      metadata: handle.metadata,
    };
  }

  private lightsailRuntimeInput(input: AppRuntimeCreateInput): LightsailRuntimeInput {
    return {
      runtimeId: input.runtimeId,
      deploymentId: input.deploymentId,
      accountId: input.accountId,
      userId: input.userId,
      name: input.name,
      imageReference: input.imageReference,
      machine: input.machine,
      envVars: input.envVars,
    };
  }

  async ensureRunning(target: AppRuntimeTarget, recreate: AppRuntimeCreateInput): Promise<void> {
    if (target.hostingType === 'sandbox') {
      await this.dependencies.sandbox.ensureRunning(
        target.provider,
        target.externalId,
      );
      return;
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    await this.dependencies.lightsail!.ensureRuntime(this.lightsailRuntimeInput(recreate));
  }

  async start(target: AppRuntimeTarget, recreate: AppRuntimeCreateInput): Promise<void> {
    if (target.hostingType === 'sandbox') {
      await this.dependencies.sandbox.start(
        target.provider,
        target.externalId,
      );
      return;
    }
    await this.ensureRunning(target, recreate);
  }

  async stop(target: AppRuntimeTarget): Promise<void> {
    if (target.hostingType === 'sandbox') {
      await this.dependencies.sandbox.stop(
        target.provider,
        target.externalId,
      );
      return;
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    await this.dependencies.lightsail!.stop(target.externalId);
  }

  async remove(target: AppRuntimeTarget): Promise<void> {
    if (target.hostingType === 'sandbox') {
      await this.dependencies.sandbox.remove(
        target.provider,
        target.externalId,
      );
      return;
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    await this.dependencies.lightsail!.remove(target.externalId);
  }

  async ingress(
    target: AppRuntimeTarget,
    transport: 'http' | 'websocket' = 'http',
  ): Promise<ResolvedSandboxIngress> {
    if (target.hostingType === 'sandbox') {
      return this.dependencies.sandbox.ingress(
        target.provider,
        target.externalId,
        transport,
      );
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    return this.dependencies.lightsail!.ingress(target.runtimeId, target.externalId);
  }

  async logs(target: AppRuntimeTarget, after = 0, limit = 200): Promise<unknown> {
    if (target.hostingType === 'sandbox') {
      return this.dependencies.sandbox.logs(
        target.provider,
        target.externalId,
        target.runtimeId,
        after,
        limit,
      );
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    return this.dependencies.lightsail!.logs(target.externalId, after, limit);
  }

  async waitUntilReady(target: AppRuntimeTarget, timeoutMs = 120_000): Promise<AppdStatus | void> {
    if (target.hostingType === 'sandbox') {
      return this.dependencies.sandbox.waitUntilReady(
        target.provider,
        target.externalId,
        target.runtimeId,
        timeoutMs,
      );
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    await this.dependencies.lightsail!.waitUntilReady(target.externalId);
  }

  effectiveMachine(selection: AppHostingSelection, machine: AppMachineSpec): AppMachineSpec {
    if (selection.type === 'sandbox') {
      return this.dependencies.sandbox.effectiveMachine(sandboxProvider(selection), machine);
    }
    // Validate exact Lightsail power mapping before billing records the spec.
    // Lightsail includes storage in its power price, so the shared disk meter
    // must not charge the App a second time.
    lightsailPowerForMachine(machine);
    return { ...machine, diskGb: 0 };
  }

  async status(target: AppRuntimeTarget): Promise<SandboxStatus> {
    if (target.hostingType === 'sandbox') {
      return this.dependencies.sandbox.providerStatus(target.provider, target.externalId);
    }
    this.assertAvailable({ type: 'managed_container', provider: 'aws_lightsail' });
    return this.dependencies.lightsail!.status(target.externalId);
  }

  async reconcileManagedArtifacts(
    input: Parameters<LightsailAppHostingBackend['reconcileArtifacts']>[0],
  ): Promise<Awaited<ReturnType<LightsailAppHostingBackend['reconcileArtifacts']>> | null> {
    if (!this.dependencies.lightsail) return null;
    return this.dependencies.lightsail.reconcileArtifacts(input);
  }
}

export function hostingSelectionForTarget(target: AppRuntimeTarget): AppHostingSelection {
  return target.hostingType === 'sandbox'
    ? { type: 'sandbox', provider: target.provider }
    : { type: 'managed_container', provider: target.provider };
}

export function appRuntimeTarget(runtime: {
  hostingType: string;
  provider: string;
  runtimeId: string;
  externalId: string;
}): AppRuntimeTarget {
  if (runtime.hostingType === 'managed_container' && runtime.provider === 'aws_lightsail') {
    return {
      hostingType: 'managed_container',
      provider: 'aws_lightsail',
      runtimeId: runtime.runtimeId,
      externalId: runtime.externalId,
    };
  }
  if (
    runtime.hostingType === 'sandbox'
    && ['daytona', 'platinum', 'e2b'].includes(runtime.provider)
  ) {
    return {
      hostingType: 'sandbox',
      provider: runtime.provider as SandboxProviderName,
      runtimeId: runtime.runtimeId,
      externalId: runtime.externalId,
    };
  }
  throw new Error(
    `Unsupported App runtime hosting backend ${runtime.hostingType}/${runtime.provider}`,
  );
}
