import type { SelfHostTarget } from './config.ts';

export interface SelfHostCommandFlags {
  instance: string;
  tag: string;
  release?: string;
  channel?: string;
  target?: SelfHostTarget;
  awsProfile?: string;
  region?: string;
  yes: boolean;
  local: boolean;
  registry: boolean;
  json: boolean;
  force: boolean;
}
