import { describe, expect, test } from 'bun:test';
import { lintMigration, lintMigrationSet } from './lint-migrations';

const GOOD_NAME = '20260101000000000_add_widget.sql';

describe('lintMigration', () => {
  test('a well-formed migration produces no errors', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'ALTER TABLE kortix.accounts ADD COLUMN note text;\n',
    );
    expect(errors).toEqual([]);
  });

  test('rejects a filename without a 17-digit timestamp prefix', () => {
    const { errors } = lintMigration('add_widget.sql', 'SELECT 1;');
    expect(errors.some((e) => e.includes('invalid filename'))).toBe(true);
  });

  test('rejects an empty / comment-only migration', () => {
    const { errors } = lintMigration(GOOD_NAME, '-- Up Migration\n-- Down Migration\n');
    expect(errors.some((e) => e.includes('no SQL'))).toBe(true);
  });

  test('rejects an unresolved merge-conflict marker', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'SELECT 1;\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n',
    );
    expect(errors.some((e) => e.includes('merge-conflict'))).toBe(true);
  });

  test('rejects a leftover TODO placeholder', () => {
    const { errors } = lintMigration(GOOD_NAME, '-- TODO: write this\nSELECT 1;');
    expect(errors.some((e) => e.includes('TODO'))).toBe(true);
  });

  test('warns on a destructive DROP in the up migration', () => {
    const { warnings } = lintMigration(GOOD_NAME, 'DROP TABLE kortix.widgets;');
    expect(warnings.some((w) => w.includes('destructive'))).toBe(true);
  });

  test('does not warn when the DROP is only in the down section', () => {
    const sql =
      '-- Up Migration\nCREATE TABLE kortix.w (id int);\n-- Down Migration\nDROP TABLE kortix.w;';
    expect(lintMigration(GOOD_NAME, sql).warnings).toEqual([]);
  });

  test('warns on DELETE without a WHERE clause', () => {
    const { warnings } = lintMigration(GOOD_NAME, 'DELETE FROM kortix.widgets;');
    expect(warnings.some((w) => w.includes('DELETE without a WHERE'))).toBe(true);
  });

  test('does not warn on DELETE that has a WHERE clause', () => {
    const { warnings } = lintMigration(GOOD_NAME, "DELETE FROM kortix.widgets WHERE id = '1';");
    expect(warnings).toEqual([]);
  });
});

describe('lintMigrationSet', () => {
  test('unique timestamps produce no errors', () => {
    const errors = lintMigrationSet([
      '20260101000000000_a.sql',
      '20260101000000001_b.sql',
      '20260101000000002_c.sql',
    ]);
    expect(errors).toEqual([]);
  });

  test('rejects two migrations sharing a timestamp', () => {
    const errors = lintMigrationSet(['20260101000000000_a.sql', '20260101000000000_b.sql']);
    expect(errors.some((e) => e.includes('duplicate migration timestamp'))).toBe(true);
  });

  test('ignores files without a 17-digit prefix (the per-file lint flags those)', () => {
    expect(lintMigrationSet(['not_a_migration.sql'])).toEqual([]);
  });
});
