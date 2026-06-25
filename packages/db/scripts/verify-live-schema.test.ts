import { describe, expect, test } from 'bun:test';
import { diffMissing, type SchemaObjects } from './verify-live-schema';

const objs = (tables: string[], columns: string[]): SchemaObjects => ({
  tables: new Set(tables),
  columns: new Set(columns),
  enumValues: new Set(),
});

const objsWithEnums = (tables: string[], columns: string[], enumValues: string[]): SchemaObjects => ({
  tables: new Set(tables),
  columns: new Set(columns),
  enumValues: new Set(enumValues),
});

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
      ['executor_connectors'],
      ['executor_connectors.provider_type'],
      ['executor_connector_provider.pipedream', 'executor_connector_provider.channel'],
    );
    const live = objsWithEnums(
      ['executor_connectors'],
      ['executor_connectors.provider_type'],
      ['executor_connector_provider.pipedream'],
    );
    expect(diffMissing(canon, live)).toEqual({
      missingTables: [],
      missingColumns: [],
      missingEnumValues: ['executor_connector_provider.channel'],
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
