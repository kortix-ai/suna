import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';
import { applyBootstrap, databaseConnectionUrl, migrationOptions, migrationsDir } from './upgrade-test-helpers';

const databaseUrl = process.env.TEST_DATABASE_ADMIN_URL;
const ACCOUNT = 'c0a90000-0000-4000-a000-000000000001';
const PROJECT = 'c0a90000-0000-4000-a000-000000000002';
const WEB_APP = 'c0a90000-0000-4000-a000-000000000003';
const MAIN = 'c0a90000-0000-4000-a000-000000000004';
const CRM = 'c0a90000-0000-4000-a000-000000000005';
const OLD = 'c0a90000-0000-4000-a000-000000000006';
const USER = 'c0a90000-0000-4000-a000-000000000007';
const DB_BACKEND = 'c0a90000-0000-4000-a000-000000000008';
const FLAG_ON_PROJECT = 'c0a90000-0000-4000-a000-000000000009';
const FLAG_OFF_PROJECT = 'c0a90000-0000-4000-a000-00000000000a';
const ROLE_FULL = 'c0a90000-0000-4000-a000-0000000000b1';
const ROLE_WEB_PUBLISHER = 'c0a90000-0000-4000-a000-0000000000b2';
const ROLE_BACKEND_READER = 'c0a90000-0000-4000-a000-0000000000b3';
const ROLE_BACKEND_WRITER = 'c0a90000-0000-4000-a000-0000000000b4';

/**
 * Kortix Backends become Apps of kind `convex` (20261009115630597 ..
 * 20261009115640000) on a database that holds backends. Synthetic rows only.
 * Proves: each live backend becomes an App with the SAME id (hosts, compute
 * windows and issuer unchanged), its machine fields move to
 * app_convex_instances, a slug a web App already holds gets `-convex`, a
 * slug whose `-convex` form is also taken gets part of the id (never dropped),
 * the budget is the 24/7 estimate, a deleted backend is not copied,
 * `apps.backends` names become app_links (an unknown name is dropped), the
 * retired `backends` flag turns on `apps` and leaves the metadata, the old
 * table and column are gone, the per-App signing key column gives way to
 * project_signing_keys, and the backend leaves fold into the Apps leaves with
 * no role gaining a power: project.app.admin goes to the roles that held both
 * project.backend.write and project.app.write, project.app.read to the roles
 * that held a backend leaf.
 */
