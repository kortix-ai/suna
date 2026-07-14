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
  // Flags win; the Terraform-owned deployer task-def supplies the rest via env
  // (KORTIX_INSTANCE / KORTIX_RELEASE_REPOSITORY / KORTIX_TUF_ROOT_SHA256, …).
  const instance = flags.get('instance') ?? process.env.KORTIX_INSTANCE ?? missing('--instance or KORTIX_INSTANCE');
  if (!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(instance)) throw new Error('instance is not a valid enterprise slug');
  // Resources are named kortix-<instance>; a kortix- prefix would double it.
  if (instance.startsWith('kortix-')) throw new Error('instance must not start with "kortix-"; resources are already named kortix-<instance>');
  const channel = flags.get('channel') ?? process.env.KORTIX_CHANNEL ?? 'stable';
  if (channel !== 'stable') throw new Error('enterprise updater may only track the stable channel');
  const repositoryUrl = flags.get('repository') ?? process.env.KORTIX_RELEASE_REPOSITORY ?? missing('--repository or KORTIX_RELEASE_REPOSITORY');
  const trustedRootSha256 = flags.get('trusted-root-sha256') ?? process.env.KORTIX_TUF_ROOT_SHA256 ?? missing('--trusted-root-sha256 or KORTIX_TUF_ROOT_SHA256');

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
  const clusterName = process.env.KORTIX_CLUSTER || process.env.KORTIX_CLUSTER_NAME || `kortix-${instance}`;
  const runtimeSecretArn = env('KORTIX_RUNTIME_SECRET_ARN');
  const runner = new ProcessRunner();
  const control = new EcsControlPlane(runner, {
    region,
    expectedAccountId,
    instance,
    clusterName,
    runtimeSecretArn,
    releaseParamName: process.env.KORTIX_RELEASE_SSM_PARAM || process.env.KORTIX_RELEASE_PARAM || `/kortix/${instance}/release`,
    ...(explicitServiceNames() ? { serviceNames: explicitServiceNames()! } : {}),
    ...(process.env.KORTIX_MIGRATE_TASKDEF ? { migrateFamilyName: process.env.KORTIX_MIGRATE_TASKDEF } : {}),
    ...(process.env.KORTIX_TASK_NETWORK_CONFIGURATION
      ? { networkConfiguration: process.env.KORTIX_TASK_NETWORK_CONFIGURATION }
      : {}),
  });
  // Domains drive the public health checks + Supabase install; the deployer
  // task-def may pass them explicitly, else derive from the runtime secret URLs.
  const runtimeSecret = control.getSecretJson(runtimeSecretArn);
  // The Terraform deployer task-def sets KORTIX_API_DOMAIN/KORTIX_FRONTEND_DOMAIN
  // explicitly; the secret fallbacks are defense-in-depth. Note the public
  // Supabase URL lives on the FRONTEND host, so the api domain derives from the
  // app's own public origin, never from a SUPABASE_* URL.
  const apiDomain = process.env.KORTIX_API_DOMAIN || hostOf(runtimeSecret.API_PUBLIC_URL || runtimeSecret.KORTIX_URL);
  const frontendDomain = process.env.KORTIX_FRONTEND_DOMAIN || hostOf(runtimeSecret.PUBLIC_URL || runtimeSecret.KORTIX_PUBLIC_URL);
  if (!apiDomain || !frontendDomain) throw new Error('unable to resolve api/frontend domains from env or runtime secret');
  const supabase = new SupabaseInstaller(runner, control, {
    region,
    instance,
    supabaseInstanceId: env('KORTIX_SUPABASE_INSTANCE_ID'),
    runtimeSecretArn,
    artifactBucket: process.env.KORTIX_ARTIFACT_BUCKET || process.env.KORTIX_BACKUP_BUCKET || '',
    artifactKmsKeyArn: process.env.KORTIX_ARTIFACT_KMS_KEY_ARN || process.env.KORTIX_BACKUP_KMS_KEY_ARN || '',
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

function missing(what: string): never {
  throw new Error(`missing required ${what}`);
}

function explicitServiceNames(): Partial<Record<'api' | 'gateway' | 'frontend', string>> | null {
  const names: Partial<Record<'api' | 'gateway' | 'frontend', string>> = {};
  if (process.env.KORTIX_API_SERVICE) names.api = process.env.KORTIX_API_SERVICE;
  if (process.env.KORTIX_GATEWAY_SERVICE) names.gateway = process.env.KORTIX_GATEWAY_SERVICE;
  if (process.env.KORTIX_FRONTEND_SERVICE) names.frontend = process.env.KORTIX_FRONTEND_SERVICE;
  return Object.keys(names).length > 0 ? names : null;
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
