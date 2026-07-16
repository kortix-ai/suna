import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  instanceConfigPath,
  instanceDir,
  loadInstanceConfig,
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

  test('legacy .env-only instances load as a valid, config-less instance', () => {
    mkdirSync(instanceDir('legacy'), { recursive: true });
    writeFileSync(join(instanceDir('legacy'), '.env'), 'KORTIX_VERSION=0.9.72\n');

    expect(loadInstanceConfig('legacy')).toEqual({
      schema_version: 1,
      instance: 'legacy',
    });
  });

  test('writes and round-trips an instance config with owner-only permissions', () => {
    const config: SelfHostInstanceConfig = {
      schema_version: 1,
      instance: 'my-instance',
      release: '0.9.90',
    };

    writeInstanceConfig(config);

    expect(loadInstanceConfig(config.instance)).toEqual(config);
    expect(JSON.parse(readFileSync(instanceConfigPath(config.instance), 'utf8'))).toEqual(config);
    expect(statSync(instanceConfigPath(config.instance)).mode & 0o777).toBe(0o600);
  });

  test('rejects invalid or unsupported instance configs', () => {
    mkdirSync(instanceDir('broken'), { recursive: true });
    writeFileSync(
      instanceConfigPath('broken'),
      JSON.stringify({
        schema_version: 1,
        instance: 'broken',
        api_key: 'must-not-live-here',
      }),
    );

    expect(() => loadInstanceConfig('broken')).toThrow('unsupported field "api_key"');
  });

  test('rejects an instance name with invalid characters', () => {
    expect(() => instanceDir('not a valid name')).toThrow('instance must start with a letter');
  });

  test('returns null for an instance that has never been created', () => {
    expect(loadInstanceConfig('never-created')).toBeNull();
  });
});
