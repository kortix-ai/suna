import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationNamesInDirectory } from './early-applied-migration-repair';
import {
  assertReadOnlySetting,
  migrationNamesInRunOrder,
  planMigrationStatus,
} from './migration-status';

const scriptsDir = import.meta.dir;
const migrationsDir = join(scriptsDir, '..', 'migrations');

describe('planMigrationStatus', () => {
  const files = ['a_one', 'b_two.concurrent', 'c_three'];

  test('pending is every file the ledger does not name, in file order', () => {
    expect(planMigrationStatus(files, ['a_one'], { checkOrder: true })).toEqual({
      pending: ['b_two.concurrent', 'c_three'],
    });
    expect(planMigrationStatus(files, files, { checkOrder: true })).toEqual({ pending: [] });
    expect(planMigrationStatus(files, [], { checkOrder: true })).toEqual({ pending: files });
  });

  test('checkOrder refuses where node-pg-migrate up refuses, with its message', () => {
    expect(() => planMigrationStatus(files, ['a_one', 'c_three'], { checkOrder: true })).toThrow(
      'Not run migration b_two.concurrent is preceding already run migration c_three',
    );
  });

  test('without checkOrder an out-of-order ledger still lists the gap as pending', () => {
    expect(planMigrationStatus(files, ['a_one', 'c_three'], { checkOrder: false })).toEqual({
      pending: ['b_two.concurrent'],
    });
  });
});

describe('migrationNamesInRunOrder', () => {
  test('orders like node-pg-migrate: timestamp prefix first, then numeric name order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-run-order-'));
    try {
      for (const name of [
        '20260102000000000_b.sql',
        '20260101000000000_z.concurrent.ts',
        '20260101000000000_a.sql',
        '1767225600001_epoch_ms.sql', // 2026-01-01T00:00:00.001Z
        '.hidden.sql',
      ]) {
        writeFileSync(join(dir, name), '');
      }
      expect(migrationNamesInRunOrder(dir)).toEqual([
        '20260101000000000_a',
        '20260101000000000_z.concurrent',
        '1767225600001_epoch_ms',
        '20260102000000000_b',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('names every real migration once, keeping the .concurrent suffix', () => {
    const names = migrationNamesInRunOrder(migrationsDir);
    expect(names.length).toBeGreaterThan(100);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => name.endsWith('.concurrent'))).toBe(true);
    expect(names).toEqual(migrationNamesInDirectory(migrationsDir));
  });
});

describe('assertReadOnlySetting', () => {
  test('passes only on "on"', () => {
    expect(() => assertReadOnlySetting('default_transaction_read_only', 'on')).not.toThrow();
    for (const value of ['off', '', undefined]) {
      expect(() => assertReadOnlySetting('default_transaction_read_only', value)).toThrow(
        /refuses to run: default_transaction_read_only/,
      );
    }
  });
});

describe('the status path never reaches the migration runner', () => {
  const migrate = readFileSync(join(scriptsDir, 'migrate.ts'), 'utf8');
  const status = readFileSync(join(scriptsDir, 'migration-status.ts'), 'utf8');

  test('migrate.ts status reads the ledger through migration-status.ts', () => {
    const statusCase = migrate.slice(migrate.indexOf("case 'status':"), migrate.indexOf('default:'));
    expect(statusCase).toContain('readMigrationStatus(');
    expect(statusCase).not.toContain('runner(');
  });

  test('no command in migrate.ts uses node-pg-migrate dryRun', () => {
    expect(migrate).not.toMatch(/dryRun\s*:/);
  });

  test('migration-status.ts does not import node-pg-migrate', () => {
    expect(status).not.toMatch(/from 'node-pg-migrate'/);
  });
});
