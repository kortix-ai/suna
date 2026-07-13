import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseCustomerRepositories, verifyAndMirrorImages } from './artifacts.ts';
import type { AwsControlPlane } from './aws.ts';
import {
  parseUpdateRequest,
  requireMaintenanceWindow,
  selectRelease,
  type UpdateRequest,
} from './execution.ts';
import { ReleaseInstaller } from './installer.ts';
import type { CommandRunner } from './process.ts';
import { parseEnterpriseReleaseManifest } from './release-contract.ts';
import { stableTargetPath, TrustedRepository, type TrustedRepositoryOptions } from './tuf-repository.ts';

export interface ReconcilerConfig {
  executionInput: string;
  maintenanceWindow: string;
  repository: TrustedRepositoryOptions;
  ecrRepositoriesJson: string;
  region: string;
  tufCacheBucket: string;
  tufCacheKmsKeyArn: string;
  installer: ConstructorParameters<typeof ReleaseInstaller>[2];
}

export class EnterpriseReconciler {
  constructor(
    private readonly runner: CommandRunner,
    private readonly aws: AwsControlPlane,
    private readonly config: ReconcilerConfig,
  ) {}

  async run(): Promise<{ action: string; release: string; reason?: string }> {
    let leased = false;
    try {
      const request = parseExecutionInput(this.config.executionInput);
      this.aws.verifyIdentity();
      this.aws.acquireLease();
      leased = true;
      const current = this.aws.readState();
      this.restoreTufCache();
      const repository = await TrustedRepository.open(this.config.repository);
      this.persistTufCache();
      const target = stableTargetPath(request.requested_release, request.rollback_to);
      const signed = await repository.readJsonTarget<unknown>(target);
      const manifest = parseEnterpriseReleaseManifest(signed.value);
      const decision = selectRelease(request, current, manifest, signed.sha256);
      if (decision.action === 'noop') {
        this.aws.recordNoop(current, decision.reason);
        return decision;
      }
      requireMaintenanceWindow(request, this.config.maintenanceWindow, new Date(), current.release !== null);

      const [cosignKey, platformBundle, supabaseBundle] = await Promise.all([
        repository.downloadArtifact(manifest.artifacts.cosign_public_key),
        repository.downloadArtifact(manifest.artifacts.platform_bundle),
        repository.downloadArtifact(manifest.artifacts.supabase_bundle),
      ]);
      const images = verifyAndMirrorImages(
        this.runner,
        manifest,
        cosignKey,
        parseCustomerRepositories(this.config.ecrRepositoriesJson),
        this.config.region,
      );
      new ReleaseInstaller(this.runner, this.aws, this.config.installer)
        .install(manifest, platformBundle, supabaseBundle, images, current.release === null);
      this.aws.recordSuccess(current, manifest.version, signed.sha256, decision.action);
      return decision;
    } catch (error) {
      if (leased) this.aws.recordFailure(error as Error);
      throw error;
    }
  }

  private restoreTufCache(): void {
    mkdirSync(this.config.repository.metadataDir, { recursive: true, mode: 0o700 });
    try {
      this.runner.run('aws', [
        's3', 'sync', `s3://${this.config.tufCacheBucket}/updater-metadata/${this.config.installer.instance}/`,
        this.config.repository.metadataDir, '--exclude', 'root.json', '--region', this.config.region,
      ]);
    } catch (error) {
      process.stderr.write(`TUF metadata cache unavailable; continuing from pinned root: ${(error as Error).message}\n`);
    }
  }

  private persistTufCache(): void {
    this.runner.run('aws', [
      's3', 'sync', this.config.repository.metadataDir,
      `s3://${this.config.tufCacheBucket}/updater-metadata/${this.config.installer.instance}/`,
      '--exclude', 'root.json', '--sse', 'aws:kms', '--sse-kms-key-id', this.config.tufCacheKmsKeyArn,
      '--region', this.config.region,
    ]);
  }
}

function parseExecutionInput(value: string): UpdateRequest {
  try {
    return parseUpdateRequest(JSON.parse(value) as unknown);
  } catch (error) {
    throw new Error(`invalid updater execution input: ${(error as Error).message}`);
  }
}
