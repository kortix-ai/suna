import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { classifyEnterprisePlan } from '../../../infra/terraform/scripts/guard-enterprise-plan.ts';

import type { MirroredImage } from './artifacts.ts';
import type { AwsControlPlane } from './aws.ts';
import { requireFreshRecoveryPoint } from './execution.ts';
import type { EnterpriseReleaseManifest } from './release-contract.ts';
import type { CommandRunner } from './process.ts';

interface PlatformBundleDescriptor {
  schema_version: 1;
  kind: 'kortix-enterprise-platform';
  version: string;
  terraform_root: string;
  charts: {
    api: string;
    gateway: string;
    edge: string;
  };
  namespace: string;
  deployments: string[];
}

interface PreparedPlatformBundle {
  terraformRoot: string;
  charts: Record<keyof PlatformBundleDescriptor['charts'], string>;
}

interface PlatformImages {
  api: { repository: string; digest: string };
  gateway: { repository: string; digest: string };
  frontend: { repository: string; digest: string };
}

type PlatformReleaseName = 'kortix-api' | 'kortix-gateway' | 'kortix-edge';

interface PlatformActivation {
  namespace: string;
  env: NodeJS.ProcessEnv;
  previousRevisions: Map<PlatformReleaseName, number | null>;
  changed: PlatformReleaseName[];
}

const SSM_COMMAND_WAIT_SCRIPT = `
set -euo pipefail
command_id="$1"
instance_id="$2"
region="$3"
deadline=$((SECONDS + 1860))
while (( SECONDS < deadline )); do
  if current=$(aws ssm get-command-invocation \
    --command-id "$command_id" --instance-id "$instance_id" \
    --region "$region" --query Status --output text 2>&1); then
    case "$current" in
      Success|Cancelled|TimedOut|Failed) exit 0 ;;
      Pending|InProgress|Delayed|Cancelling) ;;
      *) printf 'Unexpected SSM command status: %s\n' "$current" >&2; exit 1 ;;
    esac
  elif [[ "$current" != *InvocationDoesNotExist* ]]; then
    printf '%s\n' "$current" >&2
    exit 1
  fi
  sleep 5
done
printf 'SSM command %s did not reach a terminal state within 31 minutes\n' "$command_id" >&2
exit 1
`;

export interface InstallerConfig {
  workDir: string;
  region: string;
  instance: string;
  expectedAccountId: string;
  applyRoleArn: string;
  clusterName: string;
  kubernetesMinor: string;
  stateBucket: string;
  stateLockTable: string;
  stateKmsKeyArn: string;
  runtimeSecretArn: string;
  supabaseInstanceId: string;
  backupBucket: string;
  backupKmsKeyArn: string;
  apiDomain: string;
  frontendDomain: string;
  certificateArn: string;
  supabasePrivateIp: string;
  appServiceAccount: string;
}

