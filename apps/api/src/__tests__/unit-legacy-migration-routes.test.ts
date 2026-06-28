import { describe, expect, test } from 'bun:test';
import { shouldListLegacyMigrationItem } from '../projects/legacy-migration-visibility';

describe('legacy migration eligibility visibility', () => {
  test('hides archived migrated legacy machine cards', () => {
    expect(shouldListLegacyMigrationItem({ status: 'archived' })).toBe(false);
  });

  test('keeps non-archived legacy machines visible for the migration flow', () => {
    expect(shouldListLegacyMigrationItem({ status: 'stopped' })).toBe(true);
  });
});
