import { describe, expect, test } from 'bun:test';
import { lintMigration, lintMigrationSet, parseLockTimeoutMs } from './lint-migrations';

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

describe('backfill-DML guard (centralized_audit_v2 outage class)', () => {
  test('rejects a top-level UPDATE without a backfill-safe sign-off', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "ALTER TABLE kortix.widgets ADD COLUMN kind text;\nUPDATE kortix.widgets SET kind = 'x' WHERE kind IS NULL;\n",
    );
    expect(errors.some((e) => e.includes('top-level DML'))).toBe(true);
  });

  test('rejects a data-modifying WITH ... UPDATE CTE', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      'WITH ranked AS (SELECT id FROM kortix.widgets)\nUPDATE kortix.widgets w SET n = 1 FROM ranked r WHERE w.id = r.id;\n',
    );
    expect(errors.some((e) => e.includes('top-level DML'))).toBe(true);
  });

  test('rejects DML that follows a drizzle statement-breakpoint on the same line', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "ALTER TABLE kortix.widgets ADD COLUMN kind text;--> statement-breakpoint\nUPDATE kortix.widgets SET kind = 'x' WHERE kind IS NULL;--> statement-breakpoint\n",
    );
    expect(errors.some((e) => e.includes('top-level DML'))).toBe(true);
  });

  test('accepts DML with a backfill-safe sign-off', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "-- backfill-safe: widgets has < 1000 rows in every env and no hot writers\nUPDATE kortix.widgets SET kind = 'x' WHERE kind IS NULL;\n",
    );
    expect(errors).toEqual([]);
  });

  test('ignores DML inside a dollar-quoted trigger function body', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "CREATE OR REPLACE FUNCTION kortix.widget_audit() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  INSERT INTO kortix.audit_events(action) VALUES ('widget');\n  RETURN NEW;\nEND;\n$$;\n",
    );
    expect(errors).toEqual([]);
  });

  test('exempts a backfill-grandfathered migration', () => {
    const { errors } = lintMigration(
      GOOD_NAME,
      "UPDATE kortix.widgets SET kind = 'x' WHERE kind IS NULL;\n",
      { backfillGrandfathered: true },
    );
    expect(errors).toEqual([]);
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
    const { errors } = lintMigration(GOOD_NAME, 'DROP INDEX kortix.idx_projects_account_repo;\n');
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
    const { errors } = lintMigration(
      GOOD_NAME,
      'ALTER TABLE kortix.accounts ADD COLUMN note text;\n',
    );
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
        "  pgm.sql(`set lock_timeout = '180s'; create index concurrently idx_x on kortix.widgets (name);`);",
        '};',
      ].join('\n'),
    );
    expect(errors.some((e) => e.includes('IMPLICIT transaction') || e.includes('statements'))).toBe(
      true,
    );
  });

  test('accepts separate pgm.sql() calls for each statement', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql(`set lock_timeout = '180s'`);",
        '  pgm.sql(`create index concurrently if not exists idx_widgets_name on kortix.widgets (name)`);',
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

  test('accepts a well-formed CONCURRENTLY migration at the scaffolded lock_timeout', () => {
    const { errors } = lintMigration(
      CONCURRENT_NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql(`set lock_timeout = '180s'`);",
        '  pgm.sql(`create index concurrently if not exists idx_widgets_name on kortix.widgets (name)`);',
        '};',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
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

describe('.nontransaction.ts constraint transition', () => {
  const NAME = '20260101000000000_expand_widget_check.nontransaction.ts';

  test('accepts an explicitly justified constraint transition', () => {
    const { errors } = lintMigration(
      NAME,
      [
        '// constraint-transition: validate the replacement before dropping the old check',
        '// mixed-version-safe: old writers use values accepted by both constraints',
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        "  pgm.sql(`alter table kortix.widgets add constraint widgets_kind_check_v2 check (kind in ('a', 'b')) not valid`);",
        '  pgm.sql(`alter table kortix.widgets validate constraint widgets_kind_check_v2`);',
        '  pgm.sql(`alter table kortix.widgets drop constraint widgets_kind_check`);',
        '};',
        'export const down = false;',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });

  test('rejects an unclassified non-transactional migration', () => {
    const { errors } = lintMigration(
      NAME,
      [
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        '  pgm.sql(`select 1`);',
        '};',
      ].join('\n'),
    );
    expect(errors.some((error) => error.includes('constraint-transition'))).toBe(true);
  });

  test('rejects an unfilled constraint-transition scaffold', () => {
    const { errors } = lintMigration(
      NAME,
      [
        '// constraint-transition: TODO explain the lock boundary',
        '// mixed-version-safe: TODO explain old-code compatibility',
        'export const up = (pgm) => {',
        '  pgm.noTransaction();',
        '  pgm.sql(`alter table kortix.TODO_TABLE add constraint TODO_V2 check (true) not valid`);',
        '  pgm.sql(`alter table kortix.TODO_TABLE validate constraint TODO_V2`);',
        '  pgm.sql(`alter table kortix.TODO_TABLE drop constraint TODO_OLD`);',
        '};',
        'export const down = false;',
      ].join('\n'),
    );
    expect(errors.some((error) => error.includes('TODO'))).toBe(true);
  });
});

/**
 * The CONCURRENTLY lock_timeout floor.
 *
 * v0.13.0 deploy-prod run 32248002434 failed its migration job twice with 55P03
 * on `.concurrent` migrations that set `lock_timeout = '5s'` — once on a 6-row,
 * 80 kB table, which is what proved table size was not the variable. CIC waits
 * on every transaction that began before it, and lock_timeout governs that wait.
 */
describe('CONCURRENTLY lock_timeout floor', () => {
  const CONCURRENT_NAME = '20260101000000000_add_widget_index.concurrent.ts';

  function concurrentFile(lockTimeout: string | null): string {
    return [
      'export const up = (pgm) => {',
      '  pgm.noTransaction();',
      ...(lockTimeout === null ? [] : [`  pgm.sql(\`set lock_timeout = '${lockTimeout}'\`);`]),
      '  pgm.sql(`create index concurrently if not exists idx_widgets_name on kortix.widgets (name)`);',
      '};',
    ].join('\n');
  }

  function lockTimeoutErrors(source: string, options = {}) {
    return lintMigration(CONCURRENT_NAME, source, options).errors.filter((e) =>
      e.includes('lock_timeout'),
    );
  }

  test('rejects the 5s value that failed prod', () => {
    const errors = lockTimeoutErrors(concurrentFile('5s'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("lock_timeout = '5s'");
    expect(errors[0]).toContain('120s floor');
    expect(errors[0]).toContain('55P03');
  });

  test('rejects the 2s house value the old template scaffolded', () => {
    expect(lockTimeoutErrors(concurrentFile('2s'))).toHaveLength(1);
  });

  test('accepts the 180s value the template now scaffolds', () => {
    expect(lockTimeoutErrors(concurrentFile('180s'))).toEqual([]);
  });

  test('accepts equivalent durations at or above the floor', () => {
    for (const value of ['120s', '3min', '2min', '180000', '300000ms', '1h']) {
      expect(lockTimeoutErrors(concurrentFile(value))).toEqual([]);
    }
  });

  test('rejects sub-floor durations however they are spelled', () => {
    for (const value of ['119s', '1min', '5000', '90000ms', '1000000us']) {
      expect(lockTimeoutErrors(concurrentFile(value))).toHaveLength(1);
    }
  });

  test("accepts '0', which disables the timeout and waits indefinitely", () => {
    expect(lockTimeoutErrors(concurrentFile('0'))).toEqual([]);
  });

  test('accepts a file that sets no lock_timeout at all', () => {
    // Postgres defaults lock_timeout to 0 (disabled), which is safe for a CIC.
    // The rule is "if you set it, set it high enough", not "you must set it".
    expect(lockTimeoutErrors(concurrentFile(null))).toEqual([]);
  });

  test('flags an unparseable value rather than passing it', () => {
    const errors = lockTimeoutErrors(concurrentFile('soon'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unrecognized');
  });

  test('checks every lock_timeout in the file, not just the first', () => {
    const source = [
      'export const up = (pgm) => {',
      '  pgm.noTransaction();',
      "  pgm.sql(`set lock_timeout = '180s'`);",
      '  pgm.sql(`create index concurrently if not exists idx_a on kortix.widgets (a)`);',
      "  pgm.sql(`set lock_timeout = '5s'`);",
      '  pgm.sql(`create index concurrently if not exists idx_b on kortix.widgets (b)`);',
      '};',
    ].join('\n');
    expect(lockTimeoutErrors(source)).toHaveLength(1);
  });

  test('ignores a lock_timeout that appears only in a comment', () => {
    const source = [
      "// Do not copy `set lock_timeout = '2s'` from a .sql migration into this file.",
      'export const up = (pgm) => {',
      '  pgm.noTransaction();',
      "  pgm.sql(`set lock_timeout = '180s'`);",
      '  pgm.sql(`create index concurrently if not exists idx_widgets_name on kortix.widgets (name)`);',
      '};',
    ].join('\n');
    expect(lockTimeoutErrors(source)).toEqual([]);
  });

  test('does NOT apply to a batched-DML pass, which needs the short value', () => {
    // A batched data migration holds ROW locks, so a long lock_timeout there
    // really would queue writers behind it. The floor is CONCURRENTLY-only.
    const source = [
      '// batched-dml: role_assignments, 1000 rows per batch, bounded by account count',
      'export const up = (pgm) => {',
      '  pgm.noTransaction();',
      "  pgm.sql(`set lock_timeout = '5s'`);",
      "  pgm.sql(`update kortix.widgets set kind = 'x' where kind is null`);",
      '};',
    ].join('\n');
    expect(lockTimeoutErrors(source)).toEqual([]);
  });

  test('exempts a grandfathered pre-floor migration', () => {
    expect(
      lockTimeoutErrors(concurrentFile('2s'), { concurrentLockTimeoutGrandfathered: true }),
    ).toEqual([]);
  });

  test('the floor is independent of the other grandfather baselines', () => {
    // A file exempted from the mixed-version/backfill baselines is still held
    // to the lock_timeout floor — the cutoffs are separate on purpose.
    expect(
      lockTimeoutErrors(concurrentFile('5s'), { grandfathered: true, backfillGrandfathered: true }),
    ).toHaveLength(1);
  });
});

describe('parseLockTimeoutMs', () => {
  test('reads every Postgres duration unit', () => {
    expect(parseLockTimeoutMs('180s')).toBe(180_000);
    expect(parseLockTimeoutMs('3min')).toBe(180_000);
    expect(parseLockTimeoutMs('2h')).toBe(7_200_000);
    expect(parseLockTimeoutMs('1d')).toBe(86_400_000);
    expect(parseLockTimeoutMs('500ms')).toBe(500);
    expect(parseLockTimeoutMs('2000us')).toBe(2);
  });

  test('treats a bare number as milliseconds, like Postgres', () => {
    expect(parseLockTimeoutMs('180000')).toBe(180_000);
  });

  test("treats '0' as no timeout at all", () => {
    expect(parseLockTimeoutMs('0')).toBe(Number.POSITIVE_INFINITY);
    expect(parseLockTimeoutMs('0s')).toBe(Number.POSITIVE_INFINITY);
  });

  test('tolerates whitespace and case', () => {
    expect(parseLockTimeoutMs('  180S  ')).toBe(180_000);
  });

  test('returns null for anything it cannot read', () => {
    expect(parseLockTimeoutMs('soon')).toBeNull();
    expect(parseLockTimeoutMs('')).toBeNull();
    expect(parseLockTimeoutMs('3 weeks')).toBeNull();
    expect(parseLockTimeoutMs('-5s')).toBeNull();
  });
});