export class ReleaseInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly aws: AwsControlPlane,
    private readonly config: InstallerConfig,
  ) {}

  install(
    manifest: EnterpriseReleaseManifest,
    platformArchive: string,
    supabaseArchive: string,
    images: MirroredImage[],
    firstInstall = false,
  ): void {
    if (!manifest.compatibility.kubernetes_minor.includes(this.config.kubernetesMinor)) {
      throw new Error(`release ${manifest.version} is not compatible with Kubernetes ${this.config.kubernetesMinor}`);
    }
    if (!firstInstall && manifest.migrations.some((migration) => !migration.backward_compatible)) {
      throw new Error(`release ${manifest.version} contains a migration that is not safe for coordinated rollback`);
    }
    const platformDir = join(this.config.workDir, 'platform');
    extractVerifiedArchive(this.runner, platformArchive, platformDir);
    const descriptor = parseDescriptor(readJson(join(platformDir, 'bundle.json')), manifest.version);
    const platform = preparePlatformBundle(platformDir, descriptor);
    const platformImages: PlatformImages = {
      api: mirroredImage(images, 'api'),
      gateway: mirroredImage(images, 'gateway'),
      frontend: mirroredImage(images, 'frontend'),
    };

    if (!firstInstall) this.prepareRecoveryPoint();

    // The API chart runs database migrations as a Helm hook. Supabase must be
    // healthy before any platform release is applied, including first install.
    this.installSupabase(manifest, supabaseArchive);
    let platformActivation: PlatformActivation | null = null;
    try {
      platformActivation = this.applyPlatform(
        manifest,
        descriptor,
        platform,
        platformImages,
      );
      this.verifyHealth(manifest);
      if (firstInstall) this.createBaselineRecoveryPoint();
      this.finalizeSupabase(manifest);
    } catch (error) {
      const rollbackErrors: Error[] = [];
      if (platformActivation) {
        try {
          this.rollbackPlatform(platformActivation);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError as Error);
        }
      }
      try {
        this.rollbackSupabase(manifest);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError as Error);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error as Error, ...rollbackErrors],
          `release ${manifest.version} failed and ${rollbackErrors.length} coordinated rollback operation(s) also failed`,
        );
      }
      throw error;
    }
  }

  private applyPlatform(
    manifest: EnterpriseReleaseManifest,
    descriptor: PlatformBundleDescriptor,
    platform: PreparedPlatformBundle,
    images: PlatformImages,
  ): PlatformActivation {
    const { terraformRoot, charts } = platform;

    writeFileSync(join(terraformRoot, 'backend.hcl'), [
      `bucket         = ${JSON.stringify(this.config.stateBucket)}`,
      'key            = "enterprise/platform.tfstate"',
      `region         = ${JSON.stringify(this.config.region)}`,
      `dynamodb_table = ${JSON.stringify(this.config.stateLockTable)}`,
      'encrypt        = true',
      `kms_key_id     = ${JSON.stringify(this.config.stateKmsKeyArn)}`,
      '',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(join(terraformRoot, 'terraform.auto.tfvars.json'), `${JSON.stringify({
      aws_region: this.config.region,
      state_bucket: this.config.stateBucket,
      cluster_state_key: 'enterprise/cluster.tfstate',
      lock_table: this.config.stateLockTable,
      state_kms_key_arn: this.config.stateKmsKeyArn,
      tags: { Environment: 'enterprise', ManagedBy: 'kortix-enterprise-updater', Release: manifest.version },
    }, null, 2)}\n`, { mode: 0o600 });

    const applyEnv = this.aws.assumeRole(this.config.applyRoleArn);
    this.runner.run('terraform', [
      `-chdir=${terraformRoot}`, 'init', '-input=false', '-reconfigure', '-backend-config=backend.hcl',
    ], { env: applyEnv });
    const plan = join(terraformRoot, '.kortix.plan');
    this.runner.run('terraform', [
      `-chdir=${terraformRoot}`, 'plan', '-input=false', '-lock-timeout=5m', `-out=${plan}`,
    ], { env: applyEnv });
    const planJson = this.runner.run('terraform', [`-chdir=${terraformRoot}`, 'show', '-json', plan], {
      env: applyEnv,
    });
    const guard = classifyEnterprisePlan(JSON.parse(planJson) as Record<string, unknown>);
    if (guard.decision !== 'auto_apply') {
      throw new Error(`platform Terraform plan requires ${guard.decision}: ${guard.reasons.map((entry) => `${entry.address}: ${entry.reason}`).join('; ')}`);
    }
    this.runner.run('terraform', [`-chdir=${terraformRoot}`, 'apply', '-input=false', plan], {
      env: applyEnv,
    });

    const kubeconfig = join(this.config.workDir, 'kubeconfig');
    this.runner.run('aws', [
      'eks', 'update-kubeconfig', '--name', this.config.clusterName, '--region', this.config.region,
      '--kubeconfig', kubeconfig,
    ], { env: applyEnv });
    const kubeEnv = { ...applyEnv, KUBECONFIG: kubeconfig };
    const activation: PlatformActivation = {
      namespace: descriptor.namespace,
      env: kubeEnv,
      previousRevisions: this.readPlatformRevisions(descriptor.namespace, kubeEnv),
      changed: [],
    };
    const { api, gateway, frontend } = images;
    const common = ['--namespace', descriptor.namespace, '--atomic', '--wait', '--wait-for-jobs', '--timeout', '20m'];
    try {
      this.runner.run('helm', [
        'upgrade', '--install', 'kortix-api', charts.api, ...common,
        '--set-string', `image.repository=${api.repository}`,
        '--set-string', `image.digest=${api.digest}`,
        '--set-string', `kortixVersion=${manifest.prod.version}`,
        '--set', 'serviceAccount.create=false',
        '--set-string', `serviceAccount.name=${this.config.appServiceAccount}`,
        '--set', 'externalSecrets.enabled=false',
        '--set-string', 'externalSecrets.targetSecretName=kortix-runtime',
        '--set', 'migrate.enabled=true',
        '--set', 'ingress.enabled=false',
        '--set-string', `extraEnv.LLM_GATEWAY_BASE_URL=https://${this.config.apiDomain}/v1/llm`,
        '--set-string', 'service.annotations.alb\\.ingress\\.kubernetes\\.io/healthcheck-path=/v1/health',
        '--set-string', 'service.annotations.alb\\.ingress\\.kubernetes\\.io/success-codes=200-399',
      ], { env: kubeEnv });
      activation.changed.push('kortix-api');
      this.runner.run('helm', [
        'upgrade', '--install', 'kortix-gateway', charts.gateway, ...common,
        '--set-string', `image.repository=${gateway.repository}`,
        '--set-string', `image.digest=${gateway.digest}`,
        '--set-string', `serviceAccount.name=${this.config.appServiceAccount}`,
        '--set-string', 'envFromSecret=kortix-runtime',
        '--set', 'ingress.enabled=false',
        '--set-string', 'service.annotations.alb\\.ingress\\.kubernetes\\.io/healthcheck-path=/health/live',
        '--set-string', 'service.annotations.alb\\.ingress\\.kubernetes\\.io/success-codes=200-399',
      ], { env: kubeEnv });
      activation.changed.push('kortix-gateway');
      this.runner.run('helm', [
        'upgrade', '--install', 'kortix-edge', charts.edge, ...common,
        '--set-string', `image.repository=${frontend.repository}`,
        '--set-string', `image.digest=${frontend.digest}`,
        '--set-string', `apiDomain=${this.config.apiDomain}`,
        '--set-string', `frontendDomain=${this.config.frontendDomain}`,
        '--set-string', `certificateArn=${this.config.certificateArn}`,
        '--set-string', `supabasePrivateIp=${this.config.supabasePrivateIp}`,
        '--set-string', 'runtimeSecretName=kortix-runtime',
      ], { env: kubeEnv });
      activation.changed.push('kortix-edge');
      for (const deployment of descriptor.deployments) {
        this.runner.run('kubectl', [
          '--namespace', descriptor.namespace, 'rollout', 'status', `deployment/${deployment}`, '--timeout=15m',
        ], { env: kubeEnv });
      }
      return activation;
    } catch (error) {
      try {
        this.rollbackPlatform(activation);
      } catch (rollbackError) {
        throw new AggregateError(
          [error as Error, rollbackError as Error],
          `platform activation failed and its Helm rollback also failed`,
        );
      }
      throw error;
    }
  }

  private readPlatformRevisions(namespace: string, env: NodeJS.ProcessEnv): Map<PlatformReleaseName, number | null> {
    const names: PlatformReleaseName[] = ['kortix-api', 'kortix-gateway', 'kortix-edge'];
    const output = this.runner.run('helm', [
      'list', '--namespace', namespace, '--filter', '^(kortix-api|kortix-gateway|kortix-edge)$', '--output', 'json',
    ], { env });
    let entries: unknown;
    try {
      entries = JSON.parse(output || '[]') as unknown;
    } catch {
      throw new Error('Helm release inventory did not return JSON');
    }
    if (!Array.isArray(entries)) throw new Error('Helm release inventory must be an array');
    const revisions = new Map<PlatformReleaseName, number | null>(names.map((name) => [name, null]));
    for (const value of entries) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Helm release inventory entry is invalid');
      const entry = value as Record<string, unknown>;
      if (!names.includes(entry.name as PlatformReleaseName)) continue;
      const revision = typeof entry.revision === 'number' ? entry.revision : Number(entry.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`Helm release ${String(entry.name)} has an invalid revision`);
      revisions.set(entry.name as PlatformReleaseName, revision);
    }
    return revisions;
  }

  private rollbackPlatform(activation: PlatformActivation): void {
    const failures: Error[] = [];
    for (const release of [...activation.changed].reverse()) {
      const revision = activation.previousRevisions.get(release) ?? null;
      try {
        if (revision === null) {
          this.runner.run('helm', [
            'uninstall', release, '--namespace', activation.namespace, '--wait', '--timeout', '20m',
          ], { env: activation.env });
        } else {
          this.runner.run('helm', [
            'rollback', release, String(revision), '--namespace', activation.namespace,
            '--wait', '--wait-for-jobs', '--cleanup-on-fail', '--timeout', '20m',
          ], { env: activation.env });
        }
      } catch (error) {
        failures.push(error as Error);
      }
    }
    activation.changed.length = 0;
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} Helm rollback operation(s) failed`);
  }

  private installSupabase(manifest: EnterpriseReleaseManifest, archive: string): void {
    const key = `updater-staging/${manifest.artifacts.supabase_bundle.sha256}.tar.gz`;
    this.runner.run('aws', [
      's3', 'cp', archive, `s3://${this.config.backupBucket}/${key}`,
      '--sse', 'aws:kms', '--sse-kms-key-id', this.config.backupKmsKeyArn,
      '--region', this.config.region,
    ]);
    const script = supabaseInstallScript({
      bucket: this.config.backupBucket,
      key,
      sha256: manifest.artifacts.supabase_bundle.sha256,
      version: manifest.version,
      runtimeSecretArn: this.config.runtimeSecretArn,
      instance: this.config.instance,
      apiDomain: this.config.apiDomain,
      frontendDomain: this.config.frontendDomain,
    });
    this.runSupabaseCommand(`Install verified Kortix enterprise release ${manifest.version}`, script);
  }

  private finalizeSupabase(manifest: EnterpriseReleaseManifest): void {
    this.runSupabaseCommand(
      `Commit Kortix enterprise release ${manifest.version}`,
      supabaseFinalizeScript(manifest.version, manifest.artifacts.supabase_bundle.sha256),
    );
  }

  private rollbackSupabase(manifest: EnterpriseReleaseManifest): void {
    this.runSupabaseCommand(
      `Rollback Supabase after failed Kortix enterprise release ${manifest.version}`,
      supabaseRollbackScript(manifest.version, manifest.artifacts.supabase_bundle.sha256),
    );
  }

  private runSupabaseCommand(comment: string, script: string): void {
    const response = this.aws.awsJson<{ Command?: { CommandId?: string } }>([
      'ssm', 'send-command', '--document-name', 'AWS-RunShellScript',
      '--instance-ids', this.config.supabaseInstanceId,
      '--comment', comment,
      '--parameters', JSON.stringify({ commands: [script], executionTimeout: ['1800'] }),
    ]);
    const commandId = response.Command?.CommandId;
    if (!commandId) throw new Error('SSM did not return a command id for Supabase installation');
    this.runner.run('bash', [
      '-ceu', SSM_COMMAND_WAIT_SCRIPT, 'bash', commandId,
      this.config.supabaseInstanceId, this.config.region,
    ]);
    const result = this.aws.awsJson<{ Status?: string; StandardErrorContent?: string }>([
      'ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', this.config.supabaseInstanceId,
    ]);
    if (result.Status !== 'Success') {
      throw new Error(`Supabase installation failed through SSM: ${(result.StandardErrorContent ?? result.Status ?? 'unknown').slice(0, 500)}`);
    }
  }

  private prepareRecoveryPoint(): void {
    this.runSupabaseCommand(
      'Verify fresh Kortix recovery point before update',
      forceWalArchiveScript(),
    );
    requireFreshRecoveryPoint(this.aws.readState(), new Date());
  }

  private createBaselineRecoveryPoint(): void {
    this.runSupabaseCommand(
      'Create initial Kortix physical recovery point',
      [
        forceWalArchiveScript(),
        'systemctl start kortix-base-backup.service',
      ].join('\n'),
    );
    requireFreshRecoveryPoint(this.aws.readState(), new Date());
  }

  private verifyHealth(manifest: EnterpriseReleaseManifest): void {
    const api = this.runner.run('curl', [
      '--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2',
      `https://${this.config.apiDomain}${manifest.health.api_path}`,
    ]);
    let health: Record<string, unknown>;
    try {
      health = JSON.parse(api) as Record<string, unknown>;
    } catch {
      throw new Error('API health endpoint did not return JSON');
    }
    const version = health.version ?? health.kortix_version;
    if (version !== manifest.health.expected_version) {
      throw new Error(`API health reports ${String(version)} instead of immutable prod ${manifest.health.expected_version}`);
    }
    this.runner.run('curl', [
      '--fail', '--silent', '--show-error', '--output', '/dev/null', '--proto', '=https', '--tlsv1.2',
      `https://${this.config.frontendDomain}${manifest.health.frontend_path}`,
    ]);
  }
}

