import { describe, expect, test } from 'bun:test';

import {
  CLOUD_SUBAGENTS_ENV_NAME,
  FEATURE_FLAGS_ENV_NAME,
  cloudSubagentsEnv,
  featureFlagsEnvValue,
} from './feature-flag-env';

describe('featureFlagsEnvValue', () => {
  test('lists the enabled flags, sorted, comma-separated', () => {
    const value = featureFlagsEnvValue({ experimental: { agent_rooms: true } }).split(',');
    expect(value).toContain('agent_rooms');
    expect([...value].sort()).toEqual(value);
  });
  test('a flag that is off is absent', () => {
    expect(featureFlagsEnvValue({ experimental: { agent_rooms: false } }).split(',')).not.toContain('agent_rooms');
  });
  test('genui is always listed, also over a stored flag-era `genui: false`, so an older image keeps the skill', () => {
    expect(featureFlagsEnvValue({ experimental: { genui: false } }).split(',')).toContain('genui');
    expect(featureFlagsEnvValue(null).split(',')).toContain('genui');
  });
  test('env name is the one kortixd and the CLI read', () => {
    expect(FEATURE_FLAGS_ENV_NAME).toBe('KORTIX_FEATURE_FLAGS');
  });
});

describe('cloudSubagentsEnv', () => {
  test('flag on => KORTIX_PI_CLOUD_SUBAGENTS=1', () => {
    expect(cloudSubagentsEnv({ experimental: { cloud_subagents: true } })).toEqual({ KORTIX_PI_CLOUD_SUBAGENTS: '1' });
  });
  test('flag off or unset => no key (platform default is off; the box keeps the in-process child)', () => {
    expect(cloudSubagentsEnv({ experimental: { cloud_subagents: false } })).toEqual({});
    expect(cloudSubagentsEnv({})).toEqual({});
    expect(cloudSubagentsEnv(null)).toEqual({});
  });
  test('env name is the one kortixd reads', () => {
    expect(CLOUD_SUBAGENTS_ENV_NAME).toBe('KORTIX_PI_CLOUD_SUBAGENTS');
  });
});
