import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import type { AwsVpcCoordinates, SelfHostInstanceConfig } from './config.ts';

export interface AwsIdentity {
  UserId: string;
  Account: string;
  Arn: string;
}

export function startReconciliation(
  config: SelfHostInstanceConfig,
  input: Record<string, unknown>,
  discoveredArn?: string,
) {
  const coordinates = config.aws!;
  const stateMachineArn = discoveredArn || reconciliationStateMachineArn(config);
  const executionName = `cli-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const result = awsJson<{ executionArn: string; startDate?: string }>(coordinates, [
    'states', 'start-execution',
    '--state-machine-arn', stateMachineArn,
    '--name', executionName,
    '--input', JSON.stringify(input),
  ]);
  if (!result.executionArn) throw new Error('AWS did not return a Step Functions execution ARN');
  return {
    execution_arn: result.executionArn,
    start_date: result.startDate ?? null,
    input,
  };
}

export function releaseState(config: SelfHostInstanceConfig): Record<string, unknown> | null {
  const response = awsJsonOptional<{ Item?: Record<string, DynamoAttribute> }>(config.aws!, [
    'dynamodb', 'get-item',
    '--table-name', `${config.instance}-release-state`,
    '--key', JSON.stringify({ instance: { S: config.instance } }),
    '--consistent-read',
  ]);
  if (!response?.Item) return null;
  return Object.fromEntries(Object.entries(response.Item).map(([key, value]) => [key, fromDynamo(value)]));
}

type DynamoAttribute = { S?: string; N?: string; BOOL?: boolean; NULL?: boolean };

function fromDynamo(value: DynamoAttribute): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  return value;
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
    if (/ResourceNotFound|NotFound|does not exist|not found/i.test(detail)) return null;
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} failed: ${detail}`);
  }
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

export function reconciliationStateMachineArn(config: SelfHostInstanceConfig): string {
  const aws = config.aws!;
  return `arn:aws:states:${aws.region}:${aws.account_id}:stateMachine:${config.instance}-reconcile`;
}

export function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}
