import { expect, test } from 'bun:test';
import { deriveInflightBudgetBytes } from './memory-budget';

test('in-flight budget uses 25% of the process memory limit', () => {
  expect(deriveInflightBudgetBytes(512 * 1024 * 1024)).toBe(128 * 1024 * 1024);
  expect(deriveInflightBudgetBytes(2 * 1024 * 1024 * 1024)).toBe(512 * 1024 * 1024);
});
