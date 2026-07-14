#!/usr/bin/env bun

import { join } from 'node:path';

import { AwsControlPlane } from './aws.ts';
import { launchSignedUpdaterIfNeeded } from './launcher.ts';
import { ProcessRunner } from './process.ts';
import { EnterpriseReconciler } from './reconciler.ts';

const VERSION = process.env.KORTIX_ENTERPRISE_UPDATER_VERSION ?? '0.1.0-dev';

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' || command === 'version') {
    process.stdout.write(`kortix-enterprise-updater ${VERSION}\n`);
    return 0;
  }
  if (command !== 'reconcile') {
    process.stderr.write('Usage: kortix-enterprise-updater reconcile [required options]\n');
    return 64;
  }

  const flags = parseFlags(args);
  const instance = requiredFlag(flags, 'instance');
  if (!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(instance)) throw new Error('instance is not a valid enterprise slug');
  const channel = requiredFlag(flags, 'channel');
  if (channel !== 'stable') throw new Error('enterprise updater may only reconcile stable');
  const repositoryUrl = requiredFlag(flags, 'repository');
  const trustedRootSha256 = requiredFlag(flags, 'trusted-root-sha256');
  const stateTable = requiredFlag(flags, 'state-table');
  const applyRoleArn = requiredFlag(flags, 'apply-role');
  const maintenanceWindow = requiredFlag(flags, 'maintenance-window');
  const executionInput = requiredFlag(flags, 'execution-input');

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
  const runner = new ProcessRunner();
  const aws = new AwsControlPlane(runner, { region, expectedAccountId, stateTable, instance });
  const backupBucket = env('KORTIX_BACKUP_BUCKET');
  const backupKmsKeyArn = env('KORTIX_BACKUP_KMS_KEY_ARN');
  const reconciler = new EnterpriseReconciler(runner, aws, {
    executionInput,
    maintenanceWindow,
    repository: {
      repositoryUrl,
      trustedRootSha256,
      metadataDir: join(workDir, 'tuf-metadata'),
      targetDir: join(workDir, 'tuf-targets'),
    },
    ecrRepositoriesJson: env('KORTIX_ECR_REPOSITORIES'),
    region,
    tufCacheBucket: backupBucket,
    tufCacheKmsKeyArn: backupKmsKeyArn,
    installer: {
      workDir,
      region,
      instance,
      expectedAccountId,
      applyRoleArn,
      clusterName: env('KORTIX_CLUSTER_NAME'),
      kubernetesMinor: env('KORTIX_KUBERNETES_MINOR'),
      stateBucket: env('KORTIX_STATE_BUCKET'),
      stateLockTable: env('KORTIX_STATE_LOCK_TABLE'),
      stateKmsKeyArn: env('KORTIX_STATE_KMS_KEY_ARN'),
      runtimeSecretArn: env('KORTIX_RUNTIME_SECRET_ARN'),
      supabaseInstanceId: env('KORTIX_SUPABASE_INSTANCE_ID'),
      backupBucket,
      backupKmsKeyArn,
      apiDomain: env('KORTIX_API_DOMAIN'),
      frontendDomain: env('KORTIX_FRONTEND_DOMAIN'),
      certificateArn: env('KORTIX_CERTIFICATE_ARN'),
      supabasePrivateIp: env('KORTIX_SUPABASE_PRIVATE_IP'),
      appServiceAccount: env('KORTIX_APP_SERVICE_ACCOUNT'),
    },
  });
  const result = await reconciler.run();
  process.stdout.write(`${JSON.stringify({ instance, channel: 'stable', ...result })}\n`);
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
