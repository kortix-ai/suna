import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('managed Git fixture selection', () => {
  it('runs CONN-5 last against the shared managed repository', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/flows/connectors.flow.ts'),
      'utf8',
    );
    const start = source.indexOf("'CONN-5'");
    const end = source.indexOf("\nflow(", start);
    const conn5 = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(conn5).toContain('global: true');
    expect(conn5).toContain('ctx.fixtures.sharedProject()');
    expect(conn5).not.toContain('ctx.fixtures.project()');
  });

  it('uses staging credentials for manual E2E runs against staging', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/e2e.yml'),
      'utf8',
    );

    expect(workflow).toContain('secrets.STAGING_SUPABASE_URL');
    expect(workflow).toContain('secrets.STAGING_SUPABASE_ANON_KEY');
    expect(workflow).toContain('secrets.STAGING_SUPABASE_SERVICE_ROLE_KEY');
    expect(workflow).toContain('secrets.STAGING_DATABASE_URL');
    expect(workflow).toContain('secrets.STAGING_STRIPE_SECRET_KEY');
  });

  it('bounds stale-user GC with parallel workers and a workflow timeout', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/e2e.yml'),
      'utf8',
    );
    const gc = readFileSync(resolve(import.meta.dirname, '../src/fixtures/gc.ts'), 'utf8');

    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain('KE2E_GC_WORKERS: 8');
    expect(gc).toContain('mapWithConcurrency(stale, workers');
  });
});