function forceWalArchiveScript(): string {
  return [
    'set -euo pipefail',
    'target=$(docker exec supabase-db sh -ceu \'PGPASSWORD="$POSTGRES_PASSWORD" exec psql --host 127.0.0.1 --username postgres --dbname postgres --tuples-only --no-align --command "checkpoint; select pg_walfile_name(pg_switch_wal());"\' | tail -n 1)',
    '[[ "$target" =~ ^[0-9A-F]{24}$ ]] || { echo "could not force a PostgreSQL WAL switch" >&2; exit 1; }',
    'archived=',
    'for _ in $(seq 1 60); do',
    '  archived=$(docker exec supabase-db sh -ceu \'PGPASSWORD="$POSTGRES_PASSWORD" exec psql --host 127.0.0.1 --username postgres --dbname postgres --tuples-only --no-align --command "select coalesce(last_archived_wal, \'\'\') from pg_stat_archiver;"\' | tr -d "[:space:]")',
    '  if [[ "$archived" = "$target" || "$archived" > "$target" ]]; then break; fi',
    '  sleep 2',
    'done',
    '[[ "$archived" = "$target" || "$archived" > "$target" ]] || { echo "PostgreSQL did not archive the forced WAL segment" >&2; exit 1; }',
    'systemctl start kortix-wal-archive.service',
    'systemctl is-active --quiet kortix-wal-archive.timer',
    'systemctl is-active --quiet kortix-base-backup.timer',
  ].join('\n');
}

