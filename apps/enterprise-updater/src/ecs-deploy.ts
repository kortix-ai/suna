import { parseCustomerRepositories, verifyAndMirrorImages, type CustomerRepositories } from './artifacts.ts';
import {
  DEPLOY_SERVICE_ROLES,
  type DeployServiceRole,
  type EcsControlPlane,
  type ReleaseRecord,
} from './ecs.ts';
import { parseEnterpriseReleaseManifest, type EnterpriseReleaseManifest } from './release-contract.ts';
import type { CommandRunner } from './process.ts';
import type { SupabaseInstaller } from './supabase.ts';
import { verifyPublicHealth } from './supabase.ts';

export interface SignedRepository {
  readJsonTarget<T>(targetPath: string): Promise<{ value: T; sha256: string; length: number }>;
  downloadArtifact(artifact: EnterpriseReleaseManifest['artifacts']['supabase_bundle']): Promise<string>;
}

export interface DeployRequest {
  /** Pin a specific stable enterprise version instead of the channel head. */
  requestedRelease?: string;
  /** Roll back to an already-published, predecessor-listed version. */
  rollbackTo?: string;
}

export interface DeployOutcome {
  action: 'noop' | 'deploy' | 'rollback';
  release: string;
  reason?: string;
}

export interface DeployDeps {
  runner: CommandRunner;
  control: EcsControlPlane;
  supabase: SupabaseInstaller;
  region: string;
  ecrRepositoriesJson: string;
  apiDomain: string;
  frontendDomain: string;
  openRepository: () => Promise<SignedRepository>;
  /** Overridable for tests; defaults to cosign-verify + crane mirror by digest. */
  mirrorImages?: (
    manifest: EnterpriseReleaseManifest,
    cosignKeyPath: string,
    repositories: CustomerRepositories,
  ) => void;
  now?: () => Date;
  log?: (message: string) => void;
}

export class EcsDeployer {
  private readonly repositories: CustomerRepositories;

  constructor(private readonly deps: DeployDeps) {
    this.repositories = parseCustomerRepositories(deps.ecrRepositoriesJson);
  }

  async deploy(request: DeployRequest = {}): Promise<DeployOutcome> {
    const { control } = this.deps;
    control.verifyIdentity();

    const repository = await this.deps.openRepository();
    const targetPath = stableTargetPath(request.requestedRelease, request.rollbackTo);
    const signed = await repository.readJsonTarget<unknown>(targetPath);
    const manifest = parseEnterpriseReleaseManifest(signed.value);

    const expected = request.rollbackTo ?? request.requestedRelease;
    if (expected && manifest.version !== expected) {
      throw new Error(`signed target version ${manifest.version} does not match requested ${expected}`);
    }
    if (manifest.channel !== 'stable') throw new Error('candidate is not on the stable channel');

    const target = releaseRecord(manifest, this.now());
    const current = control.readReleaseRecord();
    const isRollback = Boolean(request.rollbackTo);

    if (isRollback) {
      if (!current?.version) throw new Error('cannot roll back an instance with no recorded release');
      if (current.version === manifest.version) {
        return { action: 'noop', release: manifest.version, reason: 'rollback target is already deployed' };
      }
      if (!manifest.compatibility.rollback_from.includes(current.version)) {
        throw new Error(`release ${manifest.version} does not permit rollback from ${current.version}`);
      }
    }

    const live = this.readLiveDigests();
    // No-op: SSM breadcrumb AND the live ECS digests already match the manifest.
    if (!isRollback && recordMatches(current, target) && digestsMatch(live, target.digests)) {
      return { action: 'noop', release: manifest.version, reason: 'up to date' };
    }
    // ECS serializes deploys per service; a rollout in flight replaces the lease.
    const inProgress = DEPLOY_SERVICE_ROLES.find((role) => this.rollout(role) === 'IN_PROGRESS');
    if (inProgress) {
      return { action: 'noop', release: manifest.version, reason: 'deployment already in progress' };
    }

    this.log(`Mirroring ${manifest.version} images into customer ECR by digest`);
    const cosignKey = await repository.downloadArtifact(manifest.artifacts.cosign_public_key);
    this.mirror(manifest, cosignKey);

    if (!current || current.supabase_bundle_sha !== target.supabase_bundle_sha) {
      this.log('Supabase bundle changed; installing on the customer EC2 through SSM');
      const bundle = await repository.downloadArtifact(manifest.artifacts.supabase_bundle);
      try {
        this.deps.supabase.install(manifest, bundle);
        this.deps.supabase.finalize(manifest);
      } catch (error) {
        try {
          this.deps.supabase.rollback(manifest);
        } catch (rollbackError) {
          throw new AggregateError(
            [error as Error, rollbackError as Error],
            `Supabase bundle install failed and its rollback also failed`,
          );
        }
        throw error;
      }
    }

    this.rollServices(manifest, isRollback);

    verifyPublicHealth(this.deps.runner, manifest, this.deps.apiDomain, this.deps.frontendDomain);
    control.writeReleaseRecord({ ...target, deployed_at: this.now().toISOString() });
    this.log(`Deployed ${manifest.version}: api/gateway/frontend stable, release breadcrumb written`);
    return { action: isRollback ? 'rollback' : 'deploy', release: manifest.version };
  }

