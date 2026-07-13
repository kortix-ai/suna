import { spawnSync } from 'node:child_process';
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
    release_repository_url: aws.release_repository_url,
    tuf_root_sha256: aws.tuf_root_sha256,
    updater_bootstrap_url: aws.updater_bootstrap_url,
    updater_bootstrap_sha256: aws.updater_bootstrap_sha256,
    release_publisher_account_id: aws.release_publisher_account_id,
    maintenance_window: aws.maintenance_window,
    permissions_boundary_arn: permissionsBoundaryArn,
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
  const before = terraformJson<TerraformStateIdentity>(stateDirectory, aws, ['state', 'pull']);
  assertStateIdentity(before, 'local/source');
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
  if (before.lineage !== after.lineage || before.serial !== after.serial) {
    throw new Error(
      `remote state verification failed: source ${before.lineage}/${before.serial}, remote ${after.lineage}/${after.serial}; local bootstrap state was preserved`,
    );
  }
  if (!alreadyRemote) {
    rmSync(join(stateDirectory, 'terraform.bootstrap.tfstate'), { force: true });
    rmSync(join(stateDirectory, 'terraform.bootstrap.tfstate.backup'), { force: true });
  }
  return {
    backend,
    permissionsBoundaryArn,
    verification: { verified: true, lineage: after.lineage, serial: after.serial, already_remote: alreadyRemote },
  };
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
    throw new Error(`Terraform ${args[0]} failed: ${firstLine(result.stderr || result.stdout) || `exit ${result.status}`}`);
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

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}