describe.skipIf(!databaseUrl)('project_backends → apps (kind convex) — upgrade of a database with backends', () => {
  test(
    'moves backends, their machines and the App backend lists, then drops the old shape',
    async () => {
      const databaseName = `apps_convex_${randomUUID().replaceAll('-', '')}`;
      const runtimeMigrations = materializeMigrationRuntimeDirectory(migrationsDir);
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template1`);
      await admin.end();

      const url = databaseConnectionUrl(databaseUrl!, databaseName);
      const client = new pg.Client({ connectionString: url });
      try {
        const setup = new pg.Client({ connectionString: url });
        await setup.connect();
        await applyBootstrap(setup);
        await setup.end();

        const files = readdirSync(runtimeMigrations.path)
          .filter((name) => name.endsWith('.sql') || name.endsWith('.ts'))
          .sort();
        const dataStep = files.findIndex((name) => name.startsWith('20261009115632000_'));
        expect(dataStep).toBeGreaterThan(0);
        await runner({ ...migrationOptions(url, runtimeMigrations.path), direction: 'up', count: dataStep });

        await client.connect();
        await client.query(`INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'apps-convex-upgrade')`, [ACCOUNT]);
        // PROJECT owns backends and has no flag set; FLAG_ON_PROJECT had `backends` on and `apps`
        // explicitly off; FLAG_OFF_PROJECT had `backends` off next to another flag.
        await client.query(
          `INSERT INTO kortix.projects(project_id, account_id, name, repo_url, metadata)
           VALUES ($1, $4, 'apps-convex-upgrade', 'https://example.invalid/apps-convex.git', NULL),
                  ($2, $4, 'apps-convex-flag-on', 'https://example.invalid/flag-on.git',
                   '{"experimental":{"backends":true,"apps":false},"keep":1}'),
                  ($3, $4, 'apps-convex-flag-off', 'https://example.invalid/flag-off.git',
                   '{"experimental":{"backends":false,"meta_agent":true}}')`,
          [PROJECT, FLAG_ON_PROJECT, FLAG_OFF_PROJECT, ACCOUNT],
        );
        // Web Apps that hold both `db` and `db-convex`: backend `db` must still arrive.
        await client.query(
          `INSERT INTO kortix.apps(account_id, project_id, slug, name, route_key)
           VALUES ($1, $2, 'db', 'db site', 'upgrade00000000a'), ($1, $2, 'db-convex', 'db-convex site', 'upgrade00000000b')`,
          [ACCOUNT, PROJECT],
        );
        await client.query(
          `INSERT INTO kortix.roles(role_id, account_id, key, name, scope_type)
           VALUES ($1, $5, 'upgrade_full', 'full', 'project'), ($2, $5, 'upgrade_web', 'web publisher', 'project'),
                  ($3, $5, 'upgrade_bread', 'backend reader', 'project'), ($4, $5, 'upgrade_bwrite', 'backend writer', 'project')`,
          [ROLE_FULL, ROLE_WEB_PUBLISHER, ROLE_BACKEND_READER, ROLE_BACKEND_WRITER, ACCOUNT],
        );
        await client.query(
          `INSERT INTO kortix.role_permissions(role_id, action) VALUES
             ($1, 'project.app.read'), ($1, 'project.app.write'), ($1, 'project.backend.read'), ($1, 'project.backend.write'),
             ($2, 'project.app.read'), ($2, 'project.app.write'),
             ($3, 'project.backend.read'),
             ($4, 'project.backend.read'), ($4, 'project.backend.write')`,
          [ROLE_FULL, ROLE_WEB_PUBLISHER, ROLE_BACKEND_READER, ROLE_BACKEND_WRITER],
        );
        // A web App that already holds the slug `main` and lists two backends and a name no backend has.
        await client.query(
          `INSERT INTO kortix.apps(app_id, account_id, project_id, slug, name, route_key, backends)
           VALUES ($1, $2, $3, 'main', 'Main site', 'upgrade000000001', ARRAY['main', 'crm', 'ghost'])`,
          [WEB_APP, ACCOUNT, PROJECT],
        );
        await client.query(
          `INSERT INTO kortix.project_backends(
             backend_id, project_id, account_id, name, status, provider, external_id, url, site_url,
             admin_key_enc, auth_key_enc, auth_issuer, template, cpu, memory_gb, disk_gb, created_by, metadata, deleted_at)
           VALUES
             ($1, $4, $5, 'main', 'running', 'platinum', 'sbx-upgrade-main', 'https://main.example.invalid', 'https://main-site.example.invalid',
              'sealed-admin', 'sealed-auth', 'https://api.example.invalid/v1/backends/main', 'img', 2, 4, 20, $6, '{"dashboard":true}', NULL),
             ($2, $4, $5, 'crm', 'error', 'platinum', NULL, NULL, NULL,
              NULL, NULL, NULL, 'img', 1, 1, 10, $6, '{"lastError":"synthetic"}', NULL),
             ($3, $4, $5, 'old', 'deleted', 'platinum', 'sbx-upgrade-old', NULL, NULL,
              NULL, NULL, NULL, 'img', 1, 1, 10, $6, '{}', now()),
             ($7, $4, $5, 'db', 'running', 'platinum', 'sbx-upgrade-db', 'https://db.example.invalid', NULL,
              'sealed-db', NULL, NULL, 'img', 1, 1, 10, $6, '{}', NULL)`,
          [MAIN, CRM, OLD, PROJECT, ACCOUNT, USER, DB_BACKEND],
        );

        await runner({
          ...migrationOptions(url, runtimeMigrations.path),
          direction: 'up',
          count: Number.POSITIVE_INFINITY,
        });

        const apps = await client.query(
          `SELECT app_id, slug, name, kind, access_mode, always_on, cpu_cores, memory_gb, disk_gb, created_by, deleted_at,
                  monthly_budget_usd::float AS budget, monthly_budget_explicit
             FROM kortix.apps WHERE project_id = $1 ORDER BY slug`,
          [PROJECT],
        );
        // Budget = defaultAppBudgetUsd({ ...size, alwaysOn: true }, 'platinum'): 1 CPU / 1 GB / 10 GB → $60, 2 / 4 / 20 → $147.
        expect(apps.rows).toEqual([
          expect.objectContaining({ app_id: CRM, slug: 'crm', name: 'crm', kind: 'convex', access_mode: 'project', always_on: true, cpu_cores: 1, memory_gb: 1, disk_gb: 10, created_by: USER, deleted_at: null, budget: 60, monthly_budget_explicit: false }),
          expect.objectContaining({ slug: 'db', kind: 'web' }),
          expect.objectContaining({ app_id: DB_BACKEND, slug: 'db-c0a90000', name: 'db', kind: 'convex', budget: 60 }),
          expect.objectContaining({ slug: 'db-convex', kind: 'web' }),
          expect.objectContaining({ app_id: WEB_APP, slug: 'main', kind: 'web' }),
          expect.objectContaining({ app_id: MAIN, slug: 'main-convex', name: 'main', kind: 'convex', always_on: true, cpu_cores: 2, memory_gb: 4, disk_gb: 20, budget: 147, monthly_budget_explicit: false }),
        ]);

        const instances = await client.query(
          `SELECT app_id, status, provider, external_id, url, site_url, admin_key_enc, auth_issuer, metadata
             FROM kortix.app_convex_instances WHERE app_id <> $1 ORDER BY app_id`,
          [DB_BACKEND],
        );
        expect(instances.rows).toEqual([
          {
            app_id: MAIN, status: 'running', provider: 'platinum', external_id: 'sbx-upgrade-main',
            url: 'https://main.example.invalid', site_url: 'https://main-site.example.invalid',
            admin_key_enc: 'sealed-admin',
            auth_issuer: 'https://api.example.invalid/v1/backends/main', metadata: { dashboard: true },
          },
          {
            app_id: CRM, status: 'error', provider: 'platinum', external_id: null, url: null, site_url: null,
            admin_key_enc: null, auth_issuer: null, metadata: { lastError: 'synthetic' },
          },
        ]);

        const dbInstance = await client.query(
          `SELECT external_id, admin_key_enc FROM kortix.app_convex_instances WHERE app_id = $1`,
          [DB_BACKEND],
        );
        expect(dbInstance.rows).toEqual([{ external_id: 'sbx-upgrade-db', admin_key_enc: 'sealed-db' }]);

        const flags = await client.query(
          `SELECT project_id, metadata FROM kortix.projects WHERE project_id = ANY($1::uuid[]) ORDER BY project_id`,
          [[PROJECT, FLAG_ON_PROJECT, FLAG_OFF_PROJECT]],
        );
        expect(flags.rows).toEqual([
          { project_id: PROJECT, metadata: { experimental: { apps: true } } },
          { project_id: FLAG_ON_PROJECT, metadata: { experimental: { apps: true }, keep: 1 } },
          { project_id: FLAG_OFF_PROJECT, metadata: { experimental: { meta_agent: true } } },
        ]);

        const links = await client.query(`SELECT app_id, uses_app_id FROM kortix.app_links ORDER BY uses_app_id`);
        expect(links.rows).toEqual([
          { app_id: WEB_APP, uses_app_id: MAIN },
          { app_id: WEB_APP, uses_app_id: CRM },
        ]);

        const gone = await client.query(
          `SELECT to_regclass('kortix.project_backends') AS backends_table,
                  (SELECT count(*)::int FROM information_schema.columns
                    WHERE table_schema = 'kortix' AND table_name = 'apps' AND column_name = 'backends') AS backends_column,
                  (SELECT count(*)::int FROM information_schema.columns
                    WHERE table_schema = 'kortix' AND table_name = 'app_convex_instances' AND column_name = 'auth_key_enc') AS app_key_column,
                  to_regclass('kortix.project_signing_keys') IS NOT NULL AS project_keys_table`,
        );
        // The per-App signing key is gone (20261009130527199): one key per project signs every App's tokens.
        expect(gone.rows[0]).toEqual({ backends_table: null, backends_column: 0, app_key_column: 0, project_keys_table: true });

        const leaves = await client.query(
          `SELECT action, area, level, implies FROM kortix.permissions
            WHERE action IN ('project.app.admin', 'project.backend.read', 'project.backend.write')`,
        );
        expect(leaves.rows).toEqual([{ action: 'project.app.admin', area: 'apps', level: 'edit', implies: ['project.app.write'] }]);
        const roleLeaves = await client.query(
          `SELECT role_id, array_agg(action ORDER BY action) AS actions FROM kortix.role_permissions
            WHERE role_id = ANY($1::uuid[]) GROUP BY role_id ORDER BY role_id`,
          [[ROLE_FULL, ROLE_WEB_PUBLISHER, ROLE_BACKEND_READER, ROLE_BACKEND_WRITER]],
        );
        expect(roleLeaves.rows).toEqual([
          { role_id: ROLE_FULL, actions: ['project.app.admin', 'project.app.read', 'project.app.write'] },
          // Held app.write without backend.write: gains no credential power.
          { role_id: ROLE_WEB_PUBLISHER, actions: ['project.app.read', 'project.app.write'] },
          // Held only backend.read: keeps list/connect/token through app.read.
          { role_id: ROLE_BACKEND_READER, actions: ['project.app.read'] },
          // Held backend.write without app.write: app.admin would imply app.write over every web App,
          // so it keeps read only; an owner grants project.app.admin explicitly.
          { role_id: ROLE_BACKEND_WRITER, actions: ['project.app.read'] },
        ]);
        const grants = await client.query(
          `SELECT
             (SELECT count(*)::int FROM kortix.role_permissions WHERE action LIKE 'project.backend.%') AS backend_grants,
             (SELECT count(*)::int FROM kortix.role_permissions rp JOIN kortix.roles r USING (role_id)
                WHERE r.account_id IS NULL AND rp.action = 'project.app.admin') AS system_admins`,
        );
        // The seeded Manager held both write leaves, so it holds project.app.admin.
        expect(grants.rows[0]).toMatchObject({ backend_grants: 0 });
        expect(grants.rows[0].system_admins).toBeGreaterThan(0);

        // A new App's kind defaults to web; an unknown kind is refused.
        await expect(
          client.query(
            `INSERT INTO kortix.apps(account_id, project_id, slug, name, route_key, kind)
             VALUES ($1, $2, 'bad-kind', 'bad', 'upgrade000000002', 'mysql')`,
            [ACCOUNT, PROJECT],
          ),
        ).rejects.toThrow(/apps_kind_check/);
      } finally {
        await client.end().catch(() => {});
        runtimeMigrations.cleanup();
        const cleanup = new pg.Client({ connectionString: databaseUrl });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await cleanup.end();
      }
    },
    180_000,
  );

  test(
    'refuses to drop project_backends while a live backend has no app_convex_instances row',
    async () => {
      const databaseName = `apps_convex_guard_${randomUUID().replaceAll('-', '')}`;
      const runtimeMigrations = materializeMigrationRuntimeDirectory(migrationsDir);
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template1`);
      await admin.end();

      const url = databaseConnectionUrl(databaseUrl!, databaseName);
      const client = new pg.Client({ connectionString: url });
      try {
        const setup = new pg.Client({ connectionString: url });
        await setup.connect();
        await applyBootstrap(setup);
        await setup.end();

        const files = readdirSync(runtimeMigrations.path)
          .filter((name) => name.endsWith('.sql') || name.endsWith('.ts'))
          .sort();
        const dropStep = files.findIndex((name) => name.startsWith('20261009115639481_'));
        expect(dropStep).toBeGreaterThan(0);
        // Everything up to and including the data step runs on an empty table.
        await runner({ ...migrationOptions(url, runtimeMigrations.path), direction: 'up', count: dropStep });

        // A backend the data step did not copy (written after it ran).
        await client.connect();
        await client.query(`INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'apps-convex-guard')`, [ACCOUNT]);
        await client.query(
          `INSERT INTO kortix.projects(project_id, account_id, name, repo_url)
           VALUES ($1, $2, 'apps-convex-guard', 'https://example.invalid/guard.git')`,
          [PROJECT, ACCOUNT],
        );
        await client.query(
          `INSERT INTO kortix.project_backends(backend_id, project_id, account_id, name, status, provider, external_id, cpu, memory_gb, disk_gb)
           VALUES ($1, $2, $3, 'uncopied', 'running', 'platinum', 'sbx-guard', 1, 1, 10)`,
          [MAIN, PROJECT, ACCOUNT],
        );

        await expect(
          runner({ ...migrationOptions(url, runtimeMigrations.path), direction: 'up', count: 1 }),
        ).rejects.toThrow(/refusing to drop the table/);
        const kept = await client.query(`SELECT to_regclass('kortix.project_backends') IS NOT NULL AS kept`);
        expect(kept.rows[0]).toEqual({ kept: true });
      } finally {
        await client.end().catch(() => {});
        runtimeMigrations.cleanup();
        const cleanup = new pg.Client({ connectionString: databaseUrl });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await cleanup.end();
      }
    },
    180_000,
  );
});
