import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyEnterprisePlan,
  type GuardResult,
} from '../../../../infra/terraform/scripts/guard-enterprise-plan.ts';
import type { AwsVpcCoordinates } from './config.ts';
import {
  enterpriseTerraformRoot,
  LOCAL_STATE_BACKEND,
  REMOTE_STATE_BACKEND,
  stateBackendPath,
  writeEnterpriseTerraformAssets,
} from './enterprise-assets.ts';
import type { CompleteAwsVpcConfig } from './aws-vpc-settings.ts';

interface TerraformStateIdentity {
  lineage: string;
  serial: number;
  [key: string]: unknown;
}

export interface BackendConfig {
  bucket: string;
  dynamodb_table: string;
  region: string;
  encrypt: boolean;
  kms_key_id: string;
}

export interface EnterpriseInstanceOutput {
  cluster_name?: string;
  state_machine_arn?: string;
  release_state_table?: string;
  supabase_instance_id?: string;
  supabase_private_ip?: string;
  runtime_secret_arn?: string;
  [key: string]: unknown;
}

export interface StagePlan extends GuardResult {
  name: 'state' | 'cluster';
  planPath: string;
}

export function prepareTerraform(instance: string, aws: CompleteAwsVpcConfig) {
  const root = writeEnterpriseTerraformAssets(instance);
  const state = join(root, 'environments', 'enterprise-vpc', 'state');
  const cluster = join(root, 'environments', 'enterprise-vpc', 'cluster');
  writeJson(join(state, 'terraform.auto.tfvars.json'), {
    aws_region: aws.region,
    name: instance,
    expected_account_id: aws.account_id,
    state_bucket_name: stateBucketName(instance, aws),
    lock_table_name: `${instance}-terraform-locks`,
    tags: { Environment: 'enterprise', ManagedBy: 'kortix-self-host' },
  });
  return { root, state, cluster };
}

export function writeClusterFiles(
  instance: string,
  aws: CompleteAwsVpcConfig,
  permissionsBoundaryArn: string,
  backend: BackendConfig,
): void {
  const cluster = join(enterpriseTerraformRoot(instance), 'environments', 'enterprise-vpc', 'cluster');
  writeBackendConfig(join(cluster, 'backend.hcl'), backend, 'enterprise/cluster.tfstate');
  writeJson(join(cluster, 'terraform.auto.tfvars.json'), {
    aws_region: aws.region,
    name: instance,
    expected_account_id: aws.account_id,
    vpc_cidr: aws.vpc_cidr,
    api_domain: aws.api_domain,
    frontend_domain: aws.frontend_domain,
    route53_zone_id: aws.route53_zone_id,
    release_repository_url: aws.release_repository_url,
    tuf_root_sha256: aws.tuf_root_sha256,
    updater_bootstrap_url: aws.updater_bootstrap_url,
    updater_bootstrap_sha256: aws.updater_bootstrap_sha256,
    release_publisher_account_id: aws.release_publisher_account_id,
    maintenance_window: aws.maintenance_window,
    permissions_boundary_arn: permissionsBoundaryArn,
    terraform_state_bucket: backend.bucket,
    terraform_state_lock_table: backend.dynamodb_table,
    terraform_state_kms_key_arn: backend.kms_key_id,
    tags: { Environment: 'enterprise', ManagedBy: 'kortix-self-host' },
  });
}

export function terraformPlan(
  name: 'state' | 'cluster',
  directory: string,
  aws: CompleteAwsVpcConfig,
  backendConfig?: string,
): StagePlan {
  const initArgs = ['init', '-input=false'];
  if (backendConfig) initArgs.push('-reconfigure', `-backend-config=${backendConfig}`);
  terraform(directory, aws, initArgs);
  const planPath = join(directory, '.kortix.plan');
  terraform(directory, aws, ['plan', '-input=false', '-lock-timeout=5m', `-out=${planPath}`]);
  const plan = terraformJson<Record<string, unknown>>(directory, aws, ['show', '-json', planPath]);
  return { name, planPath, ...classifyEnterprisePlan(plan) };
}

export function terraformApply(directory: string, aws: CompleteAwsVpcConfig, planPath: string): void {
  terraform(directory, aws, ['apply', '-input=false', planPath]);
}

