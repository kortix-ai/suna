import { describe, expect, test } from 'bun:test';
import * as kortix from '../src/schema/kortix';
import { type SchemaContract, declaredContract, diffContract } from './schema-contract';
import { SQL_ONLY, type SqlOnlyList } from './schema-contract-sql-only';

function contract(parts: Partial<{
  relations: Record<string, 'table' | 'view'>;
  columns: string[];
  indexes: Record<string, { relation: string; unique: boolean }>;
  uniqueConstraints: Record<string, string>;
}>): SchemaContract {
  return {
    relations: new Map(Object.entries(parts.relations ?? {})),
    columns: new Set(parts.columns ?? []),
    indexes: new Map(Object.entries(parts.indexes ?? {})),
    uniqueConstraints: new Map(Object.entries(parts.uniqueConstraints ?? {})),
  };
}

const NONE: SqlOnlyList = { tables: {}, columns: {}, indexes: {} };

const ledger = contract({
  relations: { credit_ledger: 'table' },
  columns: ['credit_ledger.id', 'credit_ledger.idempotency_key'],
  indexes: { uniq_key: { relation: 'credit_ledger', unique: true } },
  uniqueConstraints: { kortix_unique_stripe_event: 'credit_ledger' },
});

describe('diffContract', () => {
  test('identical contracts agree', () => {
    expect(diffContract(ledger, ledger, NONE)).toEqual([]);
  });

  test('a relation declared as a table that the database holds as a view is drift', () => {
    const declared = contract({ relations: { account_members: 'table' } });
    const live = contract({ relations: { account_members: 'view' } });
    expect(diffContract(declared, live, NONE)).toEqual([
      'account_members: declared as a table, but it is a view',
    ]);
  });

  test('a declared index that no migration built is drift', () => {
    const declared = contract({
      relations: { sandbox_compute_sessions: 'table' },
      indexes: { uniq_one_open: { relation: 'sandbox_compute_sessions', unique: true } },
    });
    const live = contract({ relations: { sandbox_compute_sessions: 'table' } });
    expect(diffContract(declared, live, NONE)).toEqual([
      'uniq_one_open: declared index on sandbox_compute_sessions was never built (create it in a .concurrent.ts migration, or delete the declaration)',
    ]);
  });

  test('a declared index on the wrong relation or with the wrong uniqueness is drift', () => {
    const live = contract({
      relations: { roles: 'table' },
      indexes: { idx_roles_key: { relation: 'roles', unique: true } },
    });
    expect(
      diffContract(
        contract({ relations: { roles: 'table' }, indexes: { idx_roles_key: { relation: 'roles', unique: false } } }),
        live,
        NONE,
      ),
    ).toEqual(['idx_roles_key: declared non-unique, but it is unique']);
    expect(
      diffContract(
        contract({ relations: { roles: 'table', iam_roles: 'table' }, indexes: { idx_roles_key: { relation: 'iam_roles', unique: true } } }),
        live,
        NONE,
      ),
    ).toEqual([
      'iam_roles: declared as a table, but no such relation exists',
      'idx_roles_key: declared on iam_roles, but it indexes roles',
    ]);
  });

  test('an object the database has and kortix.ts does not declare is drift', () => {
    const live = contract({
      relations: { credit_ledger: 'table', warm_pool_presence: 'table' },
      columns: [...ledger.columns, 'credit_ledger.thread_id'],
      indexes: { ...Object.fromEntries(ledger.indexes), idx_type: { relation: 'credit_ledger', unique: false } },
      uniqueConstraints: { ...Object.fromEntries(ledger.uniqueConstraints), extra_unique: 'credit_ledger' },
    });
    expect(diffContract(ledger, live, NONE)).toEqual([
      'credit_ledger.thread_id: the database has this column, but kortix.ts does not declare it',
      'extra_unique: the database has this unique constraint on credit_ledger, but kortix.ts does not declare it',
      'idx_type: the database has this index on credit_ledger, but kortix.ts does not declare it',
      'warm_pool_presence: the database has this table, but kortix.ts does not declare it',
    ]);
  });

  test('the SQL-only list accepts what it names, including every index on a SQL-only relation', () => {
    const live = contract({
      relations: { credit_ledger: 'table', warm_pool_presence: 'table' },
      columns: [...ledger.columns, 'credit_ledger.thread_id', 'warm_pool_presence.project_id'],
      indexes: {
        ...Object.fromEntries(ledger.indexes),
        idx_type: { relation: 'credit_ledger', unique: false },
        idx_seen: { relation: 'warm_pool_presence', unique: false },
      },
      uniqueConstraints: Object.fromEntries(ledger.uniqueConstraints),
    });
    const sqlOnly: SqlOnlyList = {
      tables: { warm_pool_presence: 'legacy' },
      columns: { 'credit_ledger.thread_id': 'legacy' },
      indexes: { idx_type: 'legacy' },
    };
    expect(diffContract(ledger, live, sqlOnly)).toEqual([]);
  });

  test('a unique index can never be SQL-only', () => {
    const live = contract({
      relations: { credit_ledger: 'table' },
      columns: [...ledger.columns],
      indexes: { ...Object.fromEntries(ledger.indexes), uniq_sql_only: { relation: 'credit_ledger', unique: true } },
      uniqueConstraints: Object.fromEntries(ledger.uniqueConstraints),
    });
    expect(diffContract(ledger, live, { ...NONE, indexes: { uniq_sql_only: 'x' } })).toEqual([
      'uniq_sql_only: a unique index cannot be SQL-only; declare it in kortix.ts',
    ]);
  });

  test('a SQL-only entry whose object is gone or now declared must be deleted', () => {
    expect(
      diffContract(ledger, ledger, {
        tables: { dropped_table: 'x', credit_ledger: 'x' },
        columns: { 'credit_ledger.gone': 'x', 'credit_ledger.id': 'x' },
        indexes: { idx_gone: 'x', uniq_key: 'x' },
      }),
    ).toEqual([
      'credit_ledger.gone: listed as SQL-only, but the column no longer exists; delete the entry',
      'credit_ledger.id: listed as SQL-only, but kortix.ts declares it; delete the entry',
      'credit_ledger: listed as SQL-only, but kortix.ts declares it; delete the entry',
      'dropped_table: listed as SQL-only, but the relation no longer exists; delete the entry',
      'idx_gone: listed as SQL-only, but the index no longer exists; delete the entry',
      'uniq_key: listed as SQL-only, but kortix.ts declares it; delete the entry',
    ]);
  });

  test('an INVALID index is drift', () => {
    expect(diffContract(ledger, ledger, NONE, ['uniq_key'])).toEqual([
      'uniq_key: index is INVALID (a failed CONCURRENTLY build)',
    ]);
  });
});

