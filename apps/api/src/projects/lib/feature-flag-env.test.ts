import { describe, expect, test } from 'bun:test';

import {
  CLOUD_SUBAGENTS_ENV_NAME,
  FEATURE_FLAGS_ENV_NAME,
  GENUI_ENV_NAME,
  cloudSubagentsEnv,
  featureFlagsEnvValue,
  genuiEnvValue,
} from './feature-flag-env';

const on = { experimental: { genui: true } };
const off = { experimental: { genui: false } };

describe('genuiEnvValue', () => {
  test('flag on and kill switch open => 1', () => {
    expect(genuiEnvValue(on, true)).toBe('1');
  });
  test('flag off => 0', () => {
    expect(genuiEnvValue(off, true)).toBe('0');
  });
  test('no flag set => platform default (on) => 1', () => {
    expect(genuiEnvValue({}, true)).toBe('1');
    expect(genuiEnvValue(null, true)).toBe('1');
  });
  test('kill switch closed => 0 even with the flag on', () => {
    expect(genuiEnvValue(on, false)).toBe('0');
  });
  test('env name is the one kortixd reads', () => {
    expect(GENUI_ENV_NAME).toBe('KORTIX_GENUI');
  });
});

describe('featureFlagsEnvValue', () => {
  test('lists the enabled flags, sorted, comma-separated', () => {
    const value = featureFlagsEnvValue({ experimental: { agent_rooms: true, genui: false } }, true).split(',');
    expect(value).toContain('agent_rooms');
    expect(value).not.toContain('genui');
    expect([...value].sort()).toEqual(value);
  });
  test('a flag that is off is absent', () => {
    expect(featureFlagsEnvValue({ experimental: { agent_rooms: false } }, true).split(',')).not.toContain('agent_rooms');
  });
  test('genui follows the kill switch', () => {
    expect(featureFlagsEnvValue({ experimental: { genui: true } }, false).split(',')).not.toContain('genui');
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