function preparePlatformBundle(root: string, descriptor: PlatformBundleDescriptor): PreparedPlatformBundle {
  const terraformRoot = containedPath(root, descriptor.terraform_root);
  if (!existsSync(join(terraformRoot, 'main.tf'))) throw new Error('platform bundle Terraform root is missing main.tf');
  const charts = Object.fromEntries(Object.entries(descriptor.charts).map(([name, relative]) => {
    const path = containedPath(root, relative);
    if (!existsSync(join(path, 'Chart.yaml'))) throw new Error(`platform bundle is missing its ${name} Helm chart`);
    return [name, path];
  })) as Record<keyof PlatformBundleDescriptor['charts'], string>;
  return { terraformRoot, charts };
}

export function extractVerifiedArchive(runner: CommandRunner, archive: string, destination: string): void {
  const names = runner.run('tar', ['-tzf', archive]).split(/\r?\n/).filter(Boolean);
  if (names.length === 0) throw new Error('signed release archive is empty');
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) {
      throw new Error(`signed release archive contains unsafe path: ${name}`);
    }
  }
  const listing = runner.run('tar', ['-tvzf', archive]).split(/\r?\n/).filter(Boolean);
  if (listing.some((line) => !['-', 'd'].includes(line[0] ?? ''))) {
    throw new Error('signed release archive may contain only regular files and directories');
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  runner.run('tar', ['-xzf', archive, '--directory', destination, '--no-same-owner', '--no-same-permissions']);
}

