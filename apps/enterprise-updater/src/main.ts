#!/usr/bin/env bun

import { join } from 'node:path';

import { DockerHost, UPDATER_LOCK_PATH, APP_PROJECT } from './box.ts';
import { ComposeDeployer, type DeployRequest } from './compose-deploy.ts';
import { launchSignedUpdaterIfNeeded } from './launcher.ts';
import { ProcessRunner, type CommandRunner } from './process.ts';
import {
  EcrImagePreparer,
  LocalAppBundleInstaller,
  PublicImagePreparer,
  materializeRuntimeEnvFile,
  runUnderUpdaterLock,
  type AppInstallEnv,
} from './runtime.ts';
import { SupabaseInstaller } from './supabase.ts';
import { TrustedRepository } from './tuf-repository.ts';

const VERSION = process.env.KORTIX_ENTERPRISE_UPDATER_VERSION ?? '0.1.0-dev';
const APP_DIR = process.env.KORTIX_APP_DIR ?? '/opt/kortix/app';

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' || command === 'version') {
    process.stdout.write(`kortix-enterprise-updater ${VERSION}\n`);
    return 0;
  }
  // `run` is the on-box verb (systemd timer + `kortix-updater run`); `deploy`
  // and `reconcile` stay as aliases. All three run the identical compose deploy.
  if (command !== 'run' && command !== 'deploy' && command !== 'reconcile') {
    process.stderr.write('Usage: kortix-enterprise-updater run [required options]\n');
    return 64;
  }

  // Single-flight: hold a real advisory flock for the whole run so the watchdog
  // and prune timers (which take the same lock) never fire mid-deploy. A busy
  // lock is a clean no-op skip.
  if (!process.env.KORTIX_UPDATER_LOCKED) {
    const guard = runUnderUpdaterLock(UPDATER_LOCK_PATH, process.execPath, process.argv.slice(1));
    if ('skipped' in guard) {
      process.stdout.write(`${JSON.stringify({ action: 'noop', reason: 'deployment already in progress' })}\n`);
      return 0;
    }
    return guard.status;
  }

  const flags = parseFlags(args);
  const instance = flags.get('instance') ?? process.env.KORTIX_INSTANCE ?? missing('--instance or KORTIX_INSTANCE');
  if (!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(instance)) throw new Error('instance is not a valid enterprise slug');
  if (instance.startsWith('kortix-')) throw new Error('instance must not start with "kortix-"; resources are already named kortix-<instance>');
  const channel = flags.get('channel') ?? process.env.KORTIX_CHANNEL ?? 'stable';
  if (channel !== 'stable') throw new Error('enterprise updater may only track the stable channel');
  const repositoryUrl = flags.get('repository') ?? process.env.KORTIX_RELEASE_REPOSITORY ?? missing('--repository or KORTIX_RELEASE_REPOSITORY');
  const trustedRootSha256 = flags.get('trusted-root-sha256') ?? process.env.KORTIX_TUF_ROOT_SHA256 ?? missing('--trusted-root-sha256 or KORTIX_TUF_ROOT_SHA256');

  const requestedRelease = flags.get('release') ?? process.env.KORTIX_DEPLOY_RELEASE;
  const rollbackTo = flags.get('rollback') ?? process.env.KORTIX_DEPLOY_ROLLBACK;
  if (requestedRelease && rollbackTo) throw new Error('--release and --rollback are mutually exclusive');
  const request: DeployRequest = {
    ...(requestedRelease ? { requestedRelease } : {}),
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

  const runner = new ProcessRunner();
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const apiDomain = envRequired('KORTIX_API_DOMAIN');
  const frontendDomain = envRequired('KORTIX_FRONTEND_DOMAIN');
  // KORTIX_CADDY_IMAGE is a digest-pinned Caddy build with the caddy-dns/route53
  // plugin (needed for DNS-01). It is NOT in the base instance.env yet — see the
  // seam note: user-data/instance.env must supply it (a stock caddy:2 works only
  // for the HTTP-01 fallback).
  const caddyImage = envRequired('KORTIX_CADDY_IMAGE');
  // On AWS the instance role holds zone-scoped Route53 perms, so ACME uses
  // DNS-01 whenever a hosted zone is provided; a VPS without one falls back to
  // HTTP-01. KORTIX_ACME_PROVIDER can force either.
  const route53ZoneId = process.env.KORTIX_ROUTE53_ZONE_ID;
  const acmeProvider = (process.env.KORTIX_ACME_PROVIDER ?? (route53ZoneId ? 'route53' : 'http')) === 'route53'
    ? 'route53'
    : 'http';

  const expectedAccountId = process.env.KORTIX_EXPECTED_ACCOUNT_ID;
  const verifyIdentity = expectedAccountId
    ? () => verifyAwsIdentity(runner, expectedAccountId, region)
    : undefined;

  const runtimeSecretArn = process.env.KORTIX_RUNTIME_SECRET_ARN;
  const runtimeEnvFilePath = process.env.KORTIX_RUNTIME_ENV_FILE;
  const ecrRepositories = process.env.KORTIX_ECR_REPOSITORIES;

  const images = ecrRepositories
    ? new EcrImagePreparer(runner, ecrRepositories, caddyImage)
    : new PublicImagePreparer(runner, process.env.KORTIX_SKIP_COSIGN !== '1', caddyImage);

  const host = new DockerHost(runner, {
    appDir: APP_DIR,
    composeFile: join(APP_DIR, 'docker-compose.yml'),
    envFile: join(APP_DIR, '.env'),
    ...(process.env.KORTIX_RELEASE_SSM_PARAM ? { releaseSsmParam: process.env.KORTIX_RELEASE_SSM_PARAM } : {}),
    ...(region ? { region } : {}),
    log: (message) => process.stderr.write(`${message}\n`),
  });

  const supabase = new SupabaseInstaller(runner, {
    instance,
    runtimeSecretArn: runtimeSecretArn ?? missing('KORTIX_RUNTIME_SECRET_ARN (the Supabase bundle install reads Secrets Manager)'),
    apiDomain,
    frontendDomain,
  });

  const appInstallEnv: AppInstallEnv = {
    appDir: APP_DIR,
    apiDomain,
    frontendDomain,
    acmeProvider,
    acmeEmail: process.env.KORTIX_ACME_EMAIL ?? '',
    ...(route53ZoneId ? { route53HostedZone: route53ZoneId } : {}),
  };

  const deployer = new ComposeDeployer({
    runner,
    host,
    supabase,
    images,
    app: new LocalAppBundleInstaller(runner, appInstallEnv),
    runtimeEnvFile: () => materializeRuntimeEnvFile(runner, {
      ...(runtimeSecretArn ? { runtimeSecretArn } : {}),
      ...(runtimeEnvFilePath ? { runtimeEnvFile: runtimeEnvFilePath } : {}),
      ...(region ? { region } : {}),
    }),
    apiDomain,
    frontendDomain,
    ...(verifyIdentity ? { verifyIdentity } : {}),
    openRepository: () => TrustedRepository.open({
      repositoryUrl,
      trustedRootSha256,
      metadataDir: join(workDir, 'tuf-metadata'),
      targetDir: join(workDir, 'tuf-targets'),
    }),
    log: (message) => process.stderr.write(`${message}\n`),
  });

  const outcome = await deployer.deploy(request);
  process.stdout.write(`${JSON.stringify({ instance, channel: 'stable', project: APP_PROJECT, ...outcome })}\n`);
  return 0;
}

function verifyAwsIdentity(runner: CommandRunner, expectedAccountId: string, region?: string): void {
  const args = ['sts', 'get-caller-identity', '--output', 'json'];
  if (region) args.push('--region', region);
  const identity = JSON.parse(runner.run('aws', args) || '{}') as { Account?: string };
  if (identity.Account !== expectedAccountId) {
    throw new Error(`AWS account mismatch: expected ${expectedAccountId}, received ${identity.Account}`);
  }
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

function envRequired(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`missing required environment value ${names.join(' or ')}`);
}

function missing(what: string): never {
  throw new Error(`missing required ${what}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