  private rollServices(manifest: EnterpriseReleaseManifest, isRollback: boolean): void {
    const { control } = this.deps;
    const secretKeys = Object.keys(control.getSecretJson(control.context.runtimeSecretArn));
    const secrets = control.secretsArray(control.context.runtimeSecretArn, secretKeys);

    // Register migrate first and run it to completion BEFORE any service moves;
    // a nonzero migrate exit aborts the deploy with the services untouched.
    const migrateBase = control.describeTaskDefinition(control.migrateFamily());
    const migrateArn = control.registerTaskDefinition(
      control.renderTaskDefinition(migrateBase, 'migrate', this.imageRef(manifest, 'api'), secrets),
    );
    this.log('Running database migrations (migrate task)');
    const exitCode = control.runTaskToCompletion(migrateArn);
    if (exitCode !== 0) {
      throw new Error(`migrate task exited ${exitCode}; aborting before any service was updated`);
    }

    const registered: Record<DeployServiceRole, string> = {} as Record<DeployServiceRole, string>;
    for (const role of DEPLOY_SERVICE_ROLES) {
      const base = control.serviceTaskDefinition(role);
      registered[role] = control.registerTaskDefinition(
        control.renderTaskDefinition(base, role, this.imageRef(manifest, role), secrets),
      );
    }

    for (const role of DEPLOY_SERVICE_ROLES) {
      this.log(`Rolling ${control.serviceName(role)}${isRollback ? ' (rollback)' : ''}`);
      control.updateService(role, registered[role]);
      control.waitServicesStable(role);
      const state = control.describeService(role);
      if (state.rolledBack) {
        throw new Error(
          `ECS deployment circuit breaker rolled back ${control.serviceName(role)}: `
          + `the ${manifest.version} task definition failed to become healthy`,
        );
      }
    }
  }

  private imageRef(manifest: EnterpriseReleaseManifest, role: DeployServiceRole): string {
    return `${this.repositories[role]}@${manifest.images[role].digest}`;
  }

  private readLiveDigests(): Partial<Record<DeployServiceRole, string | null>> {
    const digests: Partial<Record<DeployServiceRole, string | null>> = {};
    for (const role of DEPLOY_SERVICE_ROLES) digests[role] = this.deps.control.describeService(role).digest;
    return digests;
  }

  private rollout(role: DeployServiceRole): string | null {
    return this.deps.control.describeService(role).rolloutState;
  }

  private mirror(manifest: EnterpriseReleaseManifest, cosignKey: string): void {
    if (this.deps.mirrorImages) {
      this.deps.mirrorImages(manifest, cosignKey, this.repositories);
      return;
    }
    verifyAndMirrorImages(this.deps.runner, manifest, cosignKey, this.repositories, this.deps.region);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message);
  }
}

export function stableTargetPath(requestedRelease?: string, rollbackTo?: string): string {
  const version = rollbackTo ?? requestedRelease;
  return version ? `releases/${version}.json` : 'channels/stable.json';
}

export function releaseRecord(manifest: EnterpriseReleaseManifest, now: Date): ReleaseRecord {
  return {
    version: manifest.version,
    digests: {
      api: manifest.images.api.digest,
      gateway: manifest.images.gateway.digest,
      frontend: manifest.images.frontend.digest,
    },
    supabase_bundle_sha: manifest.artifacts.supabase_bundle.sha256,
    deployed_at: now.toISOString(),
  };
}

function recordMatches(current: ReleaseRecord | null, target: ReleaseRecord): boolean {
  if (!current) return false;
  return current.version === target.version
    && current.supabase_bundle_sha === target.supabase_bundle_sha
    && digestsMatch(current.digests, target.digests);
}

function digestsMatch(
  live: Partial<Record<DeployServiceRole, string | null>>,
  target: Record<DeployServiceRole, string>,
): boolean {
  return DEPLOY_SERVICE_ROLES.every((role) => live[role] === target[role]);
}
