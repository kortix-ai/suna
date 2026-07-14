#!/usr/bin/env bun

import { join } from 'node:path';

import { EcsDeployer, type DeployRequest } from './ecs-deploy.ts';
import { EcsControlPlane } from './ecs.ts';
import { launchSignedUpdaterIfNeeded } from './launcher.ts';
import { ProcessRunner } from './process.ts';
import { SupabaseInstaller } from './supabase.ts';
import { TrustedRepository } from './tuf-repository.ts';

const VERSION = process.env.KORTIX_ENTERPRISE_UPDATER_VERSION ?? '0.1.0-dev';

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' || command === 'version') {
    process.stdout.write(`kortix-enterprise-updater ${VERSION}\n`);
    return 0;
  }
  // `deploy` is the operator/scheduled verb; `reconcile` stays as an alias so any
  // existing wiring keeps working. Both run the identical ECS deploy library.
  if (command !== 'deploy' && command !== 'reconcile') {
    process.stderr.write('Usage: kortix-enterprise-updater deploy [required options]\n');
    return 64;
  }

  const flags = parseFlags(args);
  const instance = requiredFlag(flags, 'instance');
  if (!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(instance)) throw new Error('instance is not a valid enterprise slug');
  const channel = flags.get('channel') ?? 'stable';
  if (channel !== 'stable') throw new Error('enterprise updater may only track the stable channel');
  const repositoryUrl = requiredFlag(flags, 'repository');
  const trustedRootSha256 = requiredFlag(flags, 'trusted-root-sha256');

  const requestedRelease = flags.get('release');
  const rollbackTo = flags.get('rollback') ?? process.env.KORTIX_DEPLOY_ROLLBACK;
  if (requestedRelease && rollbackTo) throw new Error('--release and --rollback are mutually exclusive');
  const request: DeployRequest = {
    ...(requestedRelease ? { requestedRelease } : (process.env.KORTIX_DEPLOY_RELEASE ? { requestedRelease: process.env.KORTIX_DEPLOY_RELEASE } : {})),
    ...(rollbackTo ? { rollbackTo } : {}),
  };

  const workDir = process.env.KORTIX_UPDATER_WORK_DIR ?? `/tmp/kortix-enterprise-updater/${instance}`;
  const payloadExit = await launchSignedUpdaterIfNeeded({
    repositoryUrl,
    trustedRootSha256,
    workDir,
    argv: process.argv.slice(2),
  });
  if (payloadExit !== null) return payloadExit;

  const region = env('AWS_REGION', 'AWS_DEFAULT_REGION');
  const expectedAccountId = env('KORTIX_EXPECTED_ACCOUNT_ID');
  const clusterName = process.env.KORTIX_CLUSTER_NAME || `kortix-${instance}`;
  const runtimeSecretArn = env('KORTIX_RUNTIME_SECRET_ARN');
  const apiDomain = env('KORTIX_API_DOMAIN');
  const frontendDomain = env('KORTIX_FRONTEND_DOMAIN');
  const runner = new ProcessRunner();
  const control = new EcsControlPlane(runner, {
    region,
    expectedAccountId,
    instance,
    clusterName,
    runtimeSecretArn,
    releaseParamName: process.env.KORTIX_RELEASE_PARAM || `/kortix/${instance}/release`,
    ...(process.env.KORTIX_TASK_NETWORK_CONFIGURATION
      ? { networkConfiguration: process.env.KORTIX_TASK_NETWORK_CONFIGURATION }
      : {}),
  });
  const supabase = new SupabaseInstaller(runner, control, {
    region,
    instance,
    supabaseInstanceId: env('KORTIX_SUPABASE_INSTANCE_ID'),
    runtimeSecretArn,
    artifactBucket: env('KORTIX_ARTIFACT_BUCKET', 'KORTIX_BACKUP_BUCKET'),
    artifactKmsKeyArn: env('KORTIX_ARTIFACT_KMS_KEY_ARN', 'KORTIX_BACKUP_KMS_KEY_ARN'),
    apiDomain,
    frontendDomain,
  });
  const deployer = new EcsDeployer({
    runner,
    control,
    supabase,
    region,
    ecrRepositoriesJson: env('KORTIX_ECR_REPOSITORIES'),
    apiDomain,
    frontendDomain,
    openRepository: () => TrustedRepository.open({
      repositoryUrl,
      trustedRootSha256,
      metadataDir: join(workDir, 'tuf-metadata'),
      targetDir: join(workDir, 'tuf-targets'),
    }),
    log: (message) => process.stderr.write(`${message}\n`),
  });

  const outcome = await deployer.deploy(request);
  process.stdout.write(`${JSON.stringify({ instance, channel: 'stable', ...outcome })}\n`);
  return 0;
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid updater option near ${key ?? '<end>'}`);
    }
    const name = key.slice(2);
    if (flags.has(name)) throw new Error(`duplicate updater option --${name}`);
    flags.set(name, value);
  }
  return flags;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`missing required option --${name}`);
  return value;
}

function env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`missing required environment value ${names.join(' or ')}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