export function migrateAndVerifyState(
  instance: string,
  stateDirectory: string,
  aws: CompleteAwsVpcConfig,
  alreadyRemote: boolean,
) {
  const bootstrapPath = join(stateDirectory, 'terraform.bootstrap.tfstate');
  const before = alreadyRemote && existsSync(bootstrapPath)
    ? readStateFile(bootstrapPath, 'preserved local bootstrap')
    : terraformJson<TerraformStateIdentity>(stateDirectory, aws, ['state', 'pull']);
  assertStateIdentity(before, alreadyRemote ? 'preserved local bootstrap/remote source' : 'local/source');
  const backend = terraformOutput<BackendConfig>(stateDirectory, aws, 'backend_config');
  const permissionsBoundaryArn = terraformOutput<string>(stateDirectory, aws, 'permissions_boundary_arn');
  const backendPath = join(stateDirectory, 'backend.hcl');
  writeBackendConfig(backendPath, backend, 'enterprise/state.tfstate');

  if (!alreadyRemote) {
    writeFileSync(stateBackendPath(instance), REMOTE_STATE_BACKEND, { encoding: 'utf8', mode: 0o644 });
    chmodSync(stateBackendPath(instance), 0o644);
    try {
      terraform(stateDirectory, aws, [
        'init', '-input=false', '-migrate-state', '-force-copy', `-backend-config=${backendPath}`,
      ]);
    } catch (error) {
      // Do not let a retry silently reconfigure against an empty remote state.
      writeFileSync(stateBackendPath(instance), LOCAL_STATE_BACKEND, { encoding: 'utf8', mode: 0o644 });
      chmodSync(stateBackendPath(instance), 0o644);
      throw new Error(`Terraform state migration did not complete; local bootstrap state was preserved: ${(error as Error).message}`);
    }
  }

  const after = terraformJson<TerraformStateIdentity>(stateDirectory, aws, ['state', 'pull']);
  assertStateIdentity(after, 'remote');
  const beforeDigest = stateContentDigest(before);
  const afterDigest = stateContentDigest(after);
  const beforeObjects = stateObjectDigest(before);
  const afterObjects = stateObjectDigest(after);
  const exactMatch = beforeDigest === afterDigest;
  const refreshedRecoveryMatch = alreadyRemote && beforeObjects === afterObjects;
  if (!exactMatch && !refreshedRecoveryMatch) {
    throw new Error(
      `remote state verification failed: source ${before.lineage}/${before.serial} (${beforeDigest}/${beforeObjects}), remote ${after.lineage}/${after.serial} (${afterDigest}/${afterObjects}); local bootstrap state was preserved`,
    );
  }
  if (!alreadyRemote || existsSync(bootstrapPath)) {
    rmSync(bootstrapPath, { force: true });
    rmSync(join(stateDirectory, 'terraform.bootstrap.tfstate.backup'), { force: true });
  }
  return {
    backend,
    permissionsBoundaryArn,
    verification: {
      verified: true,
      lineage: after.lineage,
      serial: after.serial,
      already_remote: alreadyRemote,
      verification_mode: exactMatch ? 'exact-content' : 'refreshed-object-identity',
    },
  };
}

function readStateFile(path: string, label: string): TerraformStateIdentity {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TerraformStateIdentity;
  } catch (error) {
    throw new Error(`${label} Terraform state is invalid JSON: ${(error as Error).message}`);
  }
}

function stateContentDigest(state: TerraformStateIdentity): string {
  const content: Record<string, unknown> = { ...state };
  delete content.lineage;
  delete content.serial;
  if (Array.isArray(content.check_results)) {
    content.check_results = [...content.check_results]
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  }
  return digestJson(content);
}

/**
 * Recovery-only projection for a state that Terraform already migrated and
 * subsequently refreshed against the provider. Refresh may fill computed
 * attributes (for example an S3 bucket's versioning/policy) and advance the
 * backend serial, while the tracked object graph remains the same. The state
 * stage has just been planned, guarded, and applied before this check, so a
 * recovery is accepted only when every resource instance identity and every
 * output still match the preserved bootstrap state.
 */
function stateObjectDigest(state: TerraformStateIdentity): string {
  const resources = Array.isArray(state.resources)
    ? state.resources.map(projectResourceIdentity).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
    : state.resources;
  return digestJson({ outputs: state.outputs, resources });
}

function projectResourceIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const resource = value as Record<string, unknown>;
  const instances = Array.isArray(resource.instances)
    ? resource.instances.map(projectInstanceIdentity).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
    : resource.instances;
  return {
    module: resource.module,
    mode: resource.mode,
    type: resource.type,
    name: resource.name,
    provider: resource.provider,
    instances,
  };
}

function projectInstanceIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const instance = value as Record<string, unknown>;
  const attributes = instance.attributes && typeof instance.attributes === 'object' && !Array.isArray(instance.attributes)
    ? instance.attributes as Record<string, unknown>
    : {};
  const identity: Record<string, unknown> = {};
  for (const key of ['id', 'arn', 'name', 'bucket', 'key_id', 'alias_name', 'table_name']) {
    if (Object.hasOwn(attributes, key)) identity[key] = attributes[key];
  }
  return {
    index_key: instance.index_key,
    schema_version: instance.schema_version,
    identity,
  };
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function terraformOutput<T>(directory: string, aws: CompleteAwsVpcConfig, name: string): T {
  return terraformJson<T>(directory, aws, ['output', '-json', name]);
}

export function readBackendConfig(path: string): BackendConfig {
  const content = readFileSync(path, 'utf8');
  const readString = (key: string): string => {
    const match = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`, 'm').exec(content);
    if (!match) throw new Error(`backend config is missing ${key}`);
    return JSON.parse(match[1]) as string;
  };
  return {
    bucket: readString('bucket'),
    dynamodb_table: readString('dynamodb_table'),
    region: readString('region'),
    encrypt: /^encrypt\s*=\s*true$/m.test(content),
    kms_key_id: readString('kms_key_id'),
  };
}

export function isRemoteState(instance: string): boolean {
  const path = stateBackendPath(instance);
  return existsSync(path) && readFileSync(path, 'utf8').includes('backend "s3"');
}

export function ensureApplicable(plan: StagePlan): void {
  if (plan.decision === 'blocked') {
    throw new Error(`${plan.name} Terraform plan is blocked: ${plan.reasons.map((reason) => reason.reason).join('; ')}`);
  }
}

export function publicPlan(plan: StagePlan) {
  return { name: plan.name, decision: plan.decision, summary: plan.summary, reasons: plan.reasons };
}

function terraformJson<T>(directory: string, aws: CompleteAwsVpcConfig, args: string[]): T {
  const output = terraform(directory, aws, args);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`Terraform returned invalid JSON for ${args.join(' ')}: ${(error as Error).message}`);
  }
}

function terraform(directory: string, aws: CompleteAwsVpcConfig, args: string[]): string {
  const result = spawnSync('terraform', [`-chdir=${directory}`, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AWS_PROFILE: aws.profile,
      AWS_REGION: aws.region,
      AWS_DEFAULT_REGION: aws.region,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`unable to run Terraform: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Terraform ${args[0]} failed: ${terraformDiagnostic(result.stderr || result.stdout) || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function stateBucketName(instance: string, aws: AwsVpcCoordinates): string {
  const suffix = `-${aws.account_id}-${aws.region}-tfstate`;
  return `${instance.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeBackendConfig(path: string, backend: BackendConfig, key: string): void {
  const content = [
    `bucket         = ${JSON.stringify(backend.bucket)}`,
    `key            = ${JSON.stringify(key)}`,
    `region         = ${JSON.stringify(backend.region)}`,
    `dynamodb_table = ${JSON.stringify(backend.dynamodb_table)}`,
    `encrypt        = ${backend.encrypt ? 'true' : 'false'}`,
    `kms_key_id     = ${JSON.stringify(backend.kms_key_id)}`,
    '',
  ].join('\n');
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function assertStateIdentity(state: TerraformStateIdentity, label: string): void {
  if (!state || typeof state.lineage !== 'string' || !Number.isInteger(state.serial)) {
    throw new Error(`${label} Terraform state is missing lineage or serial`);
  }
}

function terraformDiagnostic(value: string): string {
  const lines = value
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[│|]\s?/, '').trim())
    .filter((line) => line !== '' && !/^[╷╵─]+$/.test(line));
  return lines.find((line) => line.startsWith('Error:')) ?? lines[0] ?? '';
}
