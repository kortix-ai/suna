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

describe('CONCURRENTLY in a plain .sql migration', () => {
  test('rejects CREATE INDEX CONCURRENTLY in a plain .sql file', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'CREATE INDEX CONCURRENTLY idx_x ON kortix.widgets (name);\n',
    );
    expect(errors.some((e) => e.includes('CONCURRENTLY') && e.includes('--concurrent'))).toBe(true);
  });

  test('rejects DROP INDEX CONCURRENTLY in a plain .sql file (squawk alone misses this)', () => {
    const { errors } = lintMigration(GOOD_NAME, 'DROP INDEX CONCURRENTLY kortix.idx_x;\n');
    expect(errors.some((e) => e.includes('CONCURRENTLY'))).toBe(true);
  });

  test('does not fire on a normal migration', () => {
    const { errors } = lintMigration(GOOD_NAME, 'CREATE INDEX idx_x ON kortix.widgets (name);\n');
    expect(errors.some((e) => e.includes('batch transaction'))).toBe(false);
  });
});

describe('mixed-version guard (the 20260713220001000 class)', () => {
  test('rejects an unannotated unique index drop', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'DROP INDEX kortix.idx_projects_account_repo;\n',
    );
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(true);
  });

  test('rejects an unannotated DROP TABLE', () => {
    const { errors } = lintMigration(GOOD_NAME, 'DROP TABLE kortix.widgets;\n');
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(true);
  });

  test('rejects an unannotated DROP CONSTRAINT', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'ALTER TABLE kortix.widgets DROP CONSTRAINT widgets_name_key;\n',
    );
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(true);
  });

  test('rejects an unannotated column rename', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'ALTER TABLE kortix.widgets RENAME COLUMN old_name TO new_name;\n',
    );
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(true);
  });

  test('accepts a unique index drop WITH the mixed-version-safe annotation', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      '-- mixed-version-safe: branch-isolated projects made this index redundant; no code reads it\nDROP INDEX kortix.idx_projects_account_repo;\n',
    );
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(false);
  });

  test('does not fire on an unrelated additive migration', () => {
    const { errors } = lintMigration(GOOD_NAME, 'ALTER TABLE kortix.accounts ADD COLUMN note text;\n');
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(false);
  });

  test('grandfathered pre-existing migrations are exempt', () => {
    const { errors } = lintMigration(GOOD_NAME, 'DROP TABLE kortix.widgets;\n', {
      grandfathered: true,
    });
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(false);
  });
});

describe('enum-value-addition guard (the sandbox_provider "platinum" drift class)', () => {
  test('rejects an unannotated ADD VALUE', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "ALTER TYPE kortix.sandbox_provider ADD VALUE 'platinum';\n",
    );
    expect(errors.some((e) => e.includes('enum-value-checked') || e.includes('faked'))).toBe(true);
  });

  test('accepts an ADD VALUE with the enum-value-checked annotation', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "-- enum-value-checked: confirmed present via migrate:status on dev and prod after this PR merges\nALTER TYPE kortix.sandbox_provider ADD VALUE 'platinum';\n",
    );
    expect(errors.some((e) => e.includes('enum-value-checked') || e.includes('faked'))).toBe(false);
  });

  test('grandfathered pre-existing migrations are exempt', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "ALTER TYPE kortix.sandbox_provider ADD VALUE 'e2b';\n",
      { grandfathered: true },
    );
    expect(errors.some((e) => e.includes('enum-value-checked'))).toBe(false);
  });
});

describe('.concurrent.ts escape hatch', () => {
  const CONCURRENT_NAME = '20260101000000000_add_widget_index.concurrent.ts';

  test('accepts a well-formed noTransaction CONCURRENTLY migration', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_widgets_name ON kortix.widgets (name);');",
        '};',
        'export const down = false;',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });

  test('rejects a .concurrent.ts file that never calls pgm.noTransaction()', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        "  pgm.sql('CREATE INDEX CONCURRENTLY idx_widgets_name ON kortix.widgets (name);');",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('noTransaction'))).toBe(true);
  });

  test('rejects a .concurrent.ts file with no CONCURRENTLY operation', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql('SELECT 1;');",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('CONCURRENTLY'))).toBe(true);
  });

  test('rejects an empty .concurrent.ts file', () => {
    const { errors } = lintMigration(CONCURRENT_NAME, '');
    expect(errors.some((e) => e.includes('empty'))).toBe(true);
  });

  test('rejects a multi-statement pgm.sql() call (implicit-transaction footgun)', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql(`set lock_timeout = '2s'; create index concurrently idx_x on kortix.widgets (name);`);",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('IMPLICIT transaction') || e.includes('statements'))).toBe(true);
  });

  test('accepts separate pgm.sql() calls for each statement', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql(`set lock_timeout = '2s'`);",
        "  pgm.sql(`create index concurrently if not exists idx_widgets_name on kortix.widgets (name)`);",
        '};',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });

  test('rejects an unfilled scaffold (leftover TODO)', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql('create index concurrently if not exists idx_TODO_ON_TODO_TABLE on kortix.TODO_TABLE (TODO_COLUMN);');",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('TODO'))).toBe(true);
  });

  test('the mixed-version guard also applies to .concurrent.ts (DROP INDEX CONCURRENTLY)', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql('drop index concurrently if exists kortix.idx_projects_account_repo');",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(true);
  });

  test('accepts a .concurrent.ts DROP INDEX CONCURRENTLY with a // mixed-version-safe annotation', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        '// mixed-version-safe: redundant index, no code path relies on it',
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql('drop index concurrently if exists kortix.idx_projects_account_repo');",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('mixed-version'))).toBe(false);
  });
});