function parseDescriptor(value: unknown, version: string): PlatformBundleDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('platform bundle descriptor must be an object');
  const descriptor = value as Record<string, unknown>;
  const exact = ['schema_version', 'kind', 'version', 'terraform_root', 'charts', 'namespace', 'deployments'];
  if (Object.keys(descriptor).some((key) => !exact.includes(key)) || exact.some((key) => !(key in descriptor))) {
    throw new Error('platform bundle descriptor fields are invalid');
  }
  if (descriptor.schema_version !== 1 || descriptor.kind !== 'kortix-enterprise-platform' || descriptor.version !== version) {
    throw new Error('platform bundle descriptor does not match the signed release');
  }
  if (typeof descriptor.terraform_root !== 'string') {
    throw new Error('platform bundle Terraform path must be a string');
  }
  if (typeof descriptor.charts !== 'object' || descriptor.charts === null || Array.isArray(descriptor.charts)) {
    throw new Error('platform bundle charts must be an object');
  }
  const charts = descriptor.charts as Record<string, unknown>;
  if (Object.keys(charts).sort().join(',') !== 'api,edge,gateway' || Object.values(charts).some((path) => typeof path !== 'string')) {
    throw new Error('platform bundle chart paths are invalid');
  }
  if (typeof descriptor.namespace !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(descriptor.namespace)) {
    throw new Error('platform bundle namespace is invalid');
  }
  if (!Array.isArray(descriptor.deployments) || descriptor.deployments.length === 0 || descriptor.deployments.some((name) => (
    typeof name !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)
  ))) throw new Error('platform bundle deployments are invalid');
  return descriptor as unknown as PlatformBundleDescriptor;
}

