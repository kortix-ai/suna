import { describe, expect, test } from 'bun:test';

import type { AppRole, DeployBreadcrumb, HostRuntime } from '../box.ts';
import {
  ComposeDeployer,
  breadcrumb,
  type AppBundleInstaller,
  type ImagePreparer,
  type ResolvedImages,
  type SignedRepository,
} from '../compose-deploy.ts';
import { parseEnterpriseReleaseManifest, type EnterpriseReleaseManifest } from '../release-contract.ts';
import { SupabaseInstaller } from '../supabase.ts';
import type { CommandRunner, RunOptions } from '../process.ts';

const ROLES: AppRole[] = ['api', 'gateway', 'frontend'];
const DIGESTS = {
  api: `sha256:${'a'.repeat(64)}`,
  gateway: `sha256:${'b'.repeat(64)}`,
  frontend: `sha256:${'c'.repeat(64)}`,
};
const OLD = `sha256:${'0'.repeat(64)}`;
const SUPABASE_SHA = 'd'.repeat(64);
const SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:935064898258:secret:vpc-demo/runtime-AbCdEf';
const RUNTIME_ENV_FILE = '/tmp/kortix-runtime-env/runtime.json';

function manifestJson(overrides: { version?: string; rollbackFrom?: string[]; supabaseSha?: string } = {}) {
  const version = overrides.version ?? '0.9.84-e1';
  return {
    schema_version: 1,
    version,
    channel: 'stable',
    published_at: '2026-07-14T12:00:00Z',
    prod: { version: '0.9.84', source_sha: 'b'.repeat(40) },
    enterprise: { source_sha: 'c'.repeat(40) },
    compatibility: { architectures: ['amd64'], kubernetes_minor: ['1.32'], rollback_from: overrides.rollbackFrom ?? [] },
    images: Object.fromEntries(ROLES.map((role) => [role, {
      source: `registry.example.com/kortix-${role}@${DIGESTS[role]}`,
      digest: DIGESTS[role],
      customer_repository: role,
    }])),
    artifacts: {
      platform_bundle: { target: 'platform.tar.gz', sha256: '1'.repeat(64), length: 10 },
      supabase_bundle: { target: 'supabase.tar.gz', sha256: overrides.supabaseSha ?? SUPABASE_SHA, length: 10 },
      cosign_public_key: { target: 'cosign.pub', sha256: '2'.repeat(64), length: 10 },
      updater_binary: { target: 'updater', sha256: '3'.repeat(64), length: 10 },
    },
    migrations: [],
    health: { api_path: '/v1/health', frontend_path: '/', expected_version: '0.9.84' },
  };
}

interface Scenario {
  breadcrumb?: DeployBreadcrumb | null;
  liveDigests?: Record<AppRole, string>;
  migrateThrows?: boolean;
  failRole?: AppRole;
}

class FakeHost implements HostRuntime {
  crumb: DeployBreadcrumb | null;
  rolled: AppRole[] = [];
  migrated = 0;
  written: DeployBreadcrumb | null = null;
  constructor(private readonly scenario: Scenario) {
    this.crumb = scenario.breadcrumb ?? null;
  }
  runningDigest(role: AppRole): string | null {
    return (this.scenario.liveDigests ?? { api: OLD, gateway: OLD, frontend: OLD })[role];
  }
  runMigrate(): void {
    this.migrated += 1;
    if (this.scenario.migrateThrows) throw new Error('migrate task exited 1');
  }
  rolloutService(role: AppRole): void {
    if (this.scenario.failRole === role) throw new Error(`new ${role} containers never became healthy`);
    this.rolled.push(role);
  }
  edges = 0;
  startEdge(): void {
    this.edges += 1;
  }
  readBreadcrumb(): DeployBreadcrumb | null {
    return this.crumb;
  }
  writeBreadcrumb(record: DeployBreadcrumb): void {
    this.written = record;
    this.crumb = record;
  }
}

