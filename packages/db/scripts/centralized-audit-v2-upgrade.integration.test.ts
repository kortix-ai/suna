import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';
import { applyBootstrap, databaseConnectionUrl, migrationOptions, migrationsDir } from './upgrade-test-helpers';

const databaseUrl = process.env.TEST_DATABASE_ADMIN_URL;

describe.skipIf(!databaseUrl)('centralized audit v2 — upgrade from the v1 ledger', () => {
  test(
    'backfills legacy session cursors; rows written after the upgrade carry no sequence or hash',
    async () => {
      const databaseName = `audit_v2_upgrade_${randomUUID().replaceAll('-', '')}`;
      const runtimeMigrations = materializeMigrationRuntimeDirectory(migrationsDir);
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template1`);
      } finally {
        await admin.end();
      }

      const upgradeUrl = databaseConnectionUrl(databaseUrl!, databaseName);
      try {
        const client = new pg.Client({ connectionString: upgradeUrl });
        await client.connect();
        try {
          await applyBootstrap(client);
        } finally {
          await client.end();
        }

        expect(
          readFileSync(
            join(runtimeMigrations.path, '20260807221200000_centralized_audit_v2.sql'),
            'utf8',
          ),
        ).toContain("SET statement_timeout = '30min';");
        const migrationFiles = readdirSync(runtimeMigrations.path)
          .filter((name) => name.endsWith('.sql') || name.endsWith('.ts'))
          .sort();
        const auditV2Index = migrationFiles.findIndex((name) =>
          name.startsWith('20260807221200000_centralized_audit_v2'),
        );
        expect(auditV2Index).toBeGreaterThan(0);
        await runner({
          ...migrationOptions(upgradeUrl, runtimeMigrations.path),
          direction: 'up',
          count: auditV2Index,
        });

        const legacy = new pg.Client({ connectionString: upgradeUrl });
        await legacy.connect();
        try {
          await legacy.query(
            `INSERT INTO kortix.accounts(account_id, name)
             VALUES ('d7100000-0000-4000-a000-000000000001', 'audit-v2-upgrade')`,
          );
          await legacy.query(`
            INSERT INTO kortix.audit_events(
              event_id, account_id, action, resource_type, project_id, session_id,
              actor_type, source, outcome, occurred_at
            ) VALUES
              ('d8100000-0000-4000-a000-000000000002',
               'd7100000-0000-4000-a000-000000000001', 'legacy.second', 'test',
               'd7200000-0000-4000-a000-000000000001', 'legacy-session',
               'human', 'api', 'success', '2026-08-07T12:00:00Z'),
              ('d8100000-0000-4000-a000-000000000001',
               'd7100000-0000-4000-a000-000000000001', 'legacy.first', 'test',
               'd7200000-0000-4000-a000-000000000001', 'legacy-session',
               'human', 'api', 'success', '2026-08-07T11:00:00Z')
          `);
        } finally {
          await legacy.end();
        }

        await runner({
          ...migrationOptions(upgradeUrl, runtimeMigrations.path),
          direction: 'up',
          count: Number.POSITIVE_INFINITY,
        });

        const verified = new pg.Client({ connectionString: upgradeUrl });
        await verified.connect();
        try {
          const backfilled = await verified.query<{
            action: string;
            session_sequence: string;
            integrity_hash: string | null;
          }>(`
            SELECT action, session_sequence, integrity_hash
            FROM kortix.audit_events_all
            WHERE session_id = 'legacy-session'
            ORDER BY session_sequence
          `);
          expect(backfilled.rows).toEqual([
            { action: 'legacy.first', session_sequence: '1', integrity_hash: null },
            { action: 'legacy.second', session_sequence: '2', integrity_hash: null },
          ]);

          // Since the lock-free prepare trigger (20261001223552613) a new row gets no
          // sequence and no chain hash. The legacy rows above keep theirs.
          const later = await verified.query<{
            action: string;
            session_sequence: string | null;
            integrity_previous_hash: string | null;
            integrity_hash: string | null;
          }>(`
            INSERT INTO kortix.audit_events(
              account_id, action, resource_type, project_id, session_id,
              actor_type, authoritative_source, outcome
            ) VALUES
              ('d7100000-0000-4000-a000-000000000001', 'v2.first', 'test',
               'd7200000-0000-4000-a000-000000000001', 'legacy-session',
               'system', 'system', 'success'),
              ('d7100000-0000-4000-a000-000000000001', 'v2.second', 'test',
               'd7200000-0000-4000-a000-000000000001', 'legacy-session',
               'system', 'system', 'success')
            RETURNING action, session_sequence, integrity_previous_hash, integrity_hash
          `);
          expect(later.rows).toEqual([
            { action: 'v2.first', session_sequence: null, integrity_previous_hash: null, integrity_hash: null },
            { action: 'v2.second', session_sequence: null, integrity_previous_hash: null, integrity_hash: null },
          ]);
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
    },
    120_000,
  );
});
