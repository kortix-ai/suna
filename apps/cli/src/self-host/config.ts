import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type SelfHostTarget = 'docker' | 'aws-ec2';

export interface AwsVpcCoordinates {
  profile: string;
  region: string;
  account_id: string;
  vpc_cidr?: string;
  api_domain?: string;
  frontend_domain?: string;
  route53_zone_id?: string;
  release_repository_url?: string;
  tuf_root_sha256?: string;
  updater_bootstrap_url?: string;
  updater_bootstrap_sha256?: string;
  release_publisher_account_id?: string;
  maintenance_window?: string;
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
const AWS_FIELDS = new Set([
  'profile',
  'region',
  'account_id',
  'vpc_cidr',
  'api_domain',
  'frontend_domain',
  'route53_zone_id',
  'release_repository_url',
  'tuf_root_sha256',
  'updater_bootstrap_url',
  'updater_bootstrap_sha256',
  'release_publisher_account_id',
  'maintenance_window',
]);

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
  if (value === 'docker' || value === 'aws-ec2') return value;
  // Backward compatibility: the AWS target used to be called "aws-vpc". Existing
  // instance configs on disk (and any scripts) may still say it; accept it and
  // normalize to the current "aws-ec2" name. We only ever WRITE "aws-ec2".
  if (value === 'aws-vpc') return 'aws-ec2';
  throw new Error(`target must be "docker" or "aws-ec2", got "${value}"`);
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
  if (target === 'aws-ec2') assertAwsVpcInstanceName(expectedInstance);
  const channel = asRequiredString(value.channel, 'channel');
  if (!/^[a-zA-Z0-9._-]+$/.test(channel)) {
    throw new Error('channel may contain only letters, digits, dots, underscores, or dashes');
  }
  if (target === 'aws-ec2' && channel !== 'stable') {
    throw new Error('AWS EC2 instances may only track the stable channel');
  }

  const release = optionalString(value.release, 'release');
  let aws: AwsVpcCoordinates | undefined;
  if (target === 'aws-ec2') {
    if (!isRecord(value.aws)) throw new Error('aws-ec2 instance config requires aws coordinates');
    rejectUnknownFields(value.aws, AWS_FIELDS, 'aws.');
    const profile = asRequiredString(value.aws.profile, 'aws.profile');
    const region = asRequiredString(value.aws.region, 'aws.region');
    const accountId = asRequiredString(value.aws.account_id, 'aws.account_id');
    if (!REGION_PATTERN.test(region)) throw new Error(`invalid aws.region "${region}"`);
    if (!/^\d{12}$/.test(accountId)) throw new Error('aws.account_id must be a 12-digit AWS account ID');
    const vpcCidr = optionalString(value.aws.vpc_cidr, 'aws.vpc_cidr');
    const apiDomain = optionalString(value.aws.api_domain, 'aws.api_domain');
    const frontendDomain = optionalString(value.aws.frontend_domain, 'aws.frontend_domain');
    const route53ZoneId = optionalString(value.aws.route53_zone_id, 'aws.route53_zone_id');
    const releaseRepositoryUrl = optionalString(value.aws.release_repository_url, 'aws.release_repository_url');
    const tufRootSha256 = optionalString(value.aws.tuf_root_sha256, 'aws.tuf_root_sha256');
    const updaterBootstrapUrl = optionalString(value.aws.updater_bootstrap_url, 'aws.updater_bootstrap_url');
    const updaterBootstrapSha256 = optionalString(value.aws.updater_bootstrap_sha256, 'aws.updater_bootstrap_sha256');
    const releasePublisherAccountId = optionalString(
      value.aws.release_publisher_account_id,
      'aws.release_publisher_account_id',
    );
    const maintenanceWindow = optionalString(value.aws.maintenance_window, 'aws.maintenance_window');
    if (vpcCidr && !isValidVpcCidr(vpcCidr)) throw new Error('aws.vpc_cidr must be a canonical RFC1918 /16 CIDR');
    if (apiDomain && !isValidDomain(apiDomain)) throw new Error('aws.api_domain must be a valid DNS name');
    if (frontendDomain && !isValidDomain(frontendDomain)) throw new Error('aws.frontend_domain must be a valid DNS name');
    if (route53ZoneId && !/^Z[A-Z0-9]{5,31}$/.test(route53ZoneId)) {
      throw new Error('aws.route53_zone_id must be a Route 53 hosted zone ID');
    }
    if (releaseRepositoryUrl && !isHttpsUrl(releaseRepositoryUrl)) {
      throw new Error('aws.release_repository_url must be an HTTPS URL');
    }
    if (tufRootSha256 && !/^[a-f0-9]{64}$/.test(tufRootSha256)) {
      throw new Error('aws.tuf_root_sha256 must be a lowercase SHA-256 digest');
    }
    if (updaterBootstrapUrl && !isHttpsUrl(updaterBootstrapUrl)) {
      throw new Error('aws.updater_bootstrap_url must be an HTTPS URL');
    }
    if (updaterBootstrapSha256 && !/^[a-f0-9]{64}$/.test(updaterBootstrapSha256)) {
      throw new Error('aws.updater_bootstrap_sha256 must be a lowercase SHA-256 digest');
    }
    if (releasePublisherAccountId && !/^\d{12}$/.test(releasePublisherAccountId)) {
      throw new Error('aws.release_publisher_account_id must be a 12-digit AWS account ID');
    }
    if (maintenanceWindow && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun):(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(maintenanceWindow)) {
      throw new Error('aws.maintenance_window must use UTC Day:HH:MM-HH:MM format');
    }
    aws = {
      profile,
      region,
      account_id: accountId,
      ...(vpcCidr ? { vpc_cidr: vpcCidr } : {}),
      ...(apiDomain ? { api_domain: apiDomain } : {}),
      ...(frontendDomain ? { frontend_domain: frontendDomain } : {}),
      ...(route53ZoneId ? { route53_zone_id: route53ZoneId } : {}),
      ...(releaseRepositoryUrl ? { release_repository_url: releaseRepositoryUrl } : {}),
      ...(tufRootSha256 ? { tuf_root_sha256: tufRootSha256 } : {}),
      ...(updaterBootstrapUrl ? { updater_bootstrap_url: updaterBootstrapUrl } : {}),
      ...(updaterBootstrapSha256 ? { updater_bootstrap_sha256: updaterBootstrapSha256 } : {}),
      ...(releasePublisherAccountId ? { release_publisher_account_id: releasePublisherAccountId } : {}),
      ...(maintenanceWindow ? { maintenance_window: maintenanceWindow } : {}),
    };
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

export function assertAwsVpcInstanceName(instance: string): void {
  if (!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(instance)) {
    throw new Error('AWS EC2 instance must be a 4-32 character lowercase DNS slug');
  }
  // Every AWS resource is named kortix-<instance>; a kortix- prefix here would
  // double it (kortix-kortix-...). Reject it explicitly rather than stripping.
  if (instance.startsWith('kortix-')) {
    throw new Error('AWS EC2 instance must not start with "kortix-"; resources are already named kortix-<instance>');
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDomain(value: string): boolean {
  return value.length <= 253
    && value.includes('.')
    && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isValidVpcCidr(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/.exec(value);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}
