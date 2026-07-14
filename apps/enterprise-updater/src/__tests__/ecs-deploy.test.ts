import { describe, expect, test } from 'bun:test';

import { EcsDeployer, releaseRecord, type SignedRepository } from '../ecs-deploy.ts';
import { EcsControlPlane } from '../ecs.ts';
import { parseEnterpriseReleaseManifest, type EnterpriseReleaseManifest } from '../release-contract.ts';
import { SupabaseInstaller } from '../supabase.ts';
import type { CommandRunner, RunOptions } from '../process.ts';

const INSTANCE = 'vpc-demo';
const CLUSTER = `kortix-${INSTANCE}`;
const ACCOUNT = '935064898258';
const REGION = 'us-west-2';
const RELEASE_PARAM = `/kortix/${INSTANCE}/release`;
const SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${INSTANCE}/runtime-AbCdEf`;
const OPENROUTER_SECRET = 'sk-openrouter-super-secret-value';

const REPOS = {
  api: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${INSTANCE}-api`,
  gateway: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${INSTANCE}-gateway`,
  frontend: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${INSTANCE}-frontend`,
};

const DIGESTS = {
  api: `sha256:${'a'.repeat(64)}`,
  gateway: `sha256:${'b'.repeat(64)}`,
  frontend: `sha256:${'c'.repeat(64)}`,
};
const OLD_DIGEST = `sha256:${'0'.repeat(64)}`;
const SUPABASE_SHA = 'd'.repeat(64);

type Role = 'api' | 'gateway' | 'frontend';
const ROLES: Role[] = ['api', 'gateway', 'frontend'];

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
  account?: string;
  releaseParam?: string | null;
  liveDigests?: Record<Role, string>;
  rollout?: Partial<Record<Role, string>>;
  migrateExit?: number;
  circuitBreaker?: Role[];
  secret?: Record<string, string>;
  manifest?: ReturnType<typeof manifestJson>;
}

class FakeAws implements CommandRunner {
  account: string;
  releaseParam: string | null;
  migrateExit: number;
  circuitBreaker: Set<Role>;
  secret: Record<string, string>;
  lastPutParam: string | null = null;
  calls: string[] = [];
  services: Record<Role, { taskDefinitionArn: string; rolloutState: string }>;
  taskDefs: Record<string, { containerDefinitions: Array<{ name: string; image: string }> }> = {};
  private registerCount = 0;

  constructor(scenario: Scenario) {
    this.account = scenario.account ?? ACCOUNT;
    this.releaseParam = scenario.releaseParam ?? null;
    this.migrateExit = scenario.migrateExit ?? 0;
    this.circuitBreaker = new Set(scenario.circuitBreaker ?? []);
    this.secret = scenario.secret ?? { OPENROUTER_API_KEY: OPENROUTER_SECRET, DAYTONA_API_KEY: 'daytona' };
    const digests = scenario.liveDigests ?? { api: OLD_DIGEST, gateway: OLD_DIGEST, frontend: OLD_DIGEST };
    this.services = {} as FakeAws['services'];
    for (const role of ROLES) {
      const arn = `${CLUSTER}-${role}:1`;
      this.services[role] = { taskDefinitionArn: arn, rolloutState: scenario.rollout?.[role] ?? 'COMPLETED' };
      this.taskDefs[arn] = { containerDefinitions: [{ name: role, image: `${REPOS[role]}@${digests[role]}` }] };
    }
    this.taskDefs[`${CLUSTER}-migrate`] = { containerDefinitions: [{ name: 'migrate', image: 'old-migrate' }] };
  }

  run(command: string, args: string[], _options?: RunOptions): string {
    if (command === 'sleep' || command === 'bash') return '';
    if (command === 'curl') {
      const url = args[args.length - 1] ?? '';
      return url.endsWith('/v1/health') ? JSON.stringify({ version: '0.9.84' }) : '';
    }
    if (command !== 'aws') throw new Error(`unexpected command ${command}`);
    // strip trailing --region <r> --output json
    const a = args.slice(0, args.length - 4);
    this.calls.push(a.join(' '));
    return JSON.stringify(this.handleAws(a));
  }

