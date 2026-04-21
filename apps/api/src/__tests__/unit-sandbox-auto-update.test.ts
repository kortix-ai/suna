import { describe, expect, test } from 'bun:test';
import { defaultSandboxAutoUpdatePolicy, getSandboxAutoUpdatePolicy } from '../update/auto-update';
import { hasNewerSandboxVersion } from '../platform/routes/version';

describe('sandbox auto-update defaults', () => {
  test('defaults to enabled stable auto-update for stable versions', () => {
    expect(defaultSandboxAutoUpdatePolicy('0.8.41')).toMatchObject({ enabled: true, channel: 'stable' });
  });

  test('defaults to enabled dev auto-update for dev versions', () => {
    expect(defaultSandboxAutoUpdatePolicy('dev-abcd1234')).toMatchObject({ enabled: true, channel: 'dev' });
  });

  test('merges stored policy while preserving defaults', () => {
    const policy = getSandboxAutoUpdatePolicy({ autoUpdate: { enabled: false, lastDecision: 'disabled' } }, '0.8.41');
    expect(policy.enabled).toBe(false);
    expect(policy.channel).toBe('stable');
    expect(policy.lastDecision).toBe('disabled');
  });
});

describe('sandbox version comparison', () => {
  test('detects newer stable versions semantically', () => {
    expect(hasNewerSandboxVersion('0.8.41', '0.8.42', 'stable')).toBe(true);
    expect(hasNewerSandboxVersion('0.8.42', '0.8.42', 'stable')).toBe(false);
  });

  test('treats different dev tags as update available', () => {
    expect(hasNewerSandboxVersion('dev-aaaa1111', 'dev-bbbb2222', 'dev')).toBe(true);
    expect(hasNewerSandboxVersion('dev-aaaa1111', 'dev-aaaa1111', 'dev')).toBe(false);
  });
});
