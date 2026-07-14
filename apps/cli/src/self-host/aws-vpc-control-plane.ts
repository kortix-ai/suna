import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import type { AwsVpcCoordinates, SelfHostInstanceConfig } from './config.ts';

export interface AwsIdentity {
  UserId: string;
  Account: string;
  Arn: string;
}

export type DeployServiceRole = 'api' | 'gateway' | 'frontend';
export const DEPLOY_SERVICE_ROLES: DeployServiceRole[] = ['api', 'gateway', 'frontend'];

export interface ReleaseRecord {
  version?: string;
  digests?: Record<string, string>;
  supabase_bundle_sha?: string;
  deployed_at?: string;
  [key: string]: unknown;
}

/** The ECS deploy naming contract; everything is discovered from <instance>. */
export function deployClusterName(instance: string): string {
  return `kortix-${instance}`;
}

export function deployServiceName(instance: string, role: DeployServiceRole): string {
  return `${deployClusterName(instance)}-${role}`;
}

export function deployerTaskFamily(instance: string): string {
  return `${deployClusterName(instance)}-deployer`;
}

export function releaseParamName(instance: string): string {
  return `/kortix/${instance}/release`;
}

/**
 * Run the customer-owned deployer task (the slim updater binary) as a one-off ECS
 * task and wait for it. It runs the SAME ecs-deploy library the daily EventBridge
 * schedule runs — account-pinned TUF verify, digest mirror, migrate, service roll,
 * circuit-breaker rollback — inside the customer VPC on its own task role. The CLI
 * only passes the deploy intent as env overrides; the container command + release
 * repository pinning live in the Terraform-owned task definition.
 */
export function runDeployerTask(
  config: SelfHostInstanceConfig,
  intent: { release?: string; rollback?: string; force?: boolean },
): { task_arn: string; status: string; exit_code: number | null } {
  const coordinates = config.aws!;
  const cluster = deployClusterName(config.instance);
  const network = apiServiceNetworkConfiguration(config);
  const environment: Array<{ name: string; value: string }> = [];
  if (intent.release) environment.push({ name: 'KORTIX_DEPLOY_RELEASE', value: intent.release });
  if (intent.rollback) environment.push({ name: 'KORTIX_DEPLOY_ROLLBACK', value: intent.rollback });
  if (intent.force) environment.push({ name: 'KORTIX_DEPLOY_FORCE', value: '1' });

  const args = [
    'ecs', 'run-task',
    '--cluster', cluster,
    '--task-definition', deployerTaskFamily(config.instance),
    '--launch-type', 'FARGATE',
    '--count', '1',
  ];
  if (network) args.push('--network-configuration', network);
  if (environment.length > 0) {
    args.push('--overrides', JSON.stringify({ containerOverrides: [{ name: 'deployer', environment }] }));
  }
  const started = awsJson<{ tasks?: Array<{ taskArn?: string }>; failures?: Array<{ reason?: string }> }>(coordinates, args);
  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error(`deployer task did not start: ${started.failures?.[0]?.reason ?? 'unknown'}`);
  }
  return waitDeployerTask(coordinates, cluster, taskArn);
}

function waitDeployerTask(
  coordinates: AwsVpcCoordinates,
  cluster: string,
  taskArn: string,
): { task_arn: string; status: string; exit_code: number | null } {
  for (let attempt = 0; attempt < 720; attempt++) {
    const response = awsJson<{
      tasks?: Array<{ lastStatus?: string; stoppedReason?: string; containers?: Array<{ exitCode?: number }> }>;
    }>(coordinates, ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]);
    const task = response.tasks?.[0];
    if (task?.lastStatus === 'STOPPED') {
      const exitCode = task.containers?.[0]?.exitCode ?? null;
      if (exitCode !== 0) {
        throw new Error(`deployer task failed (exit ${exitCode ?? 'unknown'}): ${task.stoppedReason ?? 'see kortix self-host logs deployer'}`);
      }
      return { task_arn: taskArn, status: 'STOPPED', exit_code: exitCode };
    }
    spawnSync('sleep', ['5']);
  }
  throw new Error(`deployer task ${taskArn} did not stop in time; check kortix self-host status`);
}

