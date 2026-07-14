import type { SelfHostTarget } from './config.ts';

export interface SelfHostCommandFlags {
  instance: string;
  tag: string;
  release?: string;
  channel?: string;
  target?: SelfHostTarget;
  awsProfile?: string;
  region?: string;
  vpcCidr?: string;
  apiDomain?: string;
  frontendDomain?: string;
  route53ZoneId?: string;
  releaseRepositoryUrl?: string;
  tufRootSha256?: string;
  updaterBootstrapUrl?: string;
  updaterBootstrapSha256?: string;
  releasePublisherAccountId?: string;
  maintenanceWindow?: string;
  yes: boolean;
  local: boolean;
  registry: boolean;
  json: boolean;
  force: boolean;
}
