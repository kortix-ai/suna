import { describe, expect, test } from 'bun:test';
import { type MigrationLedgerRow, planMigrationLedgerRepair } from './migration-ledger-repair';

const LEGACY_SQL = '20260729181733802_sandbox_deadline';
const LEGACY_INDEX = '20260729181804675_sandbox_deadline_index.concurrent';
const CURRENT_SQL = '20260730000452547_sandbox_deadline';
const CONNECTOR = '20260729215216867_executor_policy_arg_conditions';
const RUN_ON = new Date('2026-07-29T16:46:37.325Z');

function row(name: string, runOn = RUN_ON): MigrationLedgerRow {
  return { name, runOn };
}

describe('planMigrationLedgerRepair', () => {
  test('does nothing for a fresh or already-repaired ledger', () => {
    expect(planMigrationLedgerRepair([])).toBeNull();
    expect(planMigrationLedgerRepair([row(CONNECTOR), row(CURRENT_SQL)])).toBeNull();
  });

  test('plans the dev repair and identifies the missing connector migration', () => {
    const plan = planMigrationLedgerRepair([
      row(LEGACY_SQL),
      row(LEGACY_INDEX, new Date('2026-07-29T16:46:39.752Z')),
    ]);

    expect(plan).toEqual({
      connectorMigrationIsMissing: true,
      legacyRunOn: RUN_ON,
      renames: [
        { legacyName: LEGACY_SQL, currentName: CURRENT_SQL },
        {
          legacyName: LEGACY_INDEX,
          currentName: '20260730000452600_sandbox_deadline_index.concurrent',
        },
      ],
    });
  });

  test('does not reapply a connector migration that already exists', () => {
    const plan = planMigrationLedgerRepair([row(CONNECTOR), row(LEGACY_SQL)]);

    expect(plan?.connectorMigrationIsMissing).toBe(false);
    expect(plan?.renames).toEqual([{ legacyName: LEGACY_SQL, currentName: CURRENT_SQL }]);
  });

  test('rejects a ledger that contains both names for one migration', () => {
    expect(() => planMigrationLedgerRepair([row(LEGACY_SQL), row(CURRENT_SQL)])).toThrow(
      'contains both',
    );
  });

  test('rejects a legacy index without its table migration', () => {
    expect(() => planMigrationLedgerRepair([row(LEGACY_INDEX)])).toThrow(
      'without its table migration',
    );
  });
});