  private roleOfService(service: string): Role {
    return service.slice(CLUSTER.length + 1) as Role;
  }

  private handleAws(a: string[]): unknown {
    const [svc, sub] = a;
    if (svc === 'sts' && sub === 'get-caller-identity') return { Account: this.account, Arn: `arn:aws:iam::${this.account}:user/fake` };
    if (svc === 'secretsmanager' && sub === 'get-secret-value') return { SecretString: JSON.stringify(this.secret) };
    if (svc === 'ssm' && sub === 'get-parameters') {
      return this.releaseParam ? { Parameters: [{ Value: this.releaseParam }] } : { Parameters: [], InvalidParameters: [RELEASE_PARAM] };
    }
    if (svc === 'ssm' && sub === 'put-parameter') {
      this.lastPutParam = a[a.indexOf('--value') + 1] ?? null;
      return {};
    }
    if (svc === 'ssm' && sub === 'send-command') return { Command: { CommandId: 'cmd-1' } };
    if (svc === 'ssm' && sub === 'get-command-invocation') return { Status: 'Success' };
    if (svc === 's3') return {};
    if (svc === 'ecs' && sub === 'describe-services') {
      const service = a[a.indexOf('--services') + 1]!;
      const role = this.roleOfService(service);
      const state = this.services[role];
      if (!state) return { services: [], failures: [{ reason: 'MISSING' }] };
      return { services: [{ status: 'ACTIVE', taskDefinition: state.taskDefinitionArn, deployments: [{ status: 'PRIMARY', rolloutState: state.rolloutState, taskDefinition: state.taskDefinitionArn }] }] };
    }
    if (svc === 'ecs' && sub === 'describe-task-definition') {
      const arn = a[a.indexOf('--task-definition') + 1]!;
      const td = this.taskDefs[arn];
      if (!td) throw new Error(`task def ${arn} not found`);
      return { taskDefinition: td };
    }
    if (svc === 'ecs' && sub === 'register-task-definition') {
      const json = a[a.indexOf('--cli-input-json') + 1]!;
      const parsed = JSON.parse(json) as { containerDefinitions: Array<{ name: string; image: string }> };
      this.registerCount += 1;
      const arn = `registered:${this.registerCount}`;
      this.taskDefs[arn] = parsed;
      return { taskDefinition: { taskDefinitionArn: arn } };
    }
    if (svc === 'ecs' && sub === 'update-service') {
      const service = a[a.indexOf('--service') + 1]!;
      const role = this.roleOfService(service);
      const arn = a[a.indexOf('--task-definition') + 1]!;
      this.services[role] = { taskDefinitionArn: arn, rolloutState: this.circuitBreaker.has(role) ? 'FAILED' : 'COMPLETED' };
      return {};
    }
    if (svc === 'ecs' && sub === 'wait') return {};
    if (svc === 'ecs' && sub === 'run-task') return { tasks: [{ taskArn: 'task-1' }] };
    if (svc === 'ecs' && sub === 'describe-tasks') return { tasks: [{ lastStatus: 'STOPPED', containers: [{ exitCode: this.migrateExit }] }] };
    throw new Error(`unhandled aws call: ${a.join(' ')}`);
  }

  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}

function fakeRepository(manifest: ReturnType<typeof manifestJson>): SignedRepository {
  return {
    async readJsonTarget<T>() {
      return { value: manifest as unknown as T, sha256: 'e'.repeat(64), length: 1 };
    },
    async downloadArtifact(a: EnterpriseReleaseManifest['artifacts']['supabase_bundle']) {
      return `/tmp/fake/${a.sha256}`;
    },
  };
}

