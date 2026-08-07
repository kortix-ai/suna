import { expect, test } from 'bun:test';
import { manualTriggerIdempotencyKey } from './manual-trigger-idempotency';

test('manual trigger retry keys are validated and scoped', () => {
  expect(manualTriggerIdempotencyKey('p1', 't1', undefined)).toBeUndefined();
  expect(manualTriggerIdempotencyKey('p1', 't1', 'retry/1')).toBe('trigger:manual:p1:t1:retry/1');
  expect(() => manualTriggerIdempotencyKey('p1', 't1', 'bad key')).toThrow('Idempotency-Key');
});
