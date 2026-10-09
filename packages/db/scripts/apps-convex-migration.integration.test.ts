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

/**
 * Kortix Backends become Apps of kind `convex` (20261009115630597 ..
 * 20261009115640000) on a database that holds backends. Synthetic rows only.
 * Proves: each live backend becomes an App with the SAME id (hosts, compute
 * windows and issuer unchanged), its machine fields move to
 * app_convex_instances, a slug a web App already holds gets `-convex`, a
 * deleted backend is not copied, `apps.backends` names become app_links (an
 * unknown name is dropped), the old table and column are gone, the per-App
 * signing key column gives way to project_signing_keys, and the two
 * backend leaves fold into project.app.admin held by every app.write role.
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
        await client.query(
          `INSERT INTO kortix.projects(project_id, account_id, name, repo_url)
           VALUES ($1, $2, 'apps-convex-upgrade', 'https://example.invalid/apps-convex.git')`,
          [PROJECT, ACCOUNT],
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
              NULL, NULL, NULL, 'img', 1, 1, 10, $6, '{}', now())`,
          [MAIN, CRM, OLD, PROJECT, ACCOUNT, USER],
        );

        await runner({
          ...migrationOptions(url, runtimeMigrations.path),
          direction: 'up',
          count: Number.POSITIVE_INFINITY,
        });

        const apps = await client.query(
          `SELECT app_id, slug, name, kind, access_mode, always_on, cpu_cores, memory_gb, disk_gb, created_by, deleted_at
             FROM kortix.apps WHERE project_id = $1 ORDER BY slug`,
          [PROJECT],
        );
        expect(apps.rows).toEqual([
          expect.objectContaining({ app_id: CRM, slug: 'crm', name: 'crm', kind: 'convex', access_mode: 'project', always_on: true, cpu_cores: 1, memory_gb: 1, disk_gb: 10, created_by: USER, deleted_at: null }),
          expect.objectContaining({ app_id: WEB_APP, slug: 'main', kind: 'web' }),
          expect.objectContaining({ app_id: MAIN, slug: 'main-convex', name: 'main', kind: 'convex', always_on: true, cpu_cores: 2, memory_gb: 4, disk_gb: 20 }),
        ]);

        const instances = await client.query(
          `SELECT app_id, status, provider, external_id, url, site_url, admin_key_enc, auth_issuer, metadata
             FROM kortix.app_convex_instances ORDER BY app_id`,
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
        const grants = await client.query(
          `SELECT
             (SELECT count(*)::int FROM kortix.role_permissions WHERE action = 'project.app.write') AS writers,
             (SELECT count(*)::int FROM kortix.role_permissions WHERE action = 'project.app.admin') AS admins,
             (SELECT count(*)::int FROM kortix.role_permissions WHERE action LIKE 'project.backend.%') AS backend_grants,
             (SELECT count(*)::int FROM kortix.role_permissions wa
                WHERE wa.action = 'project.app.write'
                  AND NOT EXISTS (SELECT 1 FROM kortix.role_permissions a
                                   WHERE a.role_id = wa.role_id AND a.action = 'project.app.admin')) AS writers_without_admin`,
        );
        expect(grants.rows[0].writers).toBeGreaterThan(0);
        expect(grants.rows[0]).toMatchObject({ backend_grants: 0, writers_without_admin: 0 });
        expect(grants.rows[0].admins).toBe(grants.rows[0].writers);

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
});
