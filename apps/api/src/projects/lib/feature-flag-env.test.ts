import { describe, expect, test } from 'bun:test';

import {
  FEATURE_FLAGS_ENV_NAME,
  featureFlagsEnvValue,
} from './feature-flag-env';

describe('featureFlagsEnvValue', () => {
  test('lists the enabled flags, sorted, comma-separated', () => {
    const value = featureFlagsEnvValue({ experimental: { voice_call: true } }).split(',');
    expect(value).toContain('voice_call');
    expect([...value].sort()).toEqual(value);
  });
  test('a flag that is off is absent', () => {
    expect(featureFlagsEnvValue({ experimental: { voice_call: false } }).split(',')).not.toContain('voice_call');
  });
  test('genui is always listed, also over a stored flag-era `genui: false`, so an older image keeps the skill', () => {
    expect(featureFlagsEnvValue({ experimental: { genui: false } }).split(',')).toContain('genui');
    expect(featureFlagsEnvValue(null).split(',')).toContain('genui');
  });
  test('artifacts is listed exactly where Drive flags are, over a stored flag-era `artifacts: false`; artifact_comments never', () => {
    const value = featureFlagsEnvValue({ experimental: { artifacts: false, artifact_comments: true } }).split(',');
    expect(value.includes('artifacts')).toBe(value.includes('drives'));
    expect(value).not.toContain('artifact_comments');
  });
  test('env name is the one kortixd and the CLI read', () => {
    expect(FEATURE_FLAGS_ENV_NAME).toBe('KORTIX_FEATURE_FLAGS');
  });
});

