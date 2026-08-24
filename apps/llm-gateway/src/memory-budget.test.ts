import { expect, test } from 'bun:test';
import { deriveInflightBudgetBytes } from './memory-budget';

test('in-flight budget uses 50% of the process memory limit', () => {
  expect(deriveInflightBudgetBytes(512 * 1024 * 1024)).toBe(256 * 1024 * 1024);
  expect(deriveInflightBudgetBytes(2 * 1024 * 1024 * 1024)).toBe(1024 * 1024 * 1024);
});