describe('declaredContract(kortix.ts)', () => {
  const declared = declaredContract(kortix);

  test('declares the RBAC compatibility names as views and the physical tables as tables', () => {
    for (const view of ['account_members', 'project_members', 'project_group_grants', 'iam_policies', 'iam_resource_grants']) {
      expect(declared.relations.get(view)).toBe('view');
    }
    for (const table of ['roles', 'role_permissions', 'group_members', 'account_memberships', 'role_assignments']) {
      expect(declared.relations.get(table)).toBe('table');
    }
  });

  test('reads column-level and table-level unique constraints and view columns', () => {
    expect(declared.uniqueConstraints.get('session_sandboxes_session_id_key')).toBe('session_sandboxes');
    expect(declared.uniqueConstraints.get('kortix_unique_stripe_event')).toBe('credit_ledger');
    expect(declared.columns.has('account_members.account_role')).toBe(true);
    expect(declared.indexes.get('uniq_credit_ledger_idempotency_key')).toEqual({ relation: 'credit_ledger', unique: true });
  });

  test('no SQL-only entry names an object kortix.ts declares', () => {
    for (const name of Object.keys(SQL_ONLY.tables)) expect(declared.relations.has(name)).toBe(false);
    for (const name of Object.keys(SQL_ONLY.columns)) expect(declared.columns.has(name)).toBe(false);
    for (const name of Object.keys(SQL_ONLY.indexes)) expect(declared.indexes.has(name)).toBe(false);
  });
});
