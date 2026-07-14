import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCustomerRepositories,
  type CustomerRepositories,
} from './artifacts.ts';
import type { AppBundleInstaller, ImagePreparer, ResolvedImages } from './compose-deploy.ts';
import type { CommandRunner } from './process.ts';
import type { EnterpriseReleaseManifest } from './release-contract.ts';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

/**
 * AWS path: the customer ECR is populated by the release pipeline (the instance
 * profile is PULL-ONLY — it cannot PutImage), so the box simply `docker pull`s
 * the ECR refs by the TUF-signed digest. The digest pin from the TUF-verified
 * manifest is the trust anchor; no on-box crane mirror, no push rights needed.
 */
export class EcrImagePreparer implements ImagePreparer {
  private readonly repositories: CustomerRepositories;

  constructor(
    private readonly runner: CommandRunner,
    ecrRepositoriesJson: string,
    private readonly caddyImage: string,
  ) {
    this.repositories = parseCustomerRepositories(ecrRepositoriesJson);
    assertCaddy(caddyImage);
  }

  prepare(manifest: EnterpriseReleaseManifest, _cosignPublicKeyPath: string): ResolvedImages {
    const images: ResolvedImages = {
      api: `${this.repositories.api}@${manifest.images.api.digest}`,
      gateway: `${this.repositories.gateway}@${manifest.images.gateway.digest}`,
      frontend: `${this.repositories.frontend}@${manifest.images.frontend.digest}`,
      caddy: this.caddyImage,
    };
    for (const ref of Object.values(images)) this.runner.run('docker', ['pull', ref]);
    return images;
  }
}

/**
 * VPS path: cosign-verify the Docker Hub source images and `docker pull` them by
 * digest. No mirror — the box pulls straight from the public registry.
 */
export class PublicImagePreparer implements ImagePreparer {
  constructor(
    private readonly runner: CommandRunner,
    private readonly cosign: boolean,
    private readonly caddyImage: string,
  ) {
    assertCaddy(caddyImage);
  }

  prepare(manifest: EnterpriseReleaseManifest, cosignPublicKeyPath: string): ResolvedImages {
    for (const role of ['api', 'frontend', 'gateway'] as const) {
      if (this.cosign) {
        this.runner.run('cosign', [
          'verify', '--key', cosignPublicKeyPath, '--insecure-ignore-tlog=false', manifest.images[role].source,
        ]);
      }
      this.runner.run('docker', ['pull', manifest.images[role].source]);
    }
    this.runner.run('docker', ['pull', this.caddyImage]);
    return {
      api: manifest.images.api.source,
      gateway: manifest.images.gateway.source,
      frontend: manifest.images.frontend.source,
      caddy: this.caddyImage,
    };
  }
}

function assertCaddy(caddyImage: string): void {
  const at = caddyImage.lastIndexOf('@');
  if (at < 0 || !SHA256.test(caddyImage.slice(at + 1))) {
    throw new Error('KORTIX_CADDY_IMAGE must be digest-pinned (…@sha256:<64 hex>)');
  }
}

export interface AppInstallEnv {
  appDir: string;
  apiDomain: string;
  frontendDomain: string;
  acmeProvider: 'route53' | 'http';
  acmeEmail: string;
  route53HostedZone?: string;
}

/**
 * Local app-bundle installer: extract the signed platform_bundle (which now
 * carries the app compose stack) into /opt/kortix/app and run its bin/install to
 * render .env + acme.caddy and enforce the digest lock. Config-only, no data.
 */
export class LocalAppBundleInstaller implements AppBundleInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly env: AppInstallEnv,
  ) {}

  install(input: {
    manifest: EnterpriseReleaseManifest;
    bundleTar: string;
    images: ResolvedImages;
    runtimeEnvFile: string;
  }): void {
    const args = [
      '--release', input.manifest.version,
      '--runtime-env', input.runtimeEnvFile,
      '--api-image', input.images.api,
      '--gateway-image', input.images.gateway,
      '--frontend-image', input.images.frontend,
      '--caddy-image', input.images.caddy,
      '--api-domain', this.env.apiDomain,
      '--frontend-domain', this.env.frontendDomain,
      '--acme-provider', this.env.acmeProvider,
      '--acme-email', this.env.acmeEmail,
      ...(this.env.route53HostedZone ? ['--route53-hosted-zone', this.env.route53HostedZone] : []),
    ];
    const script = [
      'set -euo pipefail',
      'umask 077',
      `app_dir=${shellQuote(this.env.appDir)}`,
      `archive=${shellQuote(input.bundleTar)}`,
      'install -d -m 0755 "$app_dir"',
      'tar -xzf "$archive" --directory "$app_dir" --no-same-owner',
      'test -x "$app_dir/bin/install"',
      `"$app_dir/bin/install" ${args.map(shellQuote).join(' ')}`,
    ].join('\n');
    this.runner.run('bash', ['-c', script]);
  }
}

/**
 * The runtime env the app .env is rendered from: Secrets Manager on AWS (instance
 * role), a local JSON file on a VPS. Written to a 0600 temp file whose path the
 * app installer reads.
 */
export function materializeRuntimeEnvFile(
  runner: CommandRunner,
  opts: { runtimeSecretArn?: string; runtimeEnvFile?: string; region?: string },
): string {
  let json: string;
  if (opts.runtimeSecretArn) {
    const args = ['secretsmanager', 'get-secret-value', '--secret-id', opts.runtimeSecretArn, '--query', 'SecretString', '--output', 'text'];
    if (opts.region) args.push('--region', opts.region);
    json = runner.run('aws', args).trim();
  } else if (opts.runtimeEnvFile) {
    json = runner.run('cat', [opts.runtimeEnvFile]).trim();
  } else {
    throw new Error('no runtime env source: set KORTIX_RUNTIME_SECRET_ARN or KORTIX_RUNTIME_ENV_FILE');
  }
  const value = JSON.parse(json) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime env must be a JSON object');
  }
  const dir = mkdtempSync(join(tmpdir(), 'kortix-runtime-env-'));
  const path = join(dir, 'runtime.json');
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const LOCK_BUSY_EXIT = 75;

export interface SpawnResult {
  status: number | null;
  error?: Error;
}

/**
 * Single-flight via a real advisory `flock` held for the whole run — the watchdog
 * and prune timers take the SAME lock, so they never fire mid-deploy. Re-execs
 * the updater under `flock -n -E 75`; a busy lock exits 75 → we report a clean
 * no-op skip. Injecting `spawn` keeps this unit-testable without a real flock.
 */
export function runUnderUpdaterLock(
  lockPath: string,
  command: string,
  args: string[],
  spawn: (cmd: string, argv: string[]) => SpawnResult = defaultSpawn,
): { skipped: true } | { status: number } {
  const result = spawn('flock', ['-n', '-E', String(LOCK_BUSY_EXIT), lockPath, command, ...args]);
  if (result.error) throw new Error(`unable to acquire the updater lock: ${result.error.message}`);
  if (result.status === LOCK_BUSY_EXIT) return { skipped: true };
  return { status: result.status ?? 1 };
}

function defaultSpawn(cmd: string, argv: string[]): SpawnResult {
  mkdirSync('/var/lib/kortix', { recursive: true, mode: 0o700 });
  const result = spawnSync(cmd, argv, { stdio: 'inherit', env: { ...process.env, KORTIX_UPDATER_LOCKED: '1' } });
  return { status: result.status, error: result.error ?? undefined };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
