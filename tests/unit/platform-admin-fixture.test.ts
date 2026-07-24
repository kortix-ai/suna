import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/core/env';
import { grantEphemeralPlatformAdmin, type OpenRoleDb } from '../src/fixtures/platform-admin';

function env(overrides: Partial<Env> = {}): Env {
  return {
    apiUrl: 'https://staging-api.kortix.com/v1',
    baseUrl: 'https://staging.kortix.com',
    gatewayUrl: 'https://gateway-staging.kortix.com',
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: null,
    supabaseServiceRoleKey: null,
    databaseUrl: 'postgresql://staging.example/kortix',
    ownerEmail: null,
    ownerPassword: null,
    adminToken: null,
    internalServiceKey: null,
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    liveConfirm: 'ci',
    target: 'staging',
    capabilities: {
      daytona: false,
      managedGit: false,
      managedGitPush: false,
      stripe: false,
      supabaseAdmin: false,
      database: true,
      admin: false,
      internalCron: false,
      funded: false,
    },
    testEmailDomain: 'ke2e.kortix.test',
    ...overrides,
  };
}

describe('ephemeral platform-admin fixture', () => {
  it('grants and then removes only the synthetic user role', async () => {
    const query = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const open: OpenRoleDb = vi.fn(async () => ({ query, end }));
    const accountId = '11111111-1111-4111-8111-111111111111';

    const revoke = await grantEphemeralPlatformAdmin(env(), accountId, open);
    await revoke();

    expect(open).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO kortix.platform_user_roles');
    expect(query.mock.calls[0]?.[1]).toEqual([accountId]);
    expect(query.mock.calls[1]?.[0]).toContain('DELETE FROM kortix.platform_user_roles');
    expect(query.mock.calls[1]?.[1]).toEqual([accountId]);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('refuses every production target before opening a database connection', async () => {
    const open: OpenRoleDb = vi.fn();
    await expect(
      grantEphemeralPlatformAdmin(env({ target: 'prod' }), crypto.randomUUID(), open),
    ).rejects.toThrow('refusing to grant an ephemeral platform role against production');
    expect(open).not.toHaveBeenCalled();
  });

  it('requires the explicit test database capability', async () => {
    await expect(
      grantEphemeralPlatformAdmin(env({ databaseUrl: null }), crypto.randomUUID()),
    ).rejects.toThrow('KE2E_DATABASE_URL is required');
  });
});
