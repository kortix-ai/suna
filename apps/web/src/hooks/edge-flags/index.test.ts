import { expect, test } from 'bun:test';
import { systemStatusKeys } from './index';

test('maintenance cache keys remain stable for readers and invalidation', () => {
  expect(systemStatusKeys.config).toEqual(['maintenance-config']);
  expect(systemStatusKeys.all).toEqual(['system-status']);
});
