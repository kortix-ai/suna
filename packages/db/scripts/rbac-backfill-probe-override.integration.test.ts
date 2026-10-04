import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';
import {
  applyBootstrap,
  databaseConnectionUrl,
  migrationOptions,
  migrationsDir,
} from './upgrade-test-helpers';

const databaseUrl = process.env.TEST_DATABASE_ADMIN_URL;

const BACKFILL_MIGRATION = '20260819015725000_rbac_backfill_role_assignments.concurrent.ts';
/** Prod's measured shape is ~46k members across ~46k accounts; this seeds 20k of it. */
const MEMBER_COUNT = 40_000;

describe.skipIf(!databaseUrl)('rbac backfill runtime override — account-membership probe', () => {
  test('the overridden backfill copies every member exactly once, inside the time budget', async () => {
    const databaseName = `rbac_probe_override_${randomUUID().replaceAll('-', '')}`;
    const runtimeMigrations = materializeMigrationRuntimeDirectory(migrationsDir);
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template1`);
    } finally {
      await admin.end();
    }

    if (!databaseUrl) throw new Error('TEST_DATABASE_ADMIN_URL is required');
    const upgradeUrl = databaseConnectionUrl(databaseUrl, databaseName);
    try {
      const client = new pg.Client({ connectionString: upgradeUrl });
      await client.connect();
      try {
        await applyBootstrap(client);
      } finally {
        await client.end();
      }

      const migrationFiles = readdirSync(runtimeMigrations.path)
        .filter((name) => name.endsWith('.sql') || name.endsWith('.ts'))
        .sort();
      const backfillIndex = migrationFiles.findIndex((name) => name === BACKFILL_MIGRATION);
      expect(backfillIndex).toBeGreaterThan(0);

      // Bring the database to the instant before the backfill, where
      // account_members is still the physical legacy table.
      await runner({
        ...migrationOptions(upgradeUrl, runtimeMigrations.path),
        direction: 'up',
        count: backfillIndex,
      });

      const seed = new pg.Client({ connectionString: upgradeUrl });
      await seed.connect();
      try {
        await seed.query(`create temp table seed_accounts as select generate_series(1, ${MEMBER_COUNT}) rn`);
        await seed.query(
          `insert into kortix.accounts (account_id, name)
             select gen_random_uuid(), 'rbac-probe-seed-' || rn from seed_accounts`,
        );
        // One member per account, a tenth SCIM-owned, roles folded across the
        // three system account roles — synthetic data, prod-shaped counts.
        await seed.query(
          `insert into kortix.account_members (user_id, account_id, account_role, joined_at, scim_external_id)
             select gen_random_uuid(),
                    a.account_id,
                    (case when s.rn % 50 = 0 then 'owner' when s.rn % 97 = 0 then 'admin' else 'member' end)::kortix.account_role,
                    now() - (s.rn % 400) * interval '1 day',
                    case when s.rn % 10 = 0 then 'scim-seed-' || s.rn else null end
             from seed_accounts s
             join kortix.accounts a on a.name = 'rbac-probe-seed-' || s.rn`,
        );
      } finally {
        await seed.end();
      }

      // Apply exactly the backfill migration — the runtime copy carries the
      // probe rewrite (the unit test pins the text; this runs it).
      const startedAt = performance.now();
      await runner({
        ...migrationOptions(upgradeUrl, runtimeMigrations.path),
        direction: 'up',
        count: 1,
      });
      const elapsedMs = performance.now() - startedAt;

      const verified = new pg.Client({ connectionString: upgradeUrl });
      await verified.connect();
      try {
        const totals = await verified.query<{ principal: string; n: string }>(`
            select principal_type || ':' || source as principal, count(*)::text as n
            from kortix.role_assignments
            where scope_type = 'account' and scope_id is null and object_type is null
            group by 1 order by 1
          `);
        const byKey = new Map(totals.rows.map((r) => [r.principal, Number(r.n)]));
        const members = await verified.query<{ scim: string; plain: string }>(`
            select
              count(*) filter (where scim_external_id is not null)::text as scim,
              count(*) filter (where scim_external_id is null)::text as plain
            from kortix.account_members
          `);
        const expectedScim = Number(members.rows[0].scim);
        const expectedPlain = Number(members.rows[0].plain);
        // Every member got exactly one account-scope assignment, with the
        // source the backfill derives from scim_external_id.
        expect(byKey.get('user:scim')).toBe(expectedScim);
        expect(byKey.get('user:system')).toBe(expectedPlain);
        expect(expectedScim + expectedPlain).toBe(MEMBER_COUNT);

        // The catastrophic plan this override removes materializes the whole
        // copied account-scope population and nested-loops every candidate
        // member against it — O(copied x members) per batch (prod: mean
        // 16.4 s, max 46.0 s per 1,000-row batch). Measured on PostgreSQL
        // 15.8 with the override disabled, a 20,000-member drain took 143 s
        // through this same runner path; with the guard, this 40,000-member
        // drain takes ~4 s. The bound must fail that quadratic plan on any
        // box within ~20x of this one while never flaking on the guarded
        // path.
        expect(elapsedMs).toBeLessThan(25_000);
      } finally {
        await verified.end();
      }
    } finally {
      runtimeMigrations.cleanup();
      const cleanup = new pg.Client({ connectionString: databaseUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    }
  }, 180_000);
});
