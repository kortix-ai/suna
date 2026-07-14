import { prompt } from '../prompts.ts';
import type { AwsVpcCoordinates, SelfHostInstanceConfig } from './config.ts';
import type { SelfHostCommandFlags } from './types.ts';

export interface CompleteAwsVpcConfig extends AwsVpcCoordinates {
  vpc_cidr: string;
  api_domain: string;
  frontend_domain: string;
  route53_zone_id: string;
  release_repository_url: string;
  tuf_root_sha256: string;
  updater_bootstrap_url: string;
  updater_bootstrap_sha256: string;
  release_publisher_account_id: string;
  maintenance_window: string;
}

const CONFIG_FIELDS: Array<keyof CompleteAwsVpcConfig> = [
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
];

export function completeConfiguration(config: SelfHostInstanceConfig): CompleteAwsVpcConfig {
  const coordinates = config.aws!;
  const missing = missingConfiguration(coordinates);
  if (missing.length > 0) {
    throw new Error(
      `AWS VPC deployment config is incomplete (${missing.join(', ')}); run kortix self-host configure --instance ${config.instance}`,
    );
  }
  return coordinates as CompleteAwsVpcConfig;
}

export function missingConfiguration(config: AwsVpcCoordinates): string[] {
  return CONFIG_FIELDS.filter((field) => !config[field]);
}

export function mergeAwsConfiguration(
  current: AwsVpcCoordinates,
  flags: SelfHostCommandFlags,
  override: Partial<CompleteAwsVpcConfig>,
): AwsVpcCoordinates {
  return {
    ...current,
    ...override,
    ...(flags.awsProfile ? { profile: flags.awsProfile } : {}),
    ...(flags.region ? { region: flags.region } : {}),
    ...(flags.vpcCidr ? { vpc_cidr: flags.vpcCidr } : {}),
    ...(flags.apiDomain ? { api_domain: flags.apiDomain } : {}),
    ...(flags.frontendDomain ? { frontend_domain: flags.frontendDomain } : {}),
    ...(flags.route53ZoneId ? { route53_zone_id: flags.route53ZoneId } : {}),
    ...(flags.releaseRepositoryUrl ? { release_repository_url: flags.releaseRepositoryUrl } : {}),
    ...(flags.tufRootSha256 ? { tuf_root_sha256: flags.tufRootSha256 } : {}),
    ...(flags.updaterBootstrapUrl ? { updater_bootstrap_url: flags.updaterBootstrapUrl } : {}),
    ...(flags.updaterBootstrapSha256 ? { updater_bootstrap_sha256: flags.updaterBootstrapSha256 } : {}),
    ...(flags.releasePublisherAccountId ? { release_publisher_account_id: flags.releasePublisherAccountId } : {}),
    ...(flags.maintenanceWindow ? { maintenance_window: flags.maintenanceWindow } : {}),
  };
}

export function parseConfigurationAssignments(args: string[]): Partial<CompleteAwsVpcConfig> {
  const result: Record<string, string> = {};
  const allowed = new Set<string>(CONFIG_FIELDS);
  for (const arg of args) {
    if (arg.startsWith('-')) throw new Error(`unknown AWS VPC configure option "${arg}"`);
    const separator = arg.indexOf('=');
    if (separator < 1) throw new Error(`configure value must use key=value, got "${arg}"`);
    const key = arg.slice(0, separator).toLowerCase().replaceAll('-', '_');
    if (!allowed.has(key)) throw new Error(`unsupported AWS VPC setting "${key}"`);
    result[key] = arg.slice(separator + 1);
  }
  return result as Partial<CompleteAwsVpcConfig>;
}

export async function promptForConfiguration(current: AwsVpcCoordinates): Promise<AwsVpcCoordinates> {
  const next = { ...current } as Record<string, string>;
  const labels: Record<string, string> = {
    vpc_cidr: 'Dedicated VPC /16 CIDR',
    api_domain: 'API DNS name',
    frontend_domain: 'Dashboard DNS name',
    route53_zone_id: 'Customer Route 53 public hosted zone ID',
    release_repository_url: 'Enterprise TUF repository URL',
    tuf_root_sha256: 'Trusted TUF root SHA-256',
    updater_bootstrap_url: 'Updater bootstrap URL',
    updater_bootstrap_sha256: 'Updater bootstrap SHA-256',
    release_publisher_account_id: 'Kortix release publisher AWS account ID',
    maintenance_window: 'UTC maintenance window',
  };
  for (const field of CONFIG_FIELDS) {
    const defaultValue = next[field] || (field === 'maintenance_window' ? 'Sun:02:00-05:00' : undefined);
    next[field] = await prompt(labels[field], defaultValue);
  }
  return next as unknown as AwsVpcCoordinates;
}

export function hasConfigurationFlags(flags: SelfHostCommandFlags): boolean {
  return Boolean(
    flags.vpcCidr
    || flags.apiDomain
    || flags.frontendDomain
    || flags.route53ZoneId
    || flags.releaseRepositoryUrl
    || flags.tufRootSha256
    || flags.updaterBootstrapUrl
    || flags.updaterBootstrapSha256
    || flags.releasePublisherAccountId
    || flags.maintenanceWindow,
  );
}

export function assertEnterpriseRelease(release: string): void {
  if (!/^\d+\.\d+\.\d+-e[1-9]\d*$/.test(release)) {
    throw new Error('enterprise release must use <prod-version>-e<revision>, for example 0.9.84-e1');
  }
}