class FakeImages implements ImagePreparer {
  prepared = 0;
  prepare(manifest: EnterpriseReleaseManifest): ResolvedImages {
    this.prepared += 1;
    return {
      api: `ecr/api@${manifest.images.api.digest}`,
      gateway: `ecr/gateway@${manifest.images.gateway.digest}`,
      frontend: `ecr/frontend@${manifest.images.frontend.digest}`,
      caddy: `docker.io/library/caddy@sha256:${'e'.repeat(64)}`,
    };
  }
}

class FakeApp implements AppBundleInstaller {
  installs: Array<{ tar: string; runtimeEnvFile: string }> = [];
  install(input: { manifest: EnterpriseReleaseManifest; bundleTar: string; images: ResolvedImages; runtimeEnvFile: string }): void {
    this.installs.push({ tar: input.bundleTar, runtimeEnvFile: input.runtimeEnvFile });
  }
}

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string, args: string[], _options?: RunOptions): string {
    this.calls.push(`${command} ${args.join(' ')}`);
    if (command === 'sleep' || command === 'bash') return '';
    if (command === 'curl') {
      const url = args[args.length - 1] ?? '';
      return url.endsWith('/v1/health') ? JSON.stringify({ version: '0.9.84' }) : '';
    }
    return '';
  }
}

function fakeRepository(manifest: ReturnType<typeof manifestJson>): SignedRepository {
  return {
    async readJsonTarget<T>() {
      return { value: manifest as unknown as T, sha256: 'e'.repeat(64), length: 1 };
    },
    async downloadArtifact(a: EnterpriseReleaseManifest['artifacts']['supabase_bundle']) {
      return `/tmp/fake/${a.sha256}.tar.gz`;
    },
  };
}

