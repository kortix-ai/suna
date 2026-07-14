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

export interface UpdaterIntent {
  release?: string;
  rollback?: string;
  force?: boolean;
}

export interface UpdaterRunResult {
  command_id: string;
  status: string;
  instance_id: string;
}

export interface DockerServiceStatus {
  service: string;
  state: string;
  health: string | null;
}

/** The one appliance host runs the whole product as Docker; discovered by tag. */
export function applianceInstanceName(instance: string): string {
  return `${instance}-appliance`;
}

/** SecureString SSM breadcrumb the on-box updater writes (source of truth for status). */
export function releaseParamName(instance: string): string {
  return `/kortix/${instance}/release`;
}

const SSM_WAIT_ATTEMPTS = 720;

export function applianceInstanceId(config: SelfHostInstanceConfig): string | null {
  const response = awsJsonOptional<{
    Reservations?: Array<{ Instances?: Array<{ InstanceId?: string; State?: { Name?: string }; PrivateIpAddress?: string; PublicIpAddress?: string }> }>;
  }>(config.aws!, [
    'ec2', 'describe-instances',
    '--filters', `Name=tag:Name,Values=${applianceInstanceName(config.instance)}`,
    'Name=instance-state-name,Values=pending,running',
  ]);
  const instance = response?.Reservations?.flatMap((entry) => entry.Instances ?? []).find((entry) => entry.InstanceId);
  return instance?.InstanceId ?? null;
}

/**
 * Run the on-box updater through SSM RunCommand. The updater binary, its release
 * pinning, and instance.env all live on the appliance host (Terraform + user-data
 * own them); the CLI only passes the deploy intent as KORTIX_DEPLOY_* env and
 * waits. No secret ever crosses the wire — the box reads Secrets Manager itself.
 */
export function runUpdaterViaSsm(config: SelfHostInstanceConfig, intent: UpdaterIntent): UpdaterRunResult {
  const coordinates = config.aws!;
  const instanceId = applianceInstanceId(config);
  if (!instanceId) {
    throw new Error(`no running appliance host found for ${config.instance}; run kortix self-host deploy first`);
  }
  const send = awsJson<{ Command?: { CommandId?: string } }>(coordinates, [
    'ssm', 'send-command', '--document-name', 'AWS-RunShellScript',
    '--instance-ids', instanceId,
    '--comment', updaterComment(intent),
    '--parameters', JSON.stringify({ commands: [updaterRunScript(intent)], executionTimeout: ['3600'] }),
  ]);
  const commandId = send.Command?.CommandId;
  if (!commandId) throw new Error('SSM did not return a command id for the updater run');
  const invocation = waitSsmCommand(coordinates, commandId, instanceId);
  if (invocation.Status !== 'Success') {
    throw new Error(
      `updater run ${invocation.Status ?? 'failed'}: ${firstLine(invocation.StandardErrorContent ?? '') || 'see kortix self-host logs updater'}`,
    );
  }
  return { command_id: commandId, status: invocation.Status ?? 'Success', instance_id: instanceId };
}

function updaterRunScript(intent: UpdaterIntent): string {
  const exports: string[] = [];
  if (intent.release) exports.push(`export KORTIX_DEPLOY_RELEASE=${shellQuote(intent.release)}`);
  if (intent.rollback) exports.push(`export KORTIX_DEPLOY_ROLLBACK=${shellQuote(intent.rollback)}`);
  if (intent.force) exports.push('export KORTIX_DEPLOY_FORCE=1');
  return [
    'set -euo pipefail',
    // The box owns every credential + release coordinate in instance.env; the CLI
    // never sees them. Source it, layer the deploy intent, run the updater.
    'set -a; . /etc/kortix/instance.env; set +a',
    ...exports,
    '/opt/kortix/bin/kortix-updater run',
  ].join('\n');
}

function updaterComment(intent: UpdaterIntent): string {
  if (intent.rollback) return `kortix updater rollback ${intent.rollback}`;
  if (intent.release) return `kortix updater deploy ${intent.release}`;
  return 'kortix updater reconcile';
}

interface SsmInvocation {
  Status?: string;
  StandardOutputContent?: string;
  StandardErrorContent?: string;
}

function waitSsmCommand(coordinates: AwsVpcCoordinates, commandId: string, instanceId: string): SsmInvocation {
  for (let attempt = 0; attempt < SSM_WAIT_ATTEMPTS; attempt++) {
    const invocation = awsJsonOptional<SsmInvocation>(coordinates, [
      'ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId,
    ]);
    const status = invocation?.Status;
    if (status && !['Pending', 'InProgress', 'Delayed', 'Cancelling'].includes(status)) return invocation!;
    spawnSync('sleep', ['5']);
  }
  throw new Error(`SSM command ${commandId} did not reach a terminal state in time; check kortix self-host status`);
}

export function readReleaseRecord(config: SelfHostInstanceConfig): ReleaseRecord | null {
  const response = awsJson<{ Parameters?: Array<{ Value?: string }> }>(config.aws!, [
    'ssm', 'get-parameters', '--names', releaseParamName(config.instance), '--with-decryption',
  ]);
  const value = response.Parameters?.[0]?.Value;
  if (!value || value === 'unset') return null;
  try {
    return JSON.parse(value) as ReleaseRecord;
  } catch {
    return null;
  }
}

/** Live container status via `docker compose ps` through SSM RunCommand. */
export function dockerPsViaSsm(config: SelfHostInstanceConfig): DockerServiceStatus[] {
  const coordinates = config.aws!;
  const instanceId = applianceInstanceId(config);
  if (!instanceId) return [];
  const send = awsJsonOptional<{ Command?: { CommandId?: string } }>(coordinates, [
    'ssm', 'send-command', '--document-name', 'AWS-RunShellScript',
    '--instance-ids', instanceId,
    '--comment', 'kortix docker ps',
    '--parameters', JSON.stringify({
      commands: ['docker compose --project-name kortix-app ps --format json 2>/dev/null || true'],
      executionTimeout: ['60'],
    }),
  ]);
  const commandId = send?.Command?.CommandId;
  if (!commandId) return [];
  const invocation = waitSsmCommand(coordinates, commandId, instanceId);
  return parseComposePs(invocation.StandardOutputContent ?? '');
}

function parseComposePs(output: string): DockerServiceStatus[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const rows: unknown[] = [];
  // Compose emits either a JSON array or newline-delimited JSON depending on version.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) rows.push(...parsed);
    else rows.push(parsed);
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      try { rows.push(JSON.parse(line)); } catch { /* skip non-JSON noise */ }
    }
  }
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map((row) => ({
      service: String(row.Service ?? row.Name ?? 'unknown'),
      state: String(row.State ?? row.Status ?? 'unknown'),
      health: typeof row.Health === 'string' && row.Health ? row.Health : null,
    }));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
