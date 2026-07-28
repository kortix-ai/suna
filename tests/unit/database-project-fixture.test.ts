import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/core/env';
import {
  createDatabaseProject,
  deleteDatabaseProject,
  type OpenProjectDb,
} from '../src/fixtures/database-project';

function env(overrides: Partial<Env> = {}): Env {
  return {
    apiUrl: 'https://staging-api.kortix.com/v1',
    baseUrl: 'https://staging.kortix.com',
    gatewayUrl: 'https://gateway-staging.kortix.com',
    supabaseUrl: 'https://supabase.example',
    supabaseAnonKey: 'anon',
    supabaseServiceRoleKey: 'service',
    databaseUrl: 'postgres://staging.example/kortix',
    ownerEmail: null,
    ownerPassword: null,
    adminToken: null,
    internalServiceKey: null,
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    liveConfirm: 'ci',
    target: 'staging',
    capabilities: {
      daytona: true,
      managedGit: true,
      managedGitPush: false,
      stripe: false,
      supabaseAdmin: true,
      database: true,
      admin: false,
      internalCron: false,
      funded: true,
    },
    testEmailDomain: 'ke2e.kortix.test',
    ...overrides,
  };
}

function database() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const end = vi.fn().mockResolvedValue(undefined);
  const open: OpenProjectDb = vi.fn().mockResolvedValue({ query, end });
  return { open, query, end };
}

describe('database-only project fixture', () => {
  it('creates an isolated project row and manager grant without a Git provider call', async () => {
    const db = database();

    const project = await createDatabaseProject(
      env(),
      {
        accountId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        name: 'e2e-project',
      },
      db.open,
    );

    expect(project.name).toBe('e2e-project');
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query.mock.calls[0][0]).toContain('INSERT INTO kortix.projects');
    expect(db.query.mock.calls[0][0]).toContain('INSERT INTO kortix.project_members');
    expect(db.query.mock.calls[0][1]).toEqual([
      project.id,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'e2e-project',
    ]);
    expect(db.end).toHaveBeenCalledOnce();
  });

  it('deletes the project row directly and relies on database cascades', async () => {
    const db = database();

    await deleteDatabaseProject(
      env(),
      '33333333-3333-4333-8333-333333333333',
      db.open,
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM kortix.projects'),
      ['33333333-3333-4333-8333-333333333333'],
    );
    expect(db.end).toHaveBeenCalledOnce();
  });

  it('rejects database-only fixture writes against production', async () => {
    const db = database();

    await expect(
      createDatabaseProject(
        env({ target: 'prod' }),
        {
          accountId: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          name: 'forbidden',
        },
        db.open,
      ),
    ).rejects.toThrow('refusing to create a database-only project against production');
    expect(db.open).not.toHaveBeenCalled();
  });

  it('requires KE2E_DATABASE_URL', async () => {
    const db = database();

    await expect(
      createDatabaseProject(
        env({ databaseUrl: null }),
        {
          accountId: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          name: 'missing-db',
        },
        db.open,
      ),
    ).rejects.toThrow('KE2E_DATABASE_URL is required');
    expect(db.open).not.toHaveBeenCalled();
  });
});
