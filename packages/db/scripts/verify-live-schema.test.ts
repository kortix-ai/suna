import { describe, expect, test } from 'bun:test';
import { type CatalogRow, catalogFromRow } from './catalog';
import {
  type ComparedObjects,
  comparedObjects,
  countsLine,
  definitionKey,
  diffMissing,
  diffStructure,
  normalizeIndexDef,
  pendingMigrations,
} from './verify-live-schema';
import { LIVE_SCHEMA_WAIVERS, type LiveSchemaWaivers } from './verify-live-schema-waivers';

/** A synthetic database's compared objects: each `table.column` puts the column on its table. */
const objsWithEnums = (tables: string[], columns: string[], enumValues: string[]): ComparedObjects =>
  comparedObjects(catalogFromRow({
    relations: tables.map((name) => ({
      name,
      kind: 'table',
      columns: columns.filter((c) => c.startsWith(`${name}.`)).map((c) => c.slice(name.length + 1)),
    })),
    enums: enumValues.map((value) => ({ type: value.split('.')[0]!, label: value.split('.')[1]! })),
    indexes: [],
    constraints: [],
  }));
const objs = (tables: string[], columns: string[]): ComparedObjects => objsWithEnums(tables, columns, []);

describe('diffMissing (presence: canonical ⊆ live)', () => {
  test('identical schemas → nothing missing', () => {
    const s = objs(['accounts', 'projects'], ['accounts.id', 'projects.id']);
    expect(diffMissing(s, s)).toEqual({ missingTables: [], missingColumns: [], missingEnumValues: [] });
  });

  test('a table the migrations define but the live DB lacks is reported', () => {
    const canon = objs(['accounts', 'public_shares'], ['accounts.id', 'public_shares.id']);
    const live = objs(['accounts'], ['accounts.id']);
    const { missingTables, missingColumns } = diffMissing(canon, live);
    expect(missingTables).toEqual(['public_shares']);
    // The column on the missing table is NOT double-reported.
    expect(missingColumns).toEqual([]);
  });

  test('a missing column on an existing table is reported', () => {
    const canon = objs(['credit_accounts'], ['credit_accounts.id', 'credit_accounts.needs_reconciliation']);
    const live = objs(['credit_accounts'], ['credit_accounts.id']);
    expect(diffMissing(canon, live)).toEqual({
      missingTables: [],
      missingColumns: ['credit_accounts.needs_reconciliation'],
      missingEnumValues: [],
    });
  });

  test('a missing enum value is reported', () => {
    const canon = objsWithEnums(
      ['connectors'],
      ['connectors.provider_type'],
      ['connector_provider.pipedream', 'connector_provider.channel'],
    );
    const live = objsWithEnums(
      ['connectors'],
      ['connectors.provider_type'],
      ['connector_provider.pipedream'],
    );
    expect(diffMissing(canon, live)).toEqual({
      missingTables: [],
      missingColumns: [],
      missingEnumValues: ['connector_provider.channel'],
    });
  });

  test('EXTRA tables/columns on live (legacy leftovers) are ignored', () => {
    const canon = objs(['accounts'], ['accounts.id']);
    const live = objs(['accounts', 'legacy_integrations'], ['accounts.id', 'accounts.extra_col', 'legacy_integrations.x']);
    expect(diffMissing(canon, live)).toEqual({ missingTables: [], missingColumns: [], missingEnumValues: [] });
  });

  test('reports both missing tables and columns, each sorted', () => {
    const canon = objs(
      ['a', 'ztable', 'mtable'],
      ['a.x', 'a.y', 'a.b'],
    );
    const live = objs(['a'], ['a.x']);
    const { missingTables, missingColumns } = diffMissing(canon, live);
    expect(missingTables).toEqual(['mtable', 'ztable']);
    expect(missingColumns).toEqual(['a.b', 'a.y']);
  });
});

// ── indexes and constraints ───────────────────────────────────────────────────

type Part = (row: CatalogRow) => void;
const table = (name: string): Part => (row) => row.relations.push({ name, kind: 'table', columns: [] });
/** A view or materialized view: catalog.ts reports relkind v and m as 'view'. */
const view = (name: string, columns: string[] = []): Part => (row) => row.relations.push({ name, kind: 'view', columns });
const index = (name: string, tbl: string, def: string, valid = true): Part => (row) =>
  row.indexes.push({
    name,
    table: tbl,
    definition: def,
    unique: def.startsWith('CREATE UNIQUE'),
    valid,
    backsConstraint: false,
  });