function containedPath(root: string, relative: string): string {
  if (relative.startsWith('/') || relative.split('/').includes('..')) throw new Error(`unsafe bundle path: ${relative}`);
  const path = resolve(root, relative);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`bundle path escapes extraction root: ${relative}`);
  return path;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`unable to read ${path}: ${(error as Error).message}`);
  }
}

function mirroredImage(images: MirroredImage[], role: MirroredImage['role']): { repository: string; digest: string } {
  const image = images.find((candidate) => candidate.role === role);
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) {
    throw new Error(`missing digest-pinned mirrored ${role} image`);
  }
  const separator = image.destination.lastIndexOf(':');
  const repository = separator > image.destination.indexOf('/') ? image.destination.slice(0, separator) : '';
  if (!repository.includes('.dkr.ecr.') || repository.includes('@')) {
    throw new Error(`mirrored ${role} destination is invalid`);
  }
  return { repository, digest: image.digest };
}

export function supabaseInstallScript(input: {
  bucket: string;
  key: string;
  sha256: string;
  version: string;
  runtimeSecretArn: string;
  instance: string;
  apiDomain: string;
  frontendDomain: string;
}): string {
  for (const value of [input.bucket, input.key, input.version, input.instance]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)) throw new Error('unsafe Supabase installation coordinate');
  }
  for (const domain of [input.apiDomain, input.frontendDomain]) {
    if (domain.length > 253 || !domain.includes('.') || domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('unsafe Supabase installation domain');
    }
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || !/^arn:[a-z0-9-]+:secretsmanager:[^:]+:\d{12}:secret:[a-zA-Z0-9/_+=.@-]+$/.test(input.runtimeSecretArn)) {
    throw new Error('unsafe Supabase digest or secret ARN');
  }
  return `set -euo pipefail
umask 077
archive=/tmp/kortix-supabase-${input.sha256}.tar.gz
staging=/opt/kortix/releases/${input.version}.staging
release_dir=/opt/kortix/releases/${input.version}
transaction=/opt/kortix/update-transactions/${input.sha256}
aws s3 cp s3://${input.bucket}/${input.key} "$archive"
echo '${input.sha256}  '"$archive" | sha256sum --check --strict
entries=$(tar -tzf "$archive")
test -n "$entries"
printf '%s\n' "$entries" | awk '{ if ($0 ~ /^\\//) exit 1; count=split($0, segments, "/"); for (part=1; part<=count; part++) if (segments[part] == "..") exit 1 }'
tar -tvzf "$archive" | awk '{ type=substr($0, 1, 1); if (type != "-" && type != "d") exit 1 }'
rm -rf "$staging"
install -d -m 0700 "$staging"
(umask 022; tar -xzf "$archive" --directory "$staging" --no-same-owner --no-same-permissions)
test -x "$staging/bin/install"
test -f "$staging/bundle.json"
"$staging/bin/install" --runtime-secret-arn '${input.runtimeSecretArn}' --release '${input.version}' --instance '${input.instance}' --api-domain '${input.apiDomain}' --frontend-domain '${input.frontendDomain}'
printf '%s\n' '${input.sha256}' >"$staging/.artifact-sha256"
if [ -e "$release_dir" ]; then
  test "$(cat "$release_dir/.artifact-sha256")" = '${input.sha256}'
  rm -rf "$staging"
else
  mv "$staging" "$release_dir"
fi
install -d -m 0700 /opt/kortix/update-transactions
previous=
if [ -L /opt/kortix/current ]; then
  previous=$(readlink -f /opt/kortix/current)
  case "$previous" in
    /opt/kortix/releases/*) ;;
    *) echo 'Unsafe previous Supabase release path' >&2; exit 1 ;;
  esac
  test -d "$previous"
fi
printf '%s\n' "$previous" >"$transaction.previous"
printf '%s\n' "$release_dir" >"$transaction.expected"
ln -sfn "$release_dir" /opt/kortix/current.new
mv -Tf /opt/kortix/current.new /opt/kortix/current
if ! systemctl restart kortix-supabase.service || ! systemctl is-active --quiet kortix-supabase.service; then
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" /opt/kortix/current.rollback
    mv -Tf /opt/kortix/current.rollback /opt/kortix/current
    systemctl restart kortix-supabase.service || true
  else
    rm -f /opt/kortix/current
  fi
  rm -f "$transaction.previous" "$transaction.expected"
  echo 'Supabase failed to start; restored the previous release' >&2
  exit 1
fi`;
}