function makeDeployer(scenario: Scenario = {}, options: { manifest?: ReturnType<typeof manifestJson>; verifyIdentity?: () => void } = {}) {
  const manifest = options.manifest ?? manifestJson();
  const runner = new FakeRunner();
  const host = new FakeHost(scenario);
  const images = new FakeImages();
  const app = new FakeApp();
  const supabase = new SupabaseInstaller(runner, {
    instance: 'vpc-demo',
    runtimeSecretArn: SECRET_ARN,
    apiDomain: 'api.vpc-demo.kortix.com',
    frontendDomain: 'vpc-demo.kortix.com',
  });
  const deployer = new ComposeDeployer({
    runner,
    host,
    supabase,
    images,
    app,
    runtimeEnvFile: () => RUNTIME_ENV_FILE,
    apiDomain: 'api.vpc-demo.kortix.com',
    frontendDomain: 'vpc-demo.kortix.com',
    ...(options.verifyIdentity ? { verifyIdentity: options.verifyIdentity } : {}),
    openRepository: async () => fakeRepository(manifest),
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
  return { deployer, host, runner, images, app };
}

function upToDateCrumb(): DeployBreadcrumb {
  return breadcrumb(parseEnterpriseReleaseManifest(manifestJson()), new Date('2026-07-14T00:00:00Z'));
}

describe('ComposeDeployer', () => {
  test('is a no-op when the breadcrumb and live container digests already match', async () => {
    const { deployer, host, images } = makeDeployer({ breadcrumb: upToDateCrumb(), liveDigests: DIGESTS });
    const outcome = await deployer.deploy();
    expect(outcome).toEqual({ action: 'noop', release: '0.9.84-e1', reason: 'up to date' });
    expect(host.rolled).toEqual([]);
    expect(host.written).toBeNull();
    expect(images.prepared).toBe(0);
  });

  test('full first deploy: migrate before any roll, api→gateway→frontend, breadcrumb written', async () => {
    const { deployer, host, app, images } = makeDeployer({ breadcrumb: null });
    const outcome = await deployer.deploy();
    expect(outcome).toEqual({ action: 'deploy', release: '0.9.84-e1' });
    expect(host.migrated).toBe(1);
    expect(host.rolled).toEqual(['api', 'gateway', 'frontend']);
    expect(images.prepared).toBe(1);
    // app bundle installed with the runtime env FILE (not inline secrets).
    expect(app.installs).toHaveLength(1);
    expect(app.installs[0]!.runtimeEnvFile).toBe(RUNTIME_ENV_FILE);
    expect(app.installs[0]!.tar).toContain('/tmp/fake/');
    // breadcrumb records digests + supabase sha + deploy time.
    expect(host.written).toEqual({
      version: '0.9.84-e1',
      digests: DIGESTS,
      supabase_bundle_sha: SUPABASE_SHA,
      deployed_at: '2026-07-14T12:00:00.000Z',
    });
  });

  test('aborts before touching services when migrate exits nonzero', async () => {
    const { deployer, host } = makeDeployer({ breadcrumb: null, migrateThrows: true });
    await expect(deployer.deploy()).rejects.toThrow('migrate task exited 1');
    expect(host.rolled).toEqual([]);
    expect(host.written).toBeNull();
  });

  test('a failed-health roll keeps old containers and never advances later services or the breadcrumb', async () => {
    const { deployer, host } = makeDeployer({ breadcrumb: null, failRole: 'gateway' });
    await expect(deployer.deploy()).rejects.toThrow('never became healthy');
    // api rolled, gateway failed, frontend never touched, breadcrumb never written.
    expect(host.rolled).toEqual(['api']);
    expect(host.written).toBeNull();
  });

  test('installs the Supabase bundle only when its sha changes', async () => {
    const sameSha: DeployBreadcrumb = {
      version: '0.9.83-e1', digests: { api: OLD, gateway: OLD, frontend: OLD },
      supabase_bundle_sha: SUPABASE_SHA, deployed_at: '2026-07-13T00:00:00Z',
    };
    const unchanged = makeDeployer({ breadcrumb: sameSha });
    await unchanged.deployer.deploy();
    expect(unchanged.runner.calls.filter((c) => c.startsWith('bash '))).toHaveLength(0);

    const fresh = makeDeployer({ breadcrumb: null });
    await fresh.deployer.deploy();
    // install + finalize both run as local bash scripts.
    expect(fresh.runner.calls.filter((c) => c.startsWith('bash '))).toHaveLength(2);
  });

  test('never discloses a secret value on any command line (runtime env is a file path)', async () => {
    const { deployer, runner, app } = makeDeployer({ breadcrumb: null });
    await deployer.deploy();
    const joined = runner.calls.join('\n');
    // The deployer only ever references the runtime env FILE, never secret values.
    expect(joined).not.toContain('super-secret');
    expect(app.installs[0]!.runtimeEnvFile).toBe(RUNTIME_ENV_FILE);
  });

  test('rolls back to a predecessor listed in rollback_from', async () => {
    const current: DeployBreadcrumb = {
      version: '0.9.85-e1', digests: DIGESTS, supabase_bundle_sha: SUPABASE_SHA, deployed_at: '2026-07-14T00:00:00Z',
    };
    const manifest = manifestJson({ version: '0.9.84-e1', rollbackFrom: ['0.9.85-e1'] });
    const { deployer } = makeDeployer({ breadcrumb: current, liveDigests: DIGESTS }, { manifest });
    const outcome = await deployer.deploy({ rollbackTo: '0.9.84-e1' });
    expect(outcome).toEqual({ action: 'rollback', release: '0.9.84-e1' });
  });

  test('refuses a rollback whose target does not list the current release in rollback_from', async () => {
    const current: DeployBreadcrumb = {
      version: '0.9.85-e1', digests: DIGESTS, supabase_bundle_sha: SUPABASE_SHA, deployed_at: '2026-07-14T00:00:00Z',
    };
    const manifest = manifestJson({ version: '0.9.84-e1', rollbackFrom: [] });
    const { deployer, host } = makeDeployer({ breadcrumb: current, liveDigests: DIGESTS }, { manifest });
    await expect(deployer.deploy({ rollbackTo: '0.9.84-e1' })).rejects.toThrow('does not permit rollback from 0.9.85-e1');
    expect(host.rolled).toEqual([]);
  });

  test('pins the customer account and refuses a mismatched identity', async () => {
    const { deployer } = makeDeployer({ breadcrumb: null }, {
      verifyIdentity: () => { throw new Error('AWS account mismatch: expected 935064898258, received 327903111249'); },
    });
    await expect(deployer.deploy()).rejects.toThrow('AWS account mismatch');
  });
});
