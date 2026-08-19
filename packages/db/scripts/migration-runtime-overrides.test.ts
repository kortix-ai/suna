import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(sql: string): string {
  const root = mkdtempSync(join(tmpdir(), 'kortix-migration-runtime-'));
  const migrations = join(root, 'migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, '20260807221200000_centralized_audit_v2.sql'), sql);
  writeFileSync(join(migrations, '20260807221201000_after.sql'), 'select 1;\n');
  roots.push(root);
  return migrations;
}

function removeLocalDockerFixture(sql: string): string {
  const root = mkdtempSync(join(tmpdir(), 'kortix-migration-runtime-'));
  const migrations = join(root, 'migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, '20260807165721291_remove_local_docker_provider.sql'), sql);
  roots.push(root);
  return migrations;
}

describe('materializeMigrationRuntimeDirectory', () => {
  test('changes only the known audit-v2 timeout and keeps the immutable source untouched', () => {
    const sql = "SET lock_timeout = '5s';\nSET statement_timeout = '120s';\nSELECT 1;\n";
    const source = fixture(sql);
    const runtime = materializeMigrationRuntimeDirectory(source, {
      expectedSha256: '622840481c9538d777b09fb0bdf542143f95c119646ecbb18c260510b6158838',
    });

    expect(runtime.path).not.toBe(source);
    expect(runtime.appliedOverrides).toEqual([
      '20260807221200000_centralized_audit_v2.sql: statement_timeout 120s -> 30min (769b863ef0b62c4693e232cf102757ce3c3ee904f0f44c9aea450901a56e07f9)',
    ]);
    expect(readFileSync(join(source, '20260807221200000_centralized_audit_v2.sql'), 'utf8')).toBe(sql);
    expect(
      readFileSync(
        join(runtime.path, '20260807221200000_centralized_audit_v2.sql'),
        'utf8',
      ),
    ).toBe("SET lock_timeout = '5s';\nSET statement_timeout = '30min';\nSELECT 1;\n");
    expect(readFileSync(join(runtime.path, '20260807221201000_after.sql'), 'utf8')).toBe(
      'select 1;\n',
    );

    runtime.cleanup();
  });

  test('fails closed when the immutable migration content does not match the approved checksum', () => {
    const source = fixture("SET statement_timeout = '120s';\nSELECT 2;\n");

    expect(() =>
      materializeMigrationRuntimeDirectory(source, { expectedSha256: '0'.repeat(64) }),
    ).toThrow('checksum mismatch');
  });

  test('fails closed when the approved timeout statement is missing or duplicated', () => {
    const missing = fixture('SELECT 1;\n');
    expect(() =>
      materializeMigrationRuntimeDirectory(missing, {
        expectedSha256: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
      }),
    ).toThrow('expected exactly one');

    const duplicatedSql = "SET statement_timeout = '120s';\nSET statement_timeout = '120s';\n";
    const duplicated = fixture(duplicatedSql);
    expect(() =>
      materializeMigrationRuntimeDirectory(duplicated, {
        expectedSha256: 'b99a7e9f6659464429b1494a03212c5cccdc185191e802ae911203046a8b86e7',
      }),
    ).toThrow('expected exactly one');
  });

  test('drops the historical compatibility view only in the runtime copy', () => {
    const insertionPoint = `DROP TRIGGER IF EXISTS trg_session_sandbox_identity_immutable
  ON kortix.session_sandboxes;--> statement-breakpoint

`;
    const sql = `SELECT 1;\n${insertionPoint}SELECT 2;\n`;
    const source = removeLocalDockerFixture(sql);
    const runtime = materializeMigrationRuntimeDirectory(source, {
      removeLocalDockerExpectedSha256: '2a9222670912af39fe3306dc1c0a56461e9b611d96c45bc22c09c45aa438297f',
    });

    expect(readFileSync(join(source, '20260807165721291_remove_local_docker_provider.sql'), 'utf8')).toBe(sql);
    expect(
      readFileSync(
        join(runtime.path, '20260807165721291_remove_local_docker_provider.sql'),
        'utf8',
      ),
    ).toContain('DROP VIEW IF EXISTS kortix.workspace_sessions;');
    expect(runtime.appliedOverrides).toEqual([
      '20260807165721291_remove_local_docker_provider.sql: drop historical workspace_sessions view (e0cfc4b8df7598ee3dfb485606d264fa5b915fd03871873019bd0d005b9b120b)',
    ]);
  });
});
