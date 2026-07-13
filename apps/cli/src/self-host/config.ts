import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type SelfHostTarget = 'docker' | 'aws-vpc';

export interface AwsVpcCoordinates {
  profile: string;
  region: string;
  account_id: string;
}

export interface SelfHostInstanceConfig {
  schema_version: 1;
  instance: string;
  target: SelfHostTarget;
  channel: string;
  release?: string;
  aws?: AwsVpcCoordinates;
}

const INSTANCE_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const TOP_LEVEL_FIELDS = new Set(['schema_version', 'instance', 'target', 'channel', 'release', 'aws']);
const AWS_FIELDS = new Set(['profile', 'region', 'account_id']);

export function selfHostConfigRoot(): string {
  const override = process.env.KORTIX_SELF_HOST_CONFIG_DIR?.trim();
  return override ? resolve(override) : resolve(homedir(), '.config', 'kortix', 'self-host');
}

export function instanceDir(instance: string): string {
  assertInstanceName(instance);
  return join(selfHostConfigRoot(), instance);
}

export function instanceConfigPath(instance: string): string {
  return join(instanceDir(instance), 'instance.json');
}

export function loadInstanceConfig(instance: string): SelfHostInstanceConfig | null {
  const path = instanceConfigPath(instance);
  if (!existsSync(path)) {
    // Before target-aware self-hosting, Docker instances persisted only a .env
    // and generated Compose assets. Treat that layout as the Docker adapter so
    // every existing install remains usable without a migration command.
    if (existsSync(join(instanceDir(instance), '.env'))) {
      return {
        schema_version: 1,
        instance,
        target: 'docker',
        channel: 'latest',
      };
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid self-host instance config at ${path}: ${(error as Error).message}`);
  }
  return validateInstanceConfig(parsed, instance);
}

export function writeInstanceConfig(config: SelfHostInstanceConfig): void {
  const validated = validateInstanceConfig(config, config.instance);
  const dir = instanceDir(validated.instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = instanceConfigPath(validated.instance);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

export function resolveInstanceTarget(instance: string, requested?: SelfHostTarget): SelfHostTarget {
  const configured = loadInstanceConfig(instance);
  if (requested && configured && requested !== configured.target) {
    throw new Error(
      `instance "${instance}" targets ${configured.target}; create a different instance to use ${requested}`,
    );
  }
  return requested ?? configured?.target ?? 'docker';
}

export function parseSelfHostTarget(value: string | undefined): SelfHostTarget | undefined {
  if (value === undefined) return undefined;
  if (value === 'docker' || value === 'aws-vpc') return value;
  throw new Error(`target must be "docker" or "aws-vpc", got "${value}"`);
}

function validateInstanceConfig(value: unknown, expectedInstance: string): SelfHostInstanceConfig {
  if (!isRecord(value)) throw new Error('self-host instance config must be a JSON object');
  rejectUnknownFields(value, TOP_LEVEL_FIELDS);

  if (value.schema_version !== 1) throw new Error('self-host instance config schema_version must be 1');
  if (value.instance !== expectedInstance) {
    throw new Error(`self-host instance config belongs to "${String(value.instance)}", expected "${expectedInstance}"`);
  }
  assertInstanceName(expectedInstance);

  const target = parseSelfHostTarget(asRequiredString(value.target, 'target'))!;
  const channel = asRequiredString(value.channel, 'channel');
  if (!/^[a-zA-Z0-9._-]+$/.test(channel)) {
    throw new Error('channel may contain only letters, digits, dots, underscores, or dashes');
  }

  const release = optionalString(value.release, 'release');
  let aws: AwsVpcCoordinates | undefined;
  if (target === 'aws-vpc') {
    if (!isRecord(value.aws)) throw new Error('aws-vpc instance config requires aws coordinates');
    rejectUnknownFields(value.aws, AWS_FIELDS, 'aws.');
    const profile = asRequiredString(value.aws.profile, 'aws.profile');
    const region = asRequiredString(value.aws.region, 'aws.region');
    const accountId = asRequiredString(value.aws.account_id, 'aws.account_id');
    if (!REGION_PATTERN.test(region)) throw new Error(`invalid aws.region "${region}"`);
    if (!/^\d{12}$/.test(accountId)) throw new Error('aws.account_id must be a 12-digit AWS account ID');
    aws = { profile, region, account_id: accountId };
  } else if (value.aws !== undefined) {
    throw new Error('Docker instance config must not contain aws coordinates');
  }

  return {
    schema_version: 1,
    instance: expectedInstance,
    target,
    channel,
    ...(release ? { release } : {}),
    ...(aws ? { aws } : {}),
  };
}

function assertInstanceName(instance: string): void {
  if (!INSTANCE_PATTERN.test(instance)) {
    throw new Error('instance must start with a letter and contain only letters, digits, dots, underscores, or dashes');
  }
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, prefix = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported field "${prefix}${key}" in self-host instance config`);
  }
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asRequiredString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