export function supabaseFinalizeScript(version: string, sha256: string): string {
  const paths = supabaseTransactionPaths(version, sha256);
  return `set -euo pipefail
current=$(readlink -f /opt/kortix/current 2>/dev/null || true)
test "$current" = '${paths.releaseDir}'
test "$(cat '${paths.expected}')" = '${paths.releaseDir}'
rm -f '${paths.previous}' '${paths.expected}'`;
}

export function supabaseRollbackScript(version: string, sha256: string): string {
  const paths = supabaseTransactionPaths(version, sha256);
  return `set -euo pipefail
expected=$(cat '${paths.expected}')
test "$expected" = '${paths.releaseDir}'
current=$(readlink -f /opt/kortix/current 2>/dev/null || true)
test "$current" = "$expected"
previous=$(cat '${paths.previous}')
if [ -n "$previous" ]; then
  case "$previous" in
    /opt/kortix/releases/*) ;;
    *) echo 'Unsafe previous Supabase release path' >&2; exit 1 ;;
  esac
  test -d "$previous"
  ln -sfn "$previous" /opt/kortix/current.rollback
  mv -Tf /opt/kortix/current.rollback /opt/kortix/current
  systemctl restart kortix-supabase.service
  systemctl is-active --quiet kortix-supabase.service
else
  systemctl stop kortix-supabase.service || true
  rm -f /opt/kortix/current
fi
rm -f '${paths.previous}' '${paths.expected}'`;
}

function supabaseTransactionPaths(version: string, sha256: string): {
  releaseDir: string;
  previous: string;
  expected: string;
} {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-e\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('unsafe Supabase transaction coordinate');
  }
  const transaction = `/opt/kortix/update-transactions/${sha256}`;
  return {
    releaseDir: `/opt/kortix/releases/${version}`,
    previous: `${transaction}.previous`,
    expected: `${transaction}.expected`,
  };
}