function makeDeployer(scenario: Scenario = {}) {
  const manifest = scenario.manifest ?? manifestJson();
  const fake = new FakeAws(scenario);
  const control = new EcsControlPlane(fake, {
    region: REGION,
    expectedAccountId: ACCOUNT,
    instance: INSTANCE,
    clusterName: CLUSTER,
    runtimeSecretArn: SECRET_ARN,
    releaseParamName: RELEASE_PARAM,
    networkConfiguration: '{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"]}}',
  });
  const supabase = new SupabaseInstaller(fake, control, {
    region: REGION,
    instance: INSTANCE,
    supabaseInstanceId: 'i-0123456789',
    runtimeSecretArn: SECRET_ARN,
    artifactBucket: `${INSTANCE}-artifacts`,
    artifactKmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/abc`,
    apiDomain: 'api.vpc-demo.kortix.com',
    frontendDomain: 'vpc-demo.kortix.com',
  });
  const deployer = new EcsDeployer({
    runner: fake,
    control,
    supabase,
    region: REGION,
    ecrRepositoriesJson: JSON.stringify(REPOS),
    apiDomain: 'api.vpc-demo.kortix.com',
    frontendDomain: 'vpc-demo.kortix.com',
    openRepository: async () => fakeRepository(manifest),
    mirrorImages: () => {},
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
  return { deployer, fake };
}

function upToDateParam(): string {
  return JSON.stringify(releaseRecord(parseEnterpriseReleaseManifest(manifestJson()), new Date('2026-07-14T00:00:00Z')));
}

describe('EcsDeployer', () => {
  test('is a no-op when the SSM breadcrumb and live ECS digests already match the manifest', async () => {
    const { deployer, fake } = makeDeployer({ releaseParam: upToDateParam(), liveDigests: DIGESTS });
    const outcome = await deployer.deploy();
    expect(outcome).toEqual({ action: 'noop', release: '0.9.84-e1', reason: 'up to date' });
    expect(fake.count('ecs register-task-definition')).toBe(0);
    expect(fake.count('ecs update-service')).toBe(0);
    expect(fake.lastPutParam).toBeNull();
  });

  test('skips when a service rollout is already IN_PROGRESS (the lease replacement)', async () => {
    const { deployer, fake } = makeDeployer({ rollout: { api: 'IN_PROGRESS' } });
    const outcome = await deployer.deploy();
    expect(outcome).toEqual({ action: 'noop', release: '0.9.84-e1', reason: 'deployment already in progress' });
    expect(fake.count('ecs update-service')).toBe(0);
  });

  test('runs a full first deploy: migrate, then api→gateway→frontend, then writes the release breadcrumb', async () => {
    const { deployer, fake } = makeDeployer({ releaseParam: null });
    const outcome = await deployer.deploy();
    expect(outcome).toEqual({ action: 'deploy', release: '0.9.84-e1' });

    // migrate registered + run before any service update
    expect(fake.count('ecs run-task')).toBe(1);
    const firstUpdate = fake.calls.findIndex((c) => c.startsWith('ecs update-service'));
    const runTaskIndex = fake.calls.findIndex((c) => c.startsWith('ecs run-task'));
    expect(runTaskIndex).toBeGreaterThanOrEqual(0);
    expect(runTaskIndex).toBeLessThan(firstUpdate);
    // 4 task defs registered (migrate + 3 services), 3 services rolled
    expect(fake.count('ecs register-task-definition')).toBe(4);
    expect(fake.count('ecs update-service')).toBe(3);

    // release param written with digests + supabase sha
    const written = JSON.parse(fake.lastPutParam!) as { version: string; digests: Record<string, string>; supabase_bundle_sha: string; deployed_at: string };
    expect(written.version).toBe('0.9.84-e1');
    expect(written.digests).toEqual(DIGESTS);
    expect(written.supabase_bundle_sha).toBe(SUPABASE_SHA);
    expect(written.deployed_at).toBe('2026-07-14T12:00:00.000Z');
  });

  test('never embeds a runtime secret value in any AWS call (valueFrom references only)', async () => {
    const { deployer, fake } = makeDeployer({ releaseParam: null });
    await deployer.deploy();
    expect(fake.calls.join('\n')).not.toContain(OPENROUTER_SECRET);
    // secrets are wired by valueFrom pointer into the runtime secret
    const register = fake.calls.find((c) => c.startsWith('ecs register-task-definition'))!;
    expect(register).toContain(`${SECRET_ARN}:OPENROUTER_API_KEY::`);
  });

  test('aborts before touching services when the migrate task exits nonzero', async () => {
    const { deployer, fake } = makeDeployer({ releaseParam: null, migrateExit: 1 });
    await expect(deployer.deploy()).rejects.toThrow('migrate task exited 1');
    expect(fake.count('ecs update-service')).toBe(0);
  });

  test('reports a circuit-breaker rollback and stops rolling later services', async () => {
    const { deployer, fake } = makeDeployer({ releaseParam: null, circuitBreaker: ['gateway'] });
    await expect(deployer.deploy()).rejects.toThrow('circuit breaker rolled back kortix-vpc-demo-gateway');
    // api rolled, gateway attempted, frontend never touched
    const updated = fake.calls.filter((c) => c.startsWith('ecs update-service'));
    expect(updated.some((c) => c.includes('kortix-vpc-demo-api'))).toBe(true);
    expect(updated.some((c) => c.includes('kortix-vpc-demo-gateway'))).toBe(true);
    expect(updated.some((c) => c.includes('kortix-vpc-demo-frontend'))).toBe(false);
    // health/breadcrumb never reached
    expect(fake.lastPutParam).toBeNull();
  });

  test('installs the Supabase bundle only when its sha changes', async () => {
    // param records the SAME supabase sha but OLD image digests → services roll, Supabase untouched
    const sameBundleParam = JSON.stringify({
      version: '0.9.83-e1', digests: { api: OLD_DIGEST, gateway: OLD_DIGEST, frontend: OLD_DIGEST },
      supabase_bundle_sha: SUPABASE_SHA, deployed_at: '2026-07-13T00:00:00Z',
    });
    const unchanged = makeDeployer({ releaseParam: sameBundleParam });
    await unchanged.deployer.deploy();
    expect(unchanged.fake.count('ssm send-command')).toBe(0);
    expect(unchanged.fake.count('ecs update-service')).toBe(3);

    // first deploy (no param) installs + finalizes the bundle
    const fresh = makeDeployer({ releaseParam: null });
    await fresh.deployer.deploy();
    expect(fresh.fake.count('ssm send-command')).toBe(2); // install + finalize
  });

  test('rolls back to a predecessor listed in rollback_from', async () => {
    const current = JSON.stringify({
      version: '0.9.85-e1', digests: DIGESTS, supabase_bundle_sha: SUPABASE_SHA, deployed_at: '2026-07-14T00:00:00Z',
    });
    const manifest = manifestJson({ version: '0.9.84-e1', rollbackFrom: ['0.9.85-e1'] });
    const { deployer } = makeDeployer({ releaseParam: current, manifest, liveDigests: DIGESTS });
    const outcome = await deployer.deploy({ rollbackTo: '0.9.84-e1' });
    expect(outcome.action).toBe('rollback');
    expect(outcome.release).toBe('0.9.84-e1');
  });

  test('refuses a rollback whose target does not list the current release in rollback_from', async () => {
    const current = JSON.stringify({
      version: '0.9.85-e1', digests: DIGESTS, supabase_bundle_sha: SUPABASE_SHA, deployed_at: '2026-07-14T00:00:00Z',
    });
    const manifest = manifestJson({ version: '0.9.84-e1', rollbackFrom: [] });
    const { deployer, fake } = makeDeployer({ releaseParam: current, manifest, liveDigests: DIGESTS });
    await expect(deployer.deploy({ rollbackTo: '0.9.84-e1' })).rejects.toThrow('does not permit rollback from 0.9.85-e1');
    expect(fake.count('ecs update-service')).toBe(0);
  });

  test('pins the customer account and refuses a mismatched identity', async () => {
    const { deployer } = makeDeployer({ account: '327903111249' });
    await expect(deployer.deploy()).rejects.toThrow('AWS account mismatch');
  });
});