function apiServiceNetworkConfiguration(config: SelfHostInstanceConfig): string | null {
  // The deployer runs in the same awsvpc network as the api service; reuse it so
  // no extra Terraform output/tag contract is needed for a one-off task.
  const response = awsJsonOptional<{ services?: Array<{ networkConfiguration?: unknown }> }>(config.aws!, [
    'ecs', 'describe-services',
    '--cluster', deployClusterName(config.instance),
    '--services', deployServiceName(config.instance, 'api'),
  ]);
  const network = response?.services?.[0]?.networkConfiguration;
  return network ? JSON.stringify(network) : null;
}

export function readReleaseRecord(config: SelfHostInstanceConfig): ReleaseRecord | null {
  const response = awsJson<{ Parameters?: Array<{ Value?: string }> }>(config.aws!, [
    'ssm', 'get-parameters', '--names', releaseParamName(config.instance),
  ]);
  const value = response.Parameters?.[0]?.Value;
  if (!value) return null;
  try {
    return JSON.parse(value) as ReleaseRecord;
  } catch {
    return null;
  }
}

export interface DeployServiceStatus {
  role: DeployServiceRole;
  status: string;
  running: number;
  desired: number;
  rollout: string | null;
}

export function describeDeployServices(config: SelfHostInstanceConfig): DeployServiceStatus[] {
  const coordinates = config.aws!;
  const services = DEPLOY_SERVICE_ROLES.map((role) => deployServiceName(config.instance, role));
  const response = awsJsonOptional<{
    services?: Array<{
      serviceName?: string;
      status?: string;
      runningCount?: number;
      desiredCount?: number;
      deployments?: Array<{ status?: string; rolloutState?: string }>;
    }>;
  }>(coordinates, [
    'ecs', 'describe-services', '--cluster', deployClusterName(config.instance), '--services', ...services,
  ]);
  const found = response?.services ?? [];
  return DEPLOY_SERVICE_ROLES.map((role) => {
    const name = deployServiceName(config.instance, role);
    const service = found.find((entry) => entry.serviceName === name);
    const primary = service?.deployments?.find((entry) => entry.status === 'PRIMARY') ?? service?.deployments?.[0];
    return {
      role,
      status: service?.status ?? 'NOT_DEPLOYED',
      running: service?.runningCount ?? 0,
      desired: service?.desiredCount ?? 0,
      rollout: primary?.rolloutState ?? null,
    };
  });
}

export function awsJson<T>(coordinates: AwsVpcCoordinates, args: string[]): T {
  const result = spawnAws(coordinates, [...args, '--output', 'json', '--no-cli-pager']);
  if (result.error) throw new Error(`unable to run AWS CLI: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} failed: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} returned invalid JSON: ${(error as Error).message}`);
  }
}

export function awsJsonOptional<T>(coordinates: AwsVpcCoordinates, args: string[]): T | null {
  const result = spawnAws(coordinates, [...args, '--output', 'json', '--no-cli-pager']);
  if (result.error) throw new Error(`unable to run AWS CLI: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = firstLine(result.stderr) || `exit ${result.status}`;
    if (/ResourceNotFound|NotFound|does not exist|not found|can't find|cannot find/i.test(detail)) return null;
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} failed: ${detail}`);
  }
  if (result.stdout.trim() === '') return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} returned invalid JSON: ${(error as Error).message}`);
  }
}

export function spawnAws(
  coordinates: AwsVpcCoordinates,
  args: string[],
  stdio?: 'inherit',
): SpawnSyncReturns<string> {
  return spawnSync(
    'aws',
    ['--profile', coordinates.profile, '--region', coordinates.region, ...args],
    stdio ? { encoding: 'utf8', stdio } : { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
}

export function awsIdentity(coordinates: AwsVpcCoordinates): AwsIdentity {
  const identity = awsJson<AwsIdentity>(coordinates, ['sts', 'get-caller-identity']);
  if (!/^\d{12}$/.test(identity.Account) || typeof identity.Arn !== 'string' || identity.Arn === '') {
    throw new Error('AWS identity response is missing a valid Account or Arn');
  }
  return identity;
}

export function verifyPinnedIdentity(coordinates: AwsVpcCoordinates): AwsIdentity {
  const identity = awsIdentity(coordinates);
  if (identity.Account !== coordinates.account_id) {
    throw new Error(`AWS account mismatch: expected ${coordinates.account_id}, resolved ${identity.Account}`);
  }
  return identity;
}

export function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}
