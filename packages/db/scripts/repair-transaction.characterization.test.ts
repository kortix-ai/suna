import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import pg from 'pg';
import { repairEarlyAppliedMigrations } from './early-applied-migration-repair';
import { repairLocalAuditV2Ledger } from './local-audit-v2-ledger-repair';
import { dropLocalInvalidIndexes } from './local-invalid-index-repair';
import { repairLocalWarmSessionIndex } from './local-warm-session-index-repair';

const migrations = join(import.meta.dir, '../migrations');
const calls: string[] = [];
const connect = spyOn(pg.Client.prototype, 'connect').mockImplementation(async function (this: pg.Client) { calls.push('connect'); return this; });
const end = spyOn(pg.Client.prototype, 'end').mockImplementation(async () => { calls.push('end'); });
const query = spyOn(pg.Client.prototype, 'query');
afterEach(() => { calls.length = 0; });
afterAll(() => { connect.mockRestore(); end.mockRestore(); query.mockRestore(); });

const repairs = [
  { name: 'early applied', run: () => repairEarlyAppliedMigrations('postgres://synthetic', migrations), result: [] },
  { name: 'audit ledger no-op', run: () => repairLocalAuditV2Ledger('postgres://synthetic', migrations), result: false },
  { name: 'invalid index', run: () => dropLocalInvalidIndexes('postgres://synthetic'), result: ['kortix.synthetic'] },
  { name: 'warm index', run: () => repairLocalWarmSessionIndex('postgres://synthetic'), result: { repaired: true, discardedDuplicates: 1 } },
];

for (const repair of repairs) {
  for (const failure of ['none', 'begin', 'body', 'commit', 'rollback', 'end', 'body-and-end']) {
    test(`${repair.name}: ${failure} preserves transaction and close precedence`, async () => {
      const error = new Error(`synthetic ${failure}`);
      const bodyError = new Error('synthetic body');
      query.mockImplementation(async (sql) => {
        const text = String(sql).trim().toLowerCase();
        const command = ['begin', 'commit', 'rollback'].includes(text) ? text : 'query';
        calls.push(command);
        if (command === failure) throw error;
        if (command === 'query' && calls.includes('begin') && !calls.includes('rollback')) {
          if (failure === 'body') throw error;
          if (failure === 'body-and-end') throw bodyError;
          if (failure === 'rollback') throw bodyError;
        }
        const rows = text.includes('to_regclass') ? [{ exists: true, ready: true }]
          : text.includes('pg_stat_progress') ? [{ count: 0 }]
          : text.includes('and not i.indisvalid') ? [{ schema_name: 'kortix', index_name: 'synthetic' }]
          : [];
        return { rows, rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
      });
      if (failure === 'end' || failure === 'body-and-end') end.mockImplementationOnce(async () => { calls.push('end'); throw error; });
      if (failure === 'none') expect(await repair.run()).toEqual(repair.result);
      else await expect(repair.run()).rejects.toBe(error);
      expect(calls[0]).toBe('connect');
      expect(calls.at(-1)).toBe('end');
      expect(calls.filter((call) => ['begin', 'commit', 'rollback', 'end'].includes(call))).toEqual(
        failure === 'begin' ? ['begin', 'end']
          : failure === 'body' || failure === 'rollback' || failure === 'body-and-end' ? ['begin', 'rollback', 'end']
          : failure === 'commit' ? ['begin', 'commit', 'rollback', 'end']
          : ['begin', 'commit', 'end'],
      );
    });
  }
}
