import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  instanceConfigPath,
  instanceDir,
  loadInstanceConfig,
  resolveInstanceTarget,
  writeInstanceConfig,
  type SelfHostInstanceConfig,
} from '../config.ts';

describe('self-host instance config', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kortix-self-host-config-'));
    previousRoot = process.env.KORTIX_SELF_HOST_CONFIG_DIR;
    process.env.KORTIX_SELF_HOST_CONFIG_DIR = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.KORTIX_SELF_HOST_CONFIG_DIR;
    else process.env.KORTIX_SELF_HOST_CONFIG_DIR = previousRoot;
  });

  test('legacy .env-only instances remain Docker targets', () => {
    mkdirSync(instanceDir('legacy'), { recursive: true });
    writeFileSync(join(instanceDir('legacy'), '.env'), 'KORTIX_VERSION=0.9.72\n');

    expect(loadInstanceConfig('legacy')).toEqual({
      schema_version: 1,
      instance: 'legacy',
      target: 'docker',
      channel: 'latest',
    });
    expect(resolveInstanceTarget('legacy')).toBe('docker');
  });

  test('writes a secret-free AWS target config with owner-only permissions', () => {
    const config: SelfHostInstanceConfig = {
      schema_version: 1,
      instance: 'vpc-demo',
      target: 'aws-vpc',
      channel: 'stable',
      aws: {
        profile: 'default',
        region: 'us-west-2',
        account_id: '935064898258',
      },
    };

    writeInstanceConfig(config);

    expect(loadInstanceConfig(config.instance)).toEqual(config);
    expect(JSON.parse(readFileSync(instanceConfigPath(config.instance), 'utf8'))).toEqual(config);
    expect(statSync(instanceConfigPath(config.instance)).mode & 0o777).toBe(0o600);
  });

  test('rejects invalid or secret-bearing instance configs', () => {
    mkdirSync(instanceDir('broken'), { recursive: true });
    writeFileSync(
      instanceConfigPath('broken'),
      JSON.stringify({
        schema_version: 1,
        instance: 'broken',
        target: 'aws-vpc',
        channel: 'stable',
        aws: { profile: 'default', region: 'us-west-2', account_id: '123456789012' },
        api_key: 'must-not-live-here',
      }),
    );
    chmodSync(instanceConfigPath('broken'), 0o600);

    expect(() => loadInstanceConfig('broken')).toThrow('unsupported field "api_key"');
  });

  test('rejects an aws-vpc instance name that starts with kortix- (would double the resource prefix)', () => {
    const config = {
      schema_version: 1,
      instance: 'kortix-vpc-demo',
      target: 'aws-vpc',
      channel: 'stable',
      aws: { profile: 'default', region: 'us-west-2', account_id: '935064898258' },
    } as SelfHostInstanceConfig;
    expect(() => writeInstanceConfig(config)).toThrow('must not start with "kortix-"');
  });

  test('requires complete AWS coordinates', () => {
    mkdirSync(instanceDir('incomplete'), { recursive: true });
    writeFileSync(
      instanceConfigPath('incomplete'),
      JSON.stringify({
        schema_version: 1,
        instance: 'incomplete',
        target: 'aws-vpc',
        channel: 'stable',
        aws: { profile: 'default', region: 'us-west-2' },
      }),
    );

    expect(() => loadInstanceConfig('incomplete')).toThrow('aws.account_id');
  });

  test('rejects non-private VPC address space and non-stable enterprise channels', () => {
    const base = {
      schema_version: 1,
      instance: 'enterprise',
      target: 'aws-vpc',
      channel: 'stable',
      aws: {
        profile: 'default',
        region: 'us-west-2',
        account_id: '123456789012',
        vpc_cidr: '8.8.0.0/16',
      },
    };
    expect(() => writeInstanceConfig(base as SelfHostInstanceConfig)).toThrow('canonical RFC1918 /16');
    expect(() => writeInstanceConfig({ ...base, channel: 'prod', aws: { ...base.aws, vpc_cidr: '10.60.0.0/16' } } as SelfHostInstanceConfig))
      .toThrow('only track the stable channel');
  });
});
