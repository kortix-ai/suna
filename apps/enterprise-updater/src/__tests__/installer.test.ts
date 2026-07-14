import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MirroredImage } from '../artifacts.ts';
import type { AwsControlPlane } from '../aws.ts';
import {
  ReleaseInstaller,
  runtimeExternalSecretsManifest,
  supabaseFinalizeScript,
  supabaseInstallScript,
  supabaseRollbackScript,
} from '../installer.ts';
import type { CommandRunner, RunOptions } from '../process.ts';
import { parseEnterpriseReleaseManifest } from '../release-contract.ts';

const input = {
  bucket: 'kortix-vpc-demo-backups',
  key: `updater-staging/${'a'.repeat(64)}.tar.gz`,
  sha256: 'a'.repeat(64),
  version: '0.9.84-e1',
  runtimeSecretArn: 'arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-vpc-demo/runtime-AbCdEf',
  instance: 'kortix-vpc-demo',
  apiDomain: 'api.vpc-demo.kortix.com',
  frontendDomain: 'vpc-demo.kortix.com',
};

describe('Supabase host installer command', () => {
  test('verifies and atomically activates only a safe signed archive', () => {
    const script = supabaseInstallScript(input);

    expect(script).toContain('sha256sum --check --strict');
    expect(script).toContain('tar -tzf "$archive"');
    expect(script).toContain("awk '{ if ($0 ~ /^\\//)");
    expect(script).toContain('type != "-" && type != "d"');
    expect(script).toContain('--runtime-secret-arn');
    expect(script).toContain("--api-domain 'api.vpc-demo.kortix.com'");
    expect(script).toContain("--frontend-domain 'vpc-demo.kortix.com'");
    expect(script).toContain('mv -Tf /opt/kortix/current.new /opt/kortix/current');
    expect(script).toContain('update-transactions');
    expect(script).toContain('"$transaction.previous"');
    expect(script).toContain('restored the previous release');
  });

  test('renders a portable executable archive path guard', () => {
    const script = supabaseInstallScript(input);
    const line = script.split('\n').find((candidate) => candidate.includes('"$entries" | awk '));
    const program = line?.match(/\| awk '(.+)'$/)?.[1];
    expect(program).toBeDefined();

    const run = (entries: string) => spawnSync('awk', [program!], { input: entries, encoding: 'utf8' });
    expect(run('bundle.json\nvolumes/db/data\n').status).toBe(0);
    expect(run('/etc/passwd\n').status).toBe(1);
    expect(run('volumes/../etc/passwd\n').status).toBe(1);
  });

  test('extracts public bundle assets with container-readable modes under the secure installer umask', () => {
    const root = mkdtempSync(join('/tmp', 'kortix-supabase-modes-'));
    try {
      const source = join(root, 'source');
      const staging = join(root, 'staging');
      const archive = join(root, 'bundle.tar.gz');
      mkdirSync(join(source, 'bin'), { recursive: true });
      mkdirSync(join(source, 'volumes', 'db'), { recursive: true });
      writeFileSync(join(source, 'volumes', 'db', 'webhooks.sql'), 'select 1;\n', { mode: 0o644 });
      writeFileSync(join(source, 'bin', 'install'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      chmodSync(join(source, 'bin', 'install'), 0o755);
      expect(spawnSync('tar', ['-czf', archive, '-C', source, '.']).status).toBe(0);
      mkdirSync(staging);

      const extraction = supabaseInstallScript(input).split('\n')
        .find((candidate) => candidate.startsWith('(umask 022; tar -xzf '));
      expect(extraction).toBeDefined();
      const result = spawnSync('bash', [
        '-ceu',
        `umask 077\narchive="$1"\nstaging="$2"\n${extraction}`,
        'bash', archive, staging,
      ], { encoding: 'utf8' });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(statSync(join(staging, 'volumes', 'db', 'webhooks.sql')).mode & 0o777).toBe(0o644);
      expect(statSync(join(staging, 'bin', 'install')).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat a missing current symlink as a previous release', () => {
    const root = mkdtempSync(join('/tmp', 'kortix-supabase-previous-'));
    try {
      const script = supabaseInstallScript(input).replaceAll('/opt/kortix', root);
      const lines = script.split('\n');
      const start = lines.indexOf('previous=');
      const end = lines.findIndex((line) => line.includes('"$transaction.previous"'));
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const fragment = lines.slice(start, end + 1).join('\n');
      const transaction = join(root, 'transaction');
      const result = spawnSync('bash', ['-ceu', `transaction="$1"\n${fragment}\ncat "$transaction.previous"`, 'bash', transaction], { encoding: 'utf8' });
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ status: 0, stdout: '\n', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('emits bounded commit and rollback commands for the exact activation transaction', () => {
    const commit = supabaseFinalizeScript(input.version, input.sha256);
    const rollback = supabaseRollbackScript(input.version, input.sha256);

    expect(commit).toContain(`test "$current" = '/opt/kortix/releases/${input.version}'`);
    expect(commit).toContain(`/opt/kortix/update-transactions/${input.sha256}.expected`);
    expect(rollback).toContain('test "$current" = "$expected"');
    expect(rollback).toContain('mv -Tf /opt/kortix/current.rollback /opt/kortix/current');
    expect(rollback).toContain('systemctl stop kortix-supabase.service || true');
    expect(() => supabaseRollbackScript('../current', input.sha256))
      .toThrow('unsafe Supabase transaction coordinate');
  });

  test('rejects unsafe coordinates before producing an SSM command', () => {
    expect(() => supabaseInstallScript({ ...input, apiDomain: 'api.example.com; reboot' }))
      .toThrow('unsafe Supabase installation domain');
    expect(() => supabaseInstallScript({ ...input, version: '../current' }))
      .toThrow('unsafe Supabase installation coordinate');
  });
});

const HASH = 'a'.repeat(64);
const DIGEST = `sha256:${HASH}`;

class InstallerRunner implements CommandRunner {
  readonly events: string[];
  failOn: string | null = null;
  apiVersion = '0.9.84';

  constructor(events: string[]) {
    this.events = events;
  }

  run(command: string, args: string[], _options?: RunOptions): string {
    const event = `run:${command} ${args.join(' ')}`;
    this.events.push(event);
    if (this.failOn && event.includes(this.failOn)) throw new Error(`simulated failure: ${this.failOn}`);
    if (command === 'tar' && args[0] === '-tzf') {
      return [
        'bundle.json', 'platform/main.tf',
        'charts/api/Chart.yaml', 'charts/gateway/Chart.yaml', 'charts/edge/Chart.yaml',
      ].join('\n');
    }
    if (command === 'tar' && args[0] === '-tvzf') {
      return [
        '-rw------- root/root bundle.json', '-rw------- root/root platform/main.tf',
        '-rw------- root/root charts/api/Chart.yaml', '-rw------- root/root charts/gateway/Chart.yaml',
        '-rw------- root/root charts/edge/Chart.yaml',
      ].join('\n');
    }
    if (command === 'tar' && args[0] === '-xzf') {
      const directory = args[args.indexOf('--directory') + 1];
      if (!directory) throw new Error('test extraction directory missing');
      materializePlatformBundle(directory);
      return '';
    }
    if (command === 'terraform' && args.includes('show')) {
      return JSON.stringify({
        resource_changes: [{ address: 'helm_release.runtime', type: 'helm_release', change: { actions: ['update'] } }],
      });
    }
    const requestUrl = args.at(-1);
    if (command === 'curl' && requestUrl === 'https://api.vpc-demo.kortix.com/v1/health') {
      return JSON.stringify({ version: this.apiVersion });
    }
    return '';
  }
}

class InstallerAws {
  private command = 0;
  failComment: string | null = null;
  backupFresh = true;

  constructor(private readonly events: string[]) {}

  getSecretJson(): Record<string, unknown> {
    this.events.push('control:get-secret');
    return { CLOUDFLARE_ZONE_ID: 'zone-id', CLOUDFLARE_API_TOKEN: 'cloudflare-token' };
  }

  assumeRole(): NodeJS.ProcessEnv {
    this.events.push('control:assume-role');
    return { AWS_REGION: 'us-west-2' };
  }

  readState() {
    this.events.push('control:read-state');
    const now = this.backupFresh ? new Date().toISOString() : '2026-01-01T00:00:00Z';
    return {
      release: '0.9.83-e1',
      channel: 'stable' as const,
      status: 'healthy',
      manifest_sha256: 'f'.repeat(64),
      updated_at: now,
      last_wal_archived_at: now,
      last_wal_name: '000000010000000000000001',
      last_base_backup_at: now,
      last_base_backup_key: 'basebackups/kortix-vpc-demo/latest/base.tar.gz',
      history: [],
    };
  }

  awsJson<T>(args: string[]): T {
    const commentIndex = args.indexOf('--comment');
    const comment = commentIndex === -1 ? '' : args[commentIndex + 1] ?? '';
    this.events.push(`control:${args[0]} ${args[1]}${comment ? ` ${comment}` : ''}`);
    if (args[0] === 'ssm' && args[1] === 'send-command') {
      if (this.failComment && comment.includes(this.failComment)) throw new Error(`simulated SSM failure: ${comment}`);
      this.command += 1;
      return { Command: { CommandId: `command-${this.command}` } } as T;
    }
    if (args[0] === 'ssm' && args[1] === 'get-command-invocation') {
      return { Status: 'Success' } as T;
    }
    return {} as T;
  }
}

function materializePlatformBundle(root: string): void {
  mkdirSync(join(root, 'platform'), { recursive: true });
  for (const chart of ['api', 'gateway', 'edge']) {
    mkdirSync(join(root, 'charts', chart), { recursive: true });
    writeFileSync(join(root, 'charts', chart, 'Chart.yaml'), `apiVersion: v2\nname: ${chart}\nversion: 1.0.0\n`);
  }
  writeFileSync(join(root, 'platform', 'main.tf'), 'terraform {}\n');
  writeFileSync(join(root, 'bundle.json'), JSON.stringify({
    schema_version: 1,
    kind: 'kortix-enterprise-platform',
    version: '0.9.84-e1',
    terraform_root: 'platform',
    charts: { api: 'charts/api', gateway: 'charts/gateway', edge: 'charts/edge' },
    namespace: 'kortix',
    deployments: ['kortix-api', 'kortix-gateway', 'kortix-frontend'],
  }));
}

function releaseManifest(migrations: Array<{
  id: string;
  sha256: string;
  reversible: boolean;
  backward_compatible: boolean;
}> = []) {
  return parseEnterpriseReleaseManifest({
    schema_version: 1,
    version: '0.9.84-e1',
    channel: 'stable',
    published_at: '2026-07-13T12:00:00Z',
    prod: { version: '0.9.84', source_sha: 'b'.repeat(40) },
    enterprise: { source_sha: 'c'.repeat(40) },
    compatibility: { architectures: ['amd64'], kubernetes_minor: ['1.32'], rollback_from: [] },
    images: Object.fromEntries((['api', 'frontend', 'gateway'] as const).map((role) => [role, {
      source: `index.docker.io/kortix/kortix-${role}@${DIGEST}`,
      digest: DIGEST,
      customer_repository: role,
    }])),
    artifacts: {
      platform_bundle: { target: 'platform.tar.gz', sha256: HASH, length: 1 },
      supabase_bundle: { target: 'supabase.tar.gz', sha256: HASH, length: 1 },
      cosign_public_key: { target: 'cosign.pub', sha256: HASH, length: 1 },
      updater_binary: { target: 'updater-linux-amd64', sha256: HASH, length: 1 },
    },
    migrations,
    health: { api_path: '/v1/health', frontend_path: '/', expected_version: '0.9.84' },
  });
}

function mirroredImages(): MirroredImage[] {
  return (['api', 'frontend', 'gateway'] as const).map((role) => ({
    role,
    source: `index.docker.io/kortix/kortix-${role}@${DIGEST}`,
    destination: `935064898258.dkr.ecr.us-west-2.amazonaws.com/kortix-vpc-demo/${role}:0.9.84-e1`,
    digest: DIGEST,
  }));
}

function installerFixture() {
  const root = mkdtempSync(join(realpathSync(process.cwd()), '.kortix-installer-test-'));
  const events: string[] = [];
  const runner = new InstallerRunner(events);
  const aws = new InstallerAws(events);
  const installer = new ReleaseInstaller(runner, aws as unknown as AwsControlPlane, {
    workDir: root,
    region: 'us-west-2',
    instance: 'kortix-vpc-demo',
    expectedAccountId: '935064898258',
    applyRoleArn: 'arn:aws:iam::935064898258:role/kortix-vpc-demo-platform-apply',
    clusterName: 'kortix-vpc-demo',
    kubernetesMinor: '1.32',
    stateBucket: 'kortix-vpc-demo-state',
    stateLockTable: 'kortix-vpc-demo-lock',
    stateKmsKeyArn: 'arn:aws:kms:us-west-2:935064898258:key/state',
    runtimeSecretArn: input.runtimeSecretArn,
    supabaseInstanceId: 'i-0123456789abcdef0',
    backupBucket: input.bucket,
    backupKmsKeyArn: 'arn:aws:kms:us-west-2:935064898258:key/backups',
    apiDomain: input.apiDomain,
    frontendDomain: input.frontendDomain,
    certificateArn: 'arn:aws:acm:us-west-2:935064898258:certificate/test',
    supabasePrivateIp: '10.42.16.10',
    appServiceAccount: 'kortix-runtime',
  });
  return { root, events, runner, aws, installer };
}

function eventIndex(events: string[], contains: string): number {
  const index = events.findIndex((event) => event.includes(contains));
  expect(index, `missing event containing ${contains}\n${events.join('\n')}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('release installation transaction', () => {
  test('renders the customer runtime External Secrets without secret values', () => {
    const manifest = runtimeExternalSecretsManifest({
      namespace: 'kortix',
      region: 'us-west-2',
      serviceAccountName: 'kortix-runtime',
      runtimeSecretArn: input.runtimeSecretArn,
    });

    expect(manifest.items.map((item) => item.kind)).toEqual(['SecretStore', 'ExternalSecret']);
    expect(JSON.stringify(manifest)).toContain(input.runtimeSecretArn);
    expect(JSON.stringify(manifest)).not.toContain('cloudflare-token');
  });

  test('polls long-running SSM installs through their 30-minute command timeout', () => {
    const fixture = installerFixture();
    try {
      const runSupabaseCommand = Reflect.get(fixture.installer, 'runSupabaseCommand') as (
        comment: string,
        script: string,
      ) => void;
      runSupabaseCommand.call(fixture.installer, 'Test long-running SSM command', 'true');

      const wait = fixture.events.find((event) => event.startsWith('run:bash -ceu'));
      expect(wait).toContain('SECONDS + 1860');
      expect(wait).toContain('Success|Cancelled|TimedOut|Failed');
      expect(fixture.events.some((event) => event.startsWith('run:aws ssm wait command-executed'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('starts Supabase before API migrations and commits only after platform health succeeds', () => {
    const fixture = installerFixture();
    try {
      fixture.installer.install(releaseManifest(), '/tmp/platform.tar.gz', '/tmp/supabase.tar.gz', mirroredImages());

      const supabase = eventIndex(fixture.events, 'Install verified Kortix enterprise release');
      const recovery = eventIndex(fixture.events, 'Verify fresh Kortix recovery point before update');
      const terraform = eventIndex(fixture.events, 'run:terraform -chdir=');
      const externalSecrets = eventIndex(fixture.events, 'run:kubectl apply --filename');
      const runtimeSecret = eventIndex(fixture.events, 'ExternalSecret kortix-runtime did not become Ready');
      const api = eventIndex(fixture.events, 'run:helm upgrade --install kortix-api');
      const gateway = eventIndex(fixture.events, 'run:helm upgrade --install kortix-gateway');
      const edge = eventIndex(fixture.events, 'run:helm upgrade --install kortix-edge');
      const health = eventIndex(fixture.events, 'api.vpc-demo.kortix.com/v1/health');
      const commit = eventIndex(fixture.events, 'Commit Kortix enterprise release');
      expect(recovery).toBeLessThan(supabase);
      expect(supabase).toBeLessThan(terraform);
      expect(terraform).toBeLessThan(externalSecrets);
      expect(externalSecrets).toBeLessThan(runtimeSecret);
      expect(runtimeSecret).toBeLessThan(api);
      expect(fixture.events[runtimeSecret]).toContain('SECONDS + 600');
      expect(fixture.events[runtimeSecret]).toContain('jsonpath={range .status.conditions[?(@.type=="Ready")]}{.status}{end}');
      expect(fixture.events.some((event) => event.includes('kubectl --namespace kortix wait'))).toBe(false);
      expect(api).toBeLessThan(gateway);
      expect(gateway).toBeLessThan(edge);
      expect(edge).toBeLessThan(health);
      expect(health).toBeLessThan(commit);
      expect(fixture.events.some((event) => event.includes('Rollback Supabase'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('restores the previous Supabase release when a Helm deployment fails', () => {
    const fixture = installerFixture();
    fixture.runner.failOn = 'helm upgrade --install kortix-gateway';
    try {
      expect(() => fixture.installer.install(
        releaseManifest(), '/tmp/platform.tar.gz', '/tmp/supabase.tar.gz', mirroredImages(),
      )).toThrow('simulated failure');
      expect(eventIndex(fixture.events, 'Install verified Kortix enterprise release'))
        .toBeLessThan(eventIndex(fixture.events, 'helm upgrade --install kortix-gateway'));
      expect(eventIndex(fixture.events, 'helm upgrade --install kortix-gateway'))
        .toBeLessThan(eventIndex(fixture.events, 'helm uninstall kortix-api'));
      expect(eventIndex(fixture.events, 'helm uninstall kortix-api'))
        .toBeLessThan(eventIndex(fixture.events, 'Rollback Supabase after failed'));
      expect(fixture.events.some((event) => event.includes('Commit Kortix enterprise release'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('stops before any Kubernetes mutation when the Supabase SSM install command cannot start', () => {
    const fixture = installerFixture();
    fixture.aws.failComment = 'Install verified Kortix enterprise release';
    try {
      expect(() => fixture.installer.install(
        releaseManifest(), '/tmp/platform.tar.gz', '/tmp/supabase.tar.gz', mirroredImages(),
      )).toThrow('simulated SSM failure: Install verified Kortix enterprise release');
      expect(fixture.events.some((event) => event.startsWith('run:helm'))).toBe(false);
      expect(fixture.events.some((event) => event.includes('Commit Kortix enterprise release'))).toBe(false);
      expect(fixture.events.some((event) => event.includes('Rollback Supabase after failed'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('restores Supabase when immutable API health verification fails', () => {
    const fixture = installerFixture();
    fixture.runner.apiVersion = '0.9.83';
    try {
      expect(() => fixture.installer.install(
        releaseManifest(), '/tmp/platform.tar.gz', '/tmp/supabase.tar.gz', mirroredImages(),
      )).toThrow('instead of immutable prod');
      expect(eventIndex(fixture.events, 'api.vpc-demo.kortix.com/v1/health'))
        .toBeLessThan(eventIndex(fixture.events, 'helm uninstall kortix-edge'));
      expect(eventIndex(fixture.events, 'helm uninstall kortix-api'))
        .toBeLessThan(eventIndex(fixture.events, 'Rollback Supabase after failed'));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('reports both the deployment and rollback failures', () => {
    const fixture = installerFixture();
    fixture.runner.failOn = 'helm upgrade --install kortix-api';
    fixture.aws.failComment = 'Rollback Supabase';
    try {
      expect(() => fixture.installer.install(
        releaseManifest(), '/tmp/platform.tar.gz', '/tmp/supabase.tar.gz', mirroredImages(),
      )).toThrow('coordinated rollback operation(s) also failed');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('refuses unattended releases whose database migration cannot run with the prior app version', () => {
    const fixture = installerFixture();
    try {
      expect(() => fixture.installer.install(
        releaseManifest([{
          id: 'drop-old-column',
          sha256: 'd'.repeat(64),
          reversible: false,
          backward_compatible: false,
        }]),
        '/tmp/platform.tar.gz',
        '/tmp/supabase.tar.gz',
        mirroredImages(),
      )).toThrow('not safe for coordinated rollback');
      expect(fixture.events.some((event) => event.includes('Install verified Kortix enterprise release'))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith('run:helm'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('allows a reviewed non-backward-compatible baseline only on an empty first install', () => {
    const fixture = installerFixture();
    try {
      fixture.installer.install(
        releaseManifest([{
          id: 'baseline',
          sha256: 'e'.repeat(64),
          reversible: false,
          backward_compatible: false,
        }]),
        '/tmp/platform.tar.gz',
        '/tmp/supabase.tar.gz',
        mirroredImages(),
        true,
      );
      expect(fixture.events.some((event) => event.includes('Install verified Kortix enterprise release'))).toBe(true);
      expect(eventIndex(fixture.events, 'Create initial Kortix physical recovery point'))
        .toBeLessThan(eventIndex(fixture.events, 'Commit Kortix enterprise release'));
      expect(fixture.events.some((event) => event.includes('Commit Kortix enterprise release'))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('refuses to mutate an existing installation without a fresh recovery point', () => {
    const fixture = installerFixture();
    fixture.aws.backupFresh = false;
    try {
      expect(() => fixture.installer.install(
        releaseManifest(), '/tmp/platform.tar.gz', '/tmp/supabase.tar.gz', mirroredImages(),
      )).toThrow('latest WAL archive is not within 15 minutes');
      expect(fixture.events.some((event) => event.includes('Install verified Kortix enterprise release'))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith('run:helm'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