const constraint = (name: string, tbl: string, type: string, def: string, validated = true): Part => (row) =>
  row.constraints.push({ name, table: tbl, type, definition: def, validated });
/**
 * Synthetic catalog rows, parsed the way catalog.ts parses the real query's
 * row and derived the way `main` derives each database: one `comparedObjects`.
 */
const catalogOf = (parts: Part[]): ComparedObjects => {
  const row: CatalogRow = { relations: [], enums: [], indexes: [], constraints: [] };
  for (const part of parts) part(row);
  return comparedObjects(catalogFromRow(row));
};
const NO_WAIVERS: LiveSchemaWaivers = { indexes: {}, constraints: {} };

const LEDGER_ACCOUNT_IDX =
  'CREATE INDEX idx_credit_ledger_account_id ON kortix.credit_ledger USING btree (account_id, created_at DESC)';

describe('diffStructure (indexes and constraints, canonical ⊆ live)', () => {
  test('an index the migrations build but live lacks is reported with its definition', () => {
    const canon = catalogOf([table('credit_ledger'), index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX)]);
    const live = catalogOf([table('credit_ledger')]);
    expect(diffStructure(canon, live, NO_WAIVERS).missingIndexes).toEqual([
      'idx_credit_ledger_account_id: CREATE INDEX ON credit_ledger USING btree (account_id, created_at DESC)',
    ]);
  });

  test('the same definition under another name passes (compared by definition, not name)', () => {
    const canon = catalogOf([
      table('credit_ledger'),
      index('idx_credit_ledger_idempotency', 'credit_ledger', 'CREATE INDEX idx_credit_ledger_idempotency ON kortix.credit_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)'),
    ]);
    const live = catalogOf([
      table('credit_ledger'),
      index('idx_kortix_credit_ledger_idempotency', 'credit_ledger', 'CREATE INDEX idx_kortix_credit_ledger_idempotency ON kortix.credit_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)'),
    ]);
    const drift = diffStructure(canon, live, NO_WAIVERS);
    expect(drift.missingIndexes).toEqual([]);
    expect(drift.extraIndexes).toEqual([]);
  });

  test('a different definition under the same name is missing, and the live one is an extra', () => {
    const canon = catalogOf([
      table('account_tokens'),
      index('idx_account_tokens_project', 'account_tokens', 'CREATE INDEX idx_account_tokens_project ON kortix.account_tokens USING btree (project_id) WHERE (project_id IS NOT NULL)'),
    ]);
    const live = catalogOf([
      table('account_tokens'),
      index('idx_account_tokens_project', 'account_tokens', 'CREATE INDEX idx_account_tokens_project ON kortix.account_tokens USING btree (project_id)'),
    ]);
    const drift = diffStructure(canon, live, NO_WAIVERS);
    expect(drift.missingIndexes).toHaveLength(1);
    expect(drift.extraIndexes).toEqual(['idx_account_tokens_project: CREATE INDEX ON account_tokens USING btree (project_id)']);
  });

  test('PostgreSQL 15 and 16 renderings of one predicate compare equal', () => {
    // PostgreSQL 16 (CI canonical) and 15 (prod/dev) print this baseline predicate differently.
    const pg16 =
      "CREATE UNIQUE INDEX i ON kortix.legacy_sandbox_migrations USING btree (sandbox_id) WHERE ((status)::text = ANY (ARRAY[('planned'::character varying)::text, ('running'::character varying)::text]))";
    const pg15 =
      "CREATE UNIQUE INDEX i ON kortix.legacy_sandbox_migrations USING btree (sandbox_id) WHERE ((status)::text = ANY ((ARRAY['planned'::character varying, 'running'::character varying])::text[]))";
    expect(definitionKey(normalizeIndexDef(pg16))).toBe(definitionKey(normalizeIndexDef(pg15)));
    // …but a different value set does not.
    expect(definitionKey(normalizeIndexDef(pg16))).not.toBe(definitionKey(normalizeIndexDef(pg15.replace("'running'", "'failed'"))));
  });

  test('uniqueness is part of the definition', () => {
    const canon = catalogOf([table('t'), index('u', 't', 'CREATE UNIQUE INDEX u ON kortix.t USING btree (a)')]);
    const live = catalogOf([table('t'), index('u', 't', 'CREATE INDEX u ON kortix.t USING btree (a)')]);
    expect(diffStructure(canon, live, NO_WAIVERS).missingIndexes).toEqual(['u: CREATE UNIQUE INDEX ON t USING btree (a)']);
  });

  test('an INVALID index on live is drift even when its definition matches', () => {
    const canon = catalogOf([table('credit_ledger'), index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX)]);
    const live = catalogOf([table('credit_ledger'), index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX, false)]);
    expect(diffStructure(canon, live, NO_WAIVERS).invalidIndexes).toEqual(['idx_credit_ledger_account_id on credit_ledger']);
  });

  test('an INVALID index on a live materialized view is neither drift nor counted', () => {
    const canon = catalogOf([table('credit_ledger'), index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX)]);
    const live = catalogOf([
      table('credit_ledger'),
      index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX),
      view('legacy_usage_rollup', ['day']),
      index('legacy_usage_rollup_day', 'legacy_usage_rollup', 'CREATE UNIQUE INDEX legacy_usage_rollup_day ON kortix.legacy_usage_rollup USING btree (day)', false),
    ]);
    expect(diffStructure(canon, live, NO_WAIVERS)).toMatchObject({ invalidIndexes: [], extraIndexes: [], missingIndexes: [] });
    // Its columns are counted: the catalog lists the columns of every relation, views included.
    expect(countsLine(live)).toBe('1 tables, 1 columns, 0 enum values, 1 indexes, 0 constraints.');
    // The same INVALID index on a table is drift.
    const onTable = catalogOf([
      table('credit_ledger'),
      index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX),
      table('legacy_usage_rollup'),
      index('legacy_usage_rollup_day', 'legacy_usage_rollup', 'CREATE UNIQUE INDEX legacy_usage_rollup_day ON kortix.legacy_usage_rollup USING btree (day)', false),
    ]);
    expect(diffStructure(canon, onTable, NO_WAIVERS).invalidIndexes).toEqual(['legacy_usage_rollup_day on legacy_usage_rollup']);
    expect(countsLine(onTable)).toBe('2 tables, 0 columns, 0 enum values, 2 indexes, 0 constraints.');
  });

  test('comparedObjects normalizes index and constraint definitions', () => {
    const compared = catalogOf([
      table('t'),
      index('t_a_idx', 't', 'CREATE INDEX t_a_idx ON ONLY kortix.t USING btree (a)'),
      constraint('t_fk', 't', 'f', 'FOREIGN KEY (a) REFERENCES kortix.u(id) NOT VALID', false),
    ]);
    expect(compared.indexes.get('t_a_idx')?.definition).toBe('CREATE INDEX ON t USING btree (a)');
    expect(compared.constraints.get('t_fk')?.definition).toBe('FOREIGN KEY (a) REFERENCES u(id)');
  });

  test('comparedObjects carries the columns and enum values of the catalog unchanged', () => {
    const compared = objsWithEnums(['t'], ['t.a', 't.b'], ['state.on']);
    expect(compared.tables).toEqual(new Set(['t']));
    expect(compared.columns).toEqual(new Set(['t.a', 't.b']));
    expect(compared.enumValues).toEqual(new Set(['state.on']));
  });

  test('indexes on a table live lacks are left to the table check', () => {
    const canon = catalogOf([table('credit_ledger'), index('idx_credit_ledger_account_id', 'credit_ledger', LEDGER_ACCOUNT_IDX)]);
    const live = catalogOf([]);
    expect(diffStructure(canon, live, NO_WAIVERS).missingIndexes).toEqual([]);
  });

  test('a missing primary key is reported even when an equivalent unique index exists', () => {
    const canon = catalogOf([
      table('account_memberships'),
      constraint('account_members_pkey', 'account_memberships', 'p', 'PRIMARY KEY (user_id, account_id)'),
    ]);
    const live = catalogOf([
      table('account_memberships'),
      index('idx_account_members_user_account', 'account_memberships', 'CREATE UNIQUE INDEX idx_account_members_user_account ON kortix.account_memberships USING btree (user_id, account_id)'),
    ]);
    expect(diffStructure(canon, live, NO_WAIVERS).missingConstraints).toEqual([
      'account_members_pkey on account_memberships: PRIMARY KEY (user_id, account_id)',
    ]);
  });

  test('missing FK and CHECK constraints are reported; schema qualification is ignored', () => {
    const canon = catalogOf([
      table('sandbox_compute_sessions'),
      constraint('sandbox_compute_sessions_ledger_id_fkey', 'sandbox_compute_sessions', 'f', 'FOREIGN KEY (ledger_id) REFERENCES kortix.credit_ledger(id) ON DELETE SET NULL'),
      constraint('sandbox_compute_sessions_state_check', 'sandbox_compute_sessions', 'c', "CHECK ((state = ANY (ARRAY['active'::text, 'stopped'::text])))"),
    ]);
    const live = catalogOf([
      table('sandbox_compute_sessions'),
      constraint('some_other_name', 'sandbox_compute_sessions', 'f', 'FOREIGN KEY (ledger_id) REFERENCES credit_ledger(id) ON DELETE SET NULL'),
    ]);
    expect(diffStructure(canon, live, NO_WAIVERS).missingConstraints).toEqual([
      "sandbox_compute_sessions_state_check on sandbox_compute_sessions: CHECK ((state = ANY (ARRAY['active'::text, 'stopped'::text])))",
    ]);
  });

  test('NOT VALID on live is drift when canonical is valid; the reverse passes', () => {
    const fk = 'FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE';
    const canonValid = catalogOf([table('y'), constraint('y_fk', 'y', 'f', fk)]);
    const liveNotValid = catalogOf([table('y'), constraint('y_fk', 'y', 'f', `${fk} NOT VALID`, false)]);
    expect(diffStructure(canonValid, liveNotValid, NO_WAIVERS).unvalidatedConstraints).toEqual([
      'y_fk on y: FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE',
    ]);
    expect(diffStructure(liveNotValid, canonValid, NO_WAIVERS)).toMatchObject({
      missingConstraints: [],
      unvalidatedConstraints: [],
    });
  });

  test('a waived gap is reported as waived, not as drift', () => {
    const canon = catalogOf([table('credit_ledger'), index('idx_credit_ledger_type', 'credit_ledger', 'CREATE INDEX idx_credit_ledger_type ON kortix.credit_ledger USING btree (type)')]);
    const live = catalogOf([table('credit_ledger')]);
    const drift = diffStructure(canon, live, { indexes: { idx_credit_ledger_type: 'unused on prod' }, constraints: {} });
    expect(drift.missingIndexes).toEqual([]);
    expect(drift.waived).toEqual(['index idx_credit_ledger_type: unused on prod']);
  });

  test('a waiver for an object the migrations no longer build is stale', () => {
    const canon = catalogOf([table('t')]);
    const drift = diffStructure(canon, canon, { indexes: { idx_gone: 'x' }, constraints: { con_gone: 'y' } });
    expect(drift.staleWaivers).toEqual(['constraint con_gone', 'index idx_gone']);
  });

  test('extras on live never fail', () => {
    const canon = catalogOf([table('t')]);
    const live = catalogOf([
      table('t'),
      index('extra', 't', 'CREATE INDEX extra ON kortix.t USING btree (a)'),
      constraint('extra_check', 't', 'c', 'CHECK ((a IS NOT NULL))'),
    ]);
    const drift = diffStructure(canon, live, NO_WAIVERS);
    expect(drift).toMatchObject({ missingIndexes: [], missingConstraints: [], invalidIndexes: [] });
    expect(drift.extraIndexes).toHaveLength(1);
    expect(drift.extraConstraints).toHaveLength(1);
  });
});

describe('pendingMigrations', () => {
  test('lists migrations the canonical database applied and live has not', () => {
    expect(pendingMigrations(['a', 'c', 'b'], ['a'])).toEqual(['b', 'c']);
  });

  test('a live database without a ledger reports nothing pending', () => {
    expect(pendingMigrations(['a'], [])).toEqual([]);
  });
});

describe('LIVE_SCHEMA_WAIVERS', () => {
  test('every waiver carries a reason', () => {
    for (const [name, reason] of [
      ...Object.entries(LIVE_SCHEMA_WAIVERS.indexes),
      ...Object.entries(LIVE_SCHEMA_WAIVERS.constraints),
    ]) {
      expect(reason.length, name).toBeGreaterThan(40);
    }
  });

  test('the indexes prod queries need are never waived', () => {
    for (const name of [
      'idx_credit_ledger_account_id',
      'idx_credit_accounts_trial_status',
      'idx_credit_accounts_plan_type',
      'idx_legacy_sandbox_migrations_active_sandbox',
    ]) {
      expect(LIVE_SCHEMA_WAIVERS.indexes).not.toHaveProperty(name);
    }
  });
});
