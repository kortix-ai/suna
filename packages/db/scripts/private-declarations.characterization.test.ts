import { expect, test } from 'bun:test';
import { catalogFromRow } from './catalog';
import { comparedObjects } from './verify-live-schema';
import { withMigrationRetry } from './migration-retry';

test('schema comparison normalizes qualifications while preserving constraint validity', () => {
  const catalog = catalogFromRow({
    relations: [{ name: 'synthetic_items', kind: 'table', columns: ['id'] }],
    enums: [],
    indexes: [],
    constraints: [{
      name: 'synthetic_items_parent_fk',
      table: 'synthetic_items',
      type: 'f',
      definition: 'FOREIGN KEY (id) REFERENCES public.synthetic_parents(id) NOT VALID',
      validated: false,
    }],
  });

  expect(comparedObjects(catalog).constraints.get('synthetic_items_parent_fk')).toEqual({
    table: 'synthetic_items',
    type: 'f',
    definition: 'FOREIGN KEY (id) REFERENCES synthetic_parents(id)',
    validated: false,
  });
  expect(catalog.constraints.get('synthetic_items_parent_fk')?.definition).toBe(
    'FOREIGN KEY (id) REFERENCES public.synthetic_parents(id) NOT VALID',
  );
});

test('migration retry returns an immediate result without invoking retry callbacks', async () => {
  const waits: number[] = [];
  const retries: number[] = [];
  expect(await withMigrationRetry(async () => 'unchanged', {
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    onRetry: (attempt) => { retries.push(attempt); },
    onLockRetry: (attempt) => { retries.push(attempt); },
  })).toBe('unchanged');
  expect(waits).toEqual([]);
  expect(retries).toEqual([]);
});
