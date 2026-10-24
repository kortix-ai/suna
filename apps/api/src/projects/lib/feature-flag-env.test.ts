import { describe, expect, test } from 'bun:test';

import { FEATURE_FLAGS_ENV_NAME, featureFlagsEnvValue } from './feature-flag-env';

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
