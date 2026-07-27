import { describe, expect, test } from 'bun:test';
import {
  MANAGED_NANGO_GITHUB_SETTING_KEY,
  managedNangoGithubSettingSchema,
} from './managed-nango-github';

const validSetting = {
  schemaVersion: 1,
  connectionId: 'managed-connection-1',
  integrationId: 'github-app',
  installationId: '123456',
  owner: {
    login: 'kortix-managed',
    type: 'Organization',
  },
  status: 'connected',
  selectedByUserId: 'f5f875ba-e054-41ca-a441-6e032f969d88',
  selectedAt: '2026-07-27T14:00:00.000Z',
} as const;

describe('managed Nango GitHub platform setting', () => {
  test('uses a dedicated platform setting key', () => {
    expect(MANAGED_NANGO_GITHUB_SETTING_KEY).toBe('managed_github_nango_connection');
  });

  test('accepts credential-free managed connection metadata', () => {
    expect(managedNangoGithubSettingSchema.parse(validSetting)).toEqual(validSetting);
  });

  test('only permits organization installations for managed provisioning', () => {
    expect(() =>
      managedNangoGithubSettingSchema.parse({
        ...validSetting,
        owner: { login: 'personal-user', type: 'User' },
      }),
    ).toThrow();
  });

  test('rejects credential fields', () => {
    for (const credential of ['token', 'apiKey', 'clientSecret', 'privateKey']) {
      expect(() =>
        managedNangoGithubSettingSchema.parse({
          ...validSetting,
          [credential]: 'must-not-persist',
        }),
      ).toThrow();
    }
  });
});
