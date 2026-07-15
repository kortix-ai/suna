import { APP_ROLES, type AppRole, type DeployBreadcrumb, type HostRuntime } from './box.ts';
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
  /**
   * Opt in to a brief, honest downtime window for a release whose migration is
   * NOT backward-compatible. Without it such a release is refused (an update
   * against old containers can only stay zero-downtime if the schema change is
   * backward-compatible). First installs never need it (no old containers).
   */
  allowDowntime?: boolean;
}

export interface DeployOutcome {
  action: 'noop' | 'deploy' | 'rollback';
  release: string;
  reason?: string;
}

/** The resolved, locally-pullable, digest-pinned refs for one release. */
export interface ResolvedImages {
  api: string;
  gateway: string;
  frontend: string;
  caddy: string;
}

/**
 * Verify + make the release images locally available, returning the resolved
 * digest-pinned ref per role. On AWS this cosign-verifies and crane-mirrors into
 * the customer ECR then `docker pull`s from it; on a VPS it cosign-verifies and
 * `docker pull`s the Docker Hub source by digest.
 */
export interface ImagePreparer {
  prepare(manifest: EnterpriseReleaseManifest, cosignPublicKeyPath: string): ResolvedImages;
}

/** Renders /opt/kortix/app/.env + validates the digest lock by running the signed bin/install. */
export interface AppBundleInstaller {
  install(input: {
    manifest: EnterpriseReleaseManifest;
    bundleTar: string;
    images: ResolvedImages;
    runtimeEnvFile: string;
  }): void;
}

export interface ComposeDeployDeps {
  runner: CommandRunner;
  host: HostRuntime;
  supabase: SupabaseInstaller;
  images: ImagePreparer;
  app: AppBundleInstaller;
  /** Path to a JSON file of the runtime env the app .env is rendered from. */
  runtimeEnvFile: () => string;
  openRepository: () => Promise<SignedRepository>;
  apiDomain: string;
  frontendDomain: string;
  /** AWS account pin; VPS deployments pass nothing. */
  verifyIdentity?: () => void;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * The appliance deployer. Same brain as the ECS deployer — TUF verify, no-op
 * digest check, image mirror/pull, migrate-before-services, start-first service
 * roll, public health, breadcrumb, rollback_from enforcement — but every step is
 * a Docker Compose operation on the box instead of an ECS API call.
 */
export class ComposeDeployer {
  constructor(private readonly deps: ComposeDeployDeps) {}

  async deploy(request: DeployRequest = {}): Promise<DeployOutcome> {
    this.deps.verifyIdentity?.();

    const repository = await this.deps.openRepository();
    const targetPath = stableTargetPath(request.requestedRelease, request.rollbackTo);
    const signed = await repository.readJsonTarget<unknown>(targetPath);
    const manifest = parseEnterpriseReleaseManifest(signed.value);

    const expected = request.rollbackTo ?? request.requestedRelease;
    if (expected && manifest.version !== expected) {
      throw new Error(`signed target version ${manifest.version} does not match requested ${expected}`);
    }
    if (manifest.channel !== 'stable') throw new Error('candidate is not on the stable channel');

    const target = breadcrumb(manifest, this.now());
    const current = this.deps.host.readBreadcrumb();
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

    // No-op: the release breadcrumb AND the live container digests already match.
    if (!isRollback && recordMatches(current, target) && this.liveDigestsMatch(target.digests)) {
      return { action: 'noop', release: manifest.version, reason: 'up to date' };
    }

    // Zero-downtime safety gate. The start-first roll briefly runs OLD app
    // containers against the NEW schema, so it is safe only when every migration
    // in this release is backward-compatible. A first install (no prior release)
    // has no old containers and is always safe. Otherwise a non-backward-compatible
    // migration needs an explicit --allow-downtime / KORTIX_ALLOW_DOWNTIME opt-in;
    // without it we abort BEFORE touching anything (no image pull, no migrate).
    const firstInstall = current === null;
    const backwardCompatible = manifest.migrations.every((migration) => migration.backward_compatible);
    const needsDowntime = !firstInstall && !backwardCompatible;
    if (needsDowntime && !request.allowDowntime) {
      throw new Error(
        `release ${manifest.version} contains a non-backward-compatible migration; ` +
          'it cannot be applied with zero downtime. Re-run with --allow-downtime ' +
          '(KORTIX_ALLOW_DOWNTIME=1) during a maintenance window to accept a brief downtime.',
      );
    }

    this.log(`Preparing ${manifest.version} images (verify + pull by digest)`);
    const cosignKey = await repository.downloadArtifact(manifest.artifacts.cosign_public_key);
    const images = this.deps.images.prepare(manifest, cosignKey);

    if (!current || current.supabase_bundle_sha !== target.supabase_bundle_sha) {
      this.log('Supabase bundle changed; installing on the box');
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
            'Supabase bundle install failed and its rollback also failed',
          );
        }
        throw error;
      }
    }

    // Render the app .env + validate the digest lock (the signed platform_bundle
    // now carries the app bundle). Nothing has touched a running container yet.
    const appBundle = await repository.downloadArtifact(manifest.artifacts.platform_bundle);
    this.deps.app.install({ manifest, bundleTar: appBundle, images, runtimeEnvFile: this.deps.runtimeEnvFile() });

    if (needsDowntime) {
      // Honest, brief downtime: the non-backward-compatible schema change means the
      // old app must NOT run against the new schema. Drain the app tier, migrate,
      // then start the new containers. Supabase/Caddy stay up throughout.
      this.log('Non-backward-compatible migration: draining app for a brief downtime window');
      this.deps.host.stopAppServices();
      this.log('Running database migrations (docker compose run --rm migrate)');
      this.deps.host.runMigrate();
      for (const role of APP_ROLES) {
        this.log(`Starting ${role}${isRollback ? ' (rollback)' : ''} on the new release`);
        this.deps.host.rolloutService(role);
      }
    } else {
      // Migrate to completion BEFORE any service moves; a nonzero exit throws here
      // and aborts the deploy with every running container untouched.
      this.log('Running database migrations (docker compose run --rm migrate)');
      this.deps.host.runMigrate();

      // Start-first rolling swap, one service at a time. A failed health gate throws
      // and leaves the previous version serving; later services are never touched.
      for (const role of APP_ROLES) {
        this.log(`Rolling ${role}${isRollback ? ' (rollback)' : ''} start-first`);
        this.deps.host.rolloutService(role);
      }
    }

    // Bring up / reconcile the Caddy edge, then verify public health through it.
    this.deps.host.startEdge();
    verifyPublicHealth(this.deps.runner, manifest, this.deps.apiDomain, this.deps.frontendDomain);
    this.deps.host.writeBreadcrumb({ ...target, deployed_at: this.now().toISOString() });
    this.log(`Deployed ${manifest.version}: api/gateway/frontend healthy, breadcrumb written`);
    return { action: isRollback ? 'rollback' : 'deploy', release: manifest.version };
  }

  private liveDigestsMatch(target: Record<AppRole, string>): boolean {
    return APP_ROLES.every((role) => this.deps.host.runningDigest(role) === target[role]);
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

export function breadcrumb(manifest: EnterpriseReleaseManifest, now: Date): DeployBreadcrumb {
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

function recordMatches(current: DeployBreadcrumb | null, target: DeployBreadcrumb): boolean {
  if (!current) return false;
  return current.version === target.version
    && current.supabase_bundle_sha === target.supabase_bundle_sha
    && APP_ROLES.every((role) => current.digests[role] === target.digests[role]);
}
