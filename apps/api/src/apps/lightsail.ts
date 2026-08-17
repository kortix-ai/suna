import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
} from '@aws-sdk/client-codebuild';
import {
  BatchDeleteImageCommand,
  DeleteRepositoryPolicyCommand,
  DescribeImagesCommand,
  ECRClient,
  GetRepositoryPolicyCommand,
  SetRepositoryPolicyCommand,
  type ImageDetail,
} from '@aws-sdk/client-ecr';
import {
  CreateContainerServiceCommand,
  CreateContainerServiceDeploymentCommand,
  DeleteContainerServiceCommand,
  GetContainerLogCommand,
  GetContainerServicesCommand,
  LightsailClient,
  UpdateContainerServiceCommand,
} from '@aws-sdk/client-lightsail';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import * as tar from 'tar';
import { stageAppBuildContext } from '../snapshots/build-context';
import type { BuildLogTap } from '../snapshots/providers';
import type { AppMachineSpec } from './hosting';
import {
  appControlToken,
  appControlTokenHash,
  appOriginToken,
  appOriginTokenHash,
} from './hosting-auth';
import { lightsailPowerForMachine } from './hosting-backends';
import type { SandboxStatus } from '../platform/providers';

interface CommandClient {
  send(command: unknown): Promise<any>;
}

const MAX_RECONCILIATION_PAGES = 10;

export interface LightsailDependencies {
  lightsail: CommandClient;
  codebuild: CommandClient;
  ecr: CommandClient;
  s3: CommandClient;
  region: string;
  buildBucket: string;
  ecrRepositoryUri: string;
  codebuildProject: string;
  environment: string;
  controlSecret: string;
  sleep: (milliseconds: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export interface LightsailBuildInput {
  deploymentId: string;
  snapshotName: string;
  sourceDir?: string;
  dockerfile: string;
  runtimeSpec: Record<string, unknown>;
  logTap?: BuildLogTap;
}

export interface LightsailRuntimeInput {
  runtimeId: string;
  deploymentId: string;
  accountId: string;
  userId: string;
  name: string;
  imageReference: string;
  machine: AppMachineSpec;
  envVars?: Record<string, string>;
}

export interface LightsailRuntimeHandle {
  externalId: string;
  originTokenHash: string;
  metadata: Record<string, unknown>;
}

function environmentNamespace(environment: string): string {
  return environment.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 12) || 'unknown';
}

function serviceName(environment: string, runtimeId: string): string {
  return `kortix-${environmentNamespace(environment)}-app-${runtimeId.replaceAll('-', '').slice(0, 12)}`;
}

function imageTag(deploymentId: string): string {
  return `deployment-${deploymentId.replaceAll('-', '')}`;
}

function repositoryName(repositoryUri: string): string {
  return repositoryUri.replace(/^[^/]+\//, '');
}

function pullPolicySid(externalId: string): string {
  return `AllowLightsailPull-${externalId}`;
}

function codeBuildSpec(): string {
  return [
    'version: 0.2',
    'phases:',
    '  pre_build:',
    '    commands:',
    '      - aws ecr get-login-password --region "$KORTIX_AWS_REGION" | docker login --username AWS --password-stdin "${KORTIX_IMAGE%/*}"',
    '      - aws s3 cp "$KORTIX_CONTEXT_URI" /tmp/kortix-app-context.tar.gz',
    '      - mkdir -p /tmp/kortix-app-context',
    '      - tar -xzf /tmp/kortix-app-context.tar.gz -C /tmp/kortix-app-context',
    '  build:',
    '    commands:',
    '      - cd /tmp/kortix-app-context',
    '      - docker build --platform linux/amd64 -f "$KORTIX_DOCKERFILE" -t "$KORTIX_IMAGE" .',
    '  post_build:',
    '    commands:',
    '      - docker push "$KORTIX_IMAGE"',
  ].join('\n');
}

export class LightsailAppHostingBackend {
  constructor(private readonly dependencies: LightsailDependencies) {}

  static fromEnvironment(input: Omit<LightsailDependencies, 'lightsail' | 'codebuild' | 'ecr' | 's3' | 'sleep'>) {
    return new LightsailAppHostingBackend({
      ...input,
      lightsail: new LightsailClient({ region: input.region }),
      codebuild: new CodeBuildClient({ region: input.region }),
      ecr: new ECRClient({ region: input.region }),
      s3: new S3Client({ region: input.region }),
      sleep: (milliseconds) => Bun.sleep(milliseconds),
      fetch: globalThis.fetch,
    });
  }

  private async existingDeploymentImage(tag: string): Promise<ImageDetail | null> {
    try {
      const response = await this.dependencies.ecr.send(new DescribeImagesCommand({
        repositoryName: repositoryName(this.dependencies.ecrRepositoryUri),
        imageIds: [{ imageTag: tag }],
      }));
      return response.imageDetails?.[0] ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'ImageNotFoundException') return null;
      throw error;
    }
  }

  async buildImage(input: LightsailBuildInput): Promise<{ buildId: string; imageReference: string }> {
    const tag = imageTag(input.deploymentId);
    const reference = `${this.dependencies.ecrRepositoryUri}:${tag}`;
    const existing = await this.existingDeploymentImage(tag);
    if (existing) {
      input.logTap?.onLine?.(`Reusing existing ECR image ${reference}`);
      return {
        buildId: `ecr:${existing.imageDigest ?? tag}`,
        imageReference: reference,
      };
    }
    const staged = await stageAppBuildContext(input.snapshotName, input.dockerfile, {
      sourceDir: input.sourceDir,
      runtimeSpec: input.runtimeSpec,
    });
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'kortix-app-lightsail-build-'));
    const archivePath = join(temporaryRoot, 'context.tar.gz');
    const objectKey = `apps/${environmentNamespace(this.dependencies.environment)}/build-contexts/${input.deploymentId}.tar.gz`;
    try {
      await tar.c({ cwd: staged.contextDir, file: archivePath, gzip: true }, ['.']);
      // App artifacts are capped at 50 MiB. Buffering makes the S3 request
      // replayable and avoids Bun/Node stream sockets becoming non-retryable
      // when S3 closes an idle chunked upload.
      const archive = await readFile(archivePath);
      await this.dependencies.s3.send(new PutObjectCommand({
        Bucket: this.dependencies.buildBucket,
        Key: objectKey,
        Body: archive,
        ContentLength: archive.byteLength,
        ContentType: 'application/gzip',
        Metadata: { deployment_id: input.deploymentId },
      }));
      const started = await this.dependencies.codebuild.send(new StartBuildCommand({
        projectName: this.dependencies.codebuildProject,
        buildspecOverride: codeBuildSpec(),
        environmentVariablesOverride: [
          { name: 'KORTIX_AWS_REGION', value: this.dependencies.region, type: 'PLAINTEXT' },
          { name: 'KORTIX_CONTEXT_URI', value: `s3://${this.dependencies.buildBucket}/${objectKey}`, type: 'PLAINTEXT' },
          { name: 'KORTIX_DOCKERFILE', value: staged.dockerfileName, type: 'PLAINTEXT' },
          { name: 'KORTIX_IMAGE', value: reference, type: 'PLAINTEXT' },
        ],
      }));
      const buildId = started.build?.id;
      if (!buildId) throw new Error('CodeBuild did not return a build id');
      input.logTap?.onLine?.(`CodeBuild ${buildId} started`);
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const response = await this.dependencies.codebuild.send(
          new BatchGetBuildsCommand({ ids: [buildId] }),
        );
        const build = response.builds?.[0];
        const status = build?.buildStatus;
        if (status === 'SUCCEEDED') {
          input.logTap?.onLine?.(`CodeBuild ${buildId} pushed ${reference}`);
          return { buildId, imageReference: reference };
        }
        if (status && ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(status)) {
          throw new Error(`CodeBuild ${buildId} ended with ${status}`);
        }
        await this.dependencies.sleep(5_000);
      }
      throw new Error(`CodeBuild ${buildId} did not finish within 15 minutes`);
    } finally {
      await Promise.allSettled([
        rm(staged.contextDir, { recursive: true, force: true }),
        rm(temporaryRoot, { recursive: true, force: true }),
        this.dependencies.s3.send(new DeleteObjectCommand({
          Bucket: this.dependencies.buildBucket,
          Key: objectKey,
        })),
      ]);
    }
  }

  private async service(externalId: string): Promise<any | null> {
    try {
      const response = await this.dependencies.lightsail.send(
        new GetContainerServicesCommand({ serviceName: externalId }),
      );
      return response.containerServices?.[0] ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFoundException') return null;
      throw error;
    }
  }

  private async waitFor(
    externalId: string,
    predicate: (service: any) => boolean,
    description: string,
  ): Promise<any> {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const service = await this.service(externalId);
      if (service && predicate(service)) return service;
      if (service?.state === 'FAILED') {
        throw new Error(`Lightsail service ${externalId} failed while ${description}`);
      }
      await this.dependencies.sleep(5_000);
    }
    throw new Error(`Lightsail service ${externalId} did not finish ${description} within 15 minutes`);
  }

  private async repositoryPolicy(): Promise<{ Version: string; Statement: any[] }> {
    try {
      const response = await this.dependencies.ecr.send(new GetRepositoryPolicyCommand({
        repositoryName: repositoryName(this.dependencies.ecrRepositoryUri),
      }));
      const parsed = JSON.parse(response.policyText || '{}') as {
        Version?: string;
        Statement?: unknown | unknown[];
      };
      const statements = parsed.Statement === undefined
        ? []
        : Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement];
      return { Version: parsed.Version || '2012-10-17', Statement: statements };
    } catch (error) {
      if ((error as { name?: string }).name === 'RepositoryPolicyNotFoundException') {
        return { Version: '2012-10-17', Statement: [] };
      }
      throw error;
    }
  }

  private async grantRepositoryAccess(externalId: string, principalArn: string): Promise<void> {
    const policy = await this.repositoryPolicy();
    const sid = pullPolicySid(externalId);
    policy.Statement = policy.Statement.filter((statement) => statement?.Sid !== sid);
    policy.Statement.push({
      Sid: sid,
      Effect: 'Allow',
      Principal: { AWS: principalArn },
      Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
    });
    await this.dependencies.ecr.send(new SetRepositoryPolicyCommand({
      repositoryName: repositoryName(this.dependencies.ecrRepositoryUri),
      policyText: JSON.stringify(policy),
    }));
  }

  private async removeRepositoryAccess(externalId: string): Promise<void> {
    const policy = await this.repositoryPolicy();
    const statements = policy.Statement.filter(
      (statement) => statement?.Sid !== pullPolicySid(externalId),
    );
    if (statements.length === policy.Statement.length) return;
    if (statements.length === 0) {
      await this.dependencies.ecr.send(new DeleteRepositoryPolicyCommand({
        repositoryName: repositoryName(this.dependencies.ecrRepositoryUri),
      }));
      return;
    }
    await this.dependencies.ecr.send(new SetRepositoryPolicyCommand({
      repositoryName: repositoryName(this.dependencies.ecrRepositoryUri),
      policyText: JSON.stringify({ ...policy, Statement: statements }),
    }));
  }

  private async waitForEndpoint(serviceUrl: string): Promise<void> {
    const url = `${serviceUrl.replace(/\/$/, '')}/__kortix/health`;
    const fetcher = this.dependencies.fetch ?? globalThis.fetch;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
        if (response.status >= 200 && response.status < 400) return;
      } catch {
        // Lightsail publishes the URL before its edge listener accepts traffic.
      }
      await this.dependencies.sleep(2_000);
    }
    throw new Error(`Lightsail endpoint ${url} did not become ready within 6 minutes`);
  }

  async createRuntime(input: LightsailRuntimeInput): Promise<LightsailRuntimeHandle> {
    const externalId = serviceName(this.dependencies.environment, input.runtimeId);
    const originToken = appOriginToken(input.runtimeId, this.dependencies.controlSecret);
    const controlToken = appControlToken(input.runtimeId, this.dependencies.controlSecret);
    const power = lightsailPowerForMachine(input.machine);
    const existing = await this.service(externalId);
    if (!existing) {
      await this.dependencies.lightsail.send(new CreateContainerServiceCommand({
        serviceName: externalId,
        power,
        scale: 1,
        tags: [
          { key: 'kortix:environment', value: this.dependencies.environment },
          { key: 'kortix:component', value: 'apps-hosting' },
          { key: 'kortix:runtime-id', value: input.runtimeId },
          { key: 'kortix:deployment-id', value: input.deploymentId },
          { key: 'kortix:account-id', value: input.accountId },
        ],
      }));
    }
    await this.waitFor(
      externalId,
      (service) => service.state === 'READY' || service.state === 'RUNNING',
      'provisioning',
    );
    await this.dependencies.lightsail.send(new UpdateContainerServiceCommand({
      serviceName: externalId,
      privateRegistryAccess: { ecrImagePullerRole: { isActive: true } },
    }));
    const registryService = await this.waitFor(
      externalId,
      (candidate) => (
        candidate.state === 'READY' || candidate.state === 'RUNNING'
      ) && Boolean(candidate.privateRegistryAccess?.ecrImagePullerRole?.principalArn),
      'enabling private registry access',
    );
    const pullerArn = registryService.privateRegistryAccess.ecrImagePullerRole.principalArn;
    // AWS documents a 30-second IAM propagation window after the Lightsail
    // puller principal appears. The repository policy must include that exact
    // principal before Lightsail can start the private ECR image.
    await this.dependencies.sleep(30_000);
    await this.grantRepositoryAccess(externalId, pullerArn);
    await this.dependencies.lightsail.send(new CreateContainerServiceDeploymentCommand({
      serviceName: externalId,
      containers: {
        app: {
          image: input.imageReference,
          environment: {
            ...input.envVars,
            KORTIX_APPD_TOKEN: controlToken,
            KORTIX_APP_ORIGIN_TOKEN: originToken,
          },
          ports: { '8080': 'HTTP' },
        },
      },
      publicEndpoint: {
        containerName: 'app',
        containerPort: 8080,
        healthCheck: {
          path: '/__kortix/health',
          successCodes: '200-399',
          intervalSeconds: 10,
          timeoutSeconds: 5,
          healthyThreshold: 2,
          unhealthyThreshold: 2,
        },
      },
    }));
    const service = await this.waitFor(
      externalId,
      (candidate) => candidate.state === 'RUNNING' && candidate.currentDeployment?.state === 'ACTIVE',
      'deploying',
    );
    await this.waitForEndpoint(service.url);
    return {
      externalId,
      originTokenHash: appOriginTokenHash(originToken),
      metadata: {
        serviceUrl: service.url,
        imageReference: input.imageReference,
        power,
        controlTokenHash: appControlTokenHash(controlToken),
      },
    };
  }

  async stop(externalId: string): Promise<void> {
    let deletionStarted = false;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      try {
        await this.dependencies.lightsail.send(
          new DeleteContainerServiceCommand({ serviceName: externalId }),
        );
        deletionStarted = true;
        break;
      } catch (error) {
        if ((error as { name?: string }).name === 'NotFoundException') {
          await this.removeRepositoryAccess(externalId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('transition state')) throw error;
        await this.dependencies.sleep(2_000);
      }
    }
    if (!deletionStarted) {
      throw new Error(`Lightsail service ${externalId} stayed transitional for 6 minutes`);
    }
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (!(await this.service(externalId))) {
        await this.removeRepositoryAccess(externalId);
        return;
      }
      await this.dependencies.sleep(2_000);
    }
    throw new Error(`Lightsail service ${externalId} was not deleted within 6 minutes`);
  }

  async remove(externalId: string): Promise<void> {
    await this.stop(externalId);
  }

  async ensureRuntime(input: LightsailRuntimeInput): Promise<LightsailRuntimeHandle> {
    const externalId = serviceName(this.dependencies.environment, input.runtimeId);
    const service = await this.service(externalId);
    if (
      service?.state === 'RUNNING'
      && service.currentDeployment?.state === 'ACTIVE'
      && service.url
    ) {
      const originToken = appOriginToken(input.runtimeId, this.dependencies.controlSecret);
      return {
        externalId,
        originTokenHash: appOriginTokenHash(originToken),
        metadata: {
          serviceUrl: service.url,
          imageReference: input.imageReference,
          power: lightsailPowerForMachine(input.machine),
          controlTokenHash: appControlTokenHash(
            appControlToken(input.runtimeId, this.dependencies.controlSecret),
          ),
        },
      };
    }
    return this.createRuntime(input);
  }

  async waitUntilReady(externalId: string): Promise<void> {
    const service = await this.waitFor(
      externalId,
      (service) => service.state === 'RUNNING' && service.currentDeployment?.state === 'ACTIVE',
      'becoming ready',
    );
    await this.waitForEndpoint(service.url);
  }

  async status(externalId: string): Promise<SandboxStatus> {
    const service = await this.service(externalId);
    if (!service) return 'removed';
    if (service.state === 'RUNNING' && service.currentDeployment?.state === 'ACTIVE') {
      return 'running';
    }
    if (service.state === 'DELETING' || service.state === 'DELETED') return 'removed';
    if (service.state === 'FAILED') return 'terminal';
    return 'stopped';
  }

  async ingress(runtimeId: string, externalId: string) {
    const service = await this.service(externalId);
    if (!service?.url) throw new Error(`Lightsail service ${externalId} has no public URL`);
    return {
      url: String(service.url).replace(/\/$/, ''),
      headers: {
        'X-Kortix-Origin-Token': appOriginToken(runtimeId, this.dependencies.controlSecret),
      },
      effectivePort: 8080,
    };
  }

  async logs(externalId: string, after: number, limit: number) {
    const response = await this.dependencies.lightsail.send(new GetContainerLogCommand({
      serviceName: externalId,
      containerName: 'app',
    }));
    const events = response.logEvents ?? [];
    const sliced = events.slice(Math.max(0, after), Math.max(0, after) + Math.max(1, limit));
    return {
      entries: sliced.map((entry: any, index: number) => ({
        cursor: after + index + 1,
        time: entry.createdAt?.toISOString?.() ?? new Date().toISOString(),
        source: 'app',
        line: entry.message ?? '',
      })),
      next_cursor: after + sliced.length,
    };
  }

  async reconcileArtifacts(input: {
    protectedDeploymentIds: ReadonlySet<string>;
    protectedExternalIds: ReadonlySet<string>;
    now?: Date;
    graceMs?: number;
    maxDeletes?: number;
  }): Promise<{
    contextsListed: number;
    imagesListed: number;
    servicesListed: number;
    contextsDeleted: number;
    imagesDeleted: number;
    servicesDeleted: number;
    errors: number;
  }> {
    const now = input.now ?? new Date();
    const cutoff = now.getTime() - (input.graceMs ?? 60 * 60_000);
    const maxDeletes = Math.max(0, Math.min(100, input.maxDeletes ?? 25));
    const namespace = environmentNamespace(this.dependencies.environment);
    const contextPrefix = `apps/${namespace}/build-contexts/`;
    const servicePrefix = `kortix-${namespace}-app-`;
    const protectedImageTags = new Set(
      [...input.protectedDeploymentIds].map((deploymentId) => imageTag(deploymentId)),
    );
    const ecrRepositoryName = repositoryName(this.dependencies.ecrRepositoryUri);
    const result = {
      contextsListed: 0,
      imagesListed: 0,
      servicesListed: 0,
      contextsDeleted: 0,
      imagesDeleted: 0,
      servicesDeleted: 0,
      errors: 0,
    };
    let remaining = maxDeletes;
    const isOld = (value: unknown) => {
      if (!value) return false;
      const milliseconds = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
      return Number.isFinite(milliseconds) && milliseconds <= cutoff;
    };

    try {
      let continuationToken: string | undefined;
      for (let page = 0; page < MAX_RECONCILIATION_PAGES && remaining > 0; page += 1) {
        const listed = await this.dependencies.s3.send(new ListObjectsV2Command({
          Bucket: this.dependencies.buildBucket,
          Prefix: contextPrefix,
          MaxKeys: 100,
          ContinuationToken: continuationToken,
        }));
        const objects = listed.Contents ?? [];
        result.contextsListed += objects.length;
        for (const object of objects) {
          if (remaining <= 0) break;
          const key = object.Key as string | undefined;
          const deploymentId = key?.slice(contextPrefix.length).replace(/\.tar\.gz$/, '');
          if (!key || !deploymentId || input.protectedDeploymentIds.has(deploymentId) || !isOld(object.LastModified)) {
            continue;
          }
          try {
            await this.dependencies.s3.send(new DeleteObjectCommand({
              Bucket: this.dependencies.buildBucket,
              Key: key,
            }));
            result.contextsDeleted += 1;
            remaining -= 1;
          } catch {
            result.errors += 1;
          }
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        if (!continuationToken) break;
      }
    } catch {
      result.errors += 1;
    }

    try {
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_RECONCILIATION_PAGES && remaining > 0; page += 1) {
        const described = await this.dependencies.ecr.send(new DescribeImagesCommand({
          repositoryName: ecrRepositoryName,
          maxResults: 100,
          nextToken,
        }));
        const images = described.imageDetails ?? [];
        result.imagesListed += images.length;
        const imageIds: Array<{ imageTag: string }> = [];
        for (const image of images) {
          if (imageIds.length >= remaining) break;
          const tag = (image.imageTags as string[] | undefined)?.find((candidate) =>
            candidate.startsWith('deployment-'));
          if (!tag || protectedImageTags.has(tag) || !isOld(image.imagePushedAt)) continue;
          imageIds.push({ imageTag: tag });
        }
        if (imageIds.length > 0) {
          await this.dependencies.ecr.send(new BatchDeleteImageCommand({
            repositoryName: ecrRepositoryName,
            imageIds,
          }));
          result.imagesDeleted += imageIds.length;
          remaining -= imageIds.length;
        }
        nextToken = described.nextToken;
        if (!nextToken) break;
      }
    } catch {
      result.errors += 1;
    }

    try {
      const listed = await this.dependencies.lightsail.send(new GetContainerServicesCommand({}));
      const services = listed.containerServices ?? [];
      result.servicesListed = services.length;
      for (const service of services) {
        if (remaining <= 0) break;
        const externalId = service.containerServiceName as string | undefined;
        if (
          !externalId
          || !externalId.startsWith(servicePrefix)
          || input.protectedExternalIds.has(externalId)
          || !isOld(service.createdAt)
        ) continue;
        try {
          await this.dependencies.lightsail.send(
            new DeleteContainerServiceCommand({ serviceName: externalId }),
          );
          await this.removeRepositoryAccess(externalId);
          result.servicesDeleted += 1;
          remaining -= 1;
        } catch {
          result.errors += 1;
        }
      }
    } catch {
      result.errors += 1;
    }

    return result;
  }
}
