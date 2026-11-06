import { expect, test } from 'bun:test';
import { parseModelSwitchInput } from './session-model-switch-input';

test('legacy model writes need no prompt or retry key', () => {
  expect(parseModelSwitchInput({ model: 'synthetic-model' })).toEqual({ kind: 'legacy' });
});
test('a switch requires a bounded prompt and retry key together', () => {
  expect(parseModelSwitchInput({ prompt: 'continue' }).kind).toBe('invalid');
  expect(parseModelSwitchInput({ prompt: ' ', idempotency_key: 'retry' }).kind).toBe('invalid');
  expect(parseModelSwitchInput({ prompt: 'continue', idempotency_key: 'x'.repeat(129) }).kind).toBe('invalid');
  expect(parseModelSwitchInput({ prompt: 'continue', idempotency_key: 'retry' })).toEqual({ kind: 'switch', prompt: 'continue', key: 'retry' });
});
test('switch text is safe for PostgreSQL jsonb without damaging emoji', () => {
  expect(parseModelSwitchInput({ prompt: 'a\0\ud800😀', idempotency_key: 'retry' })).toEqual({ kind: 'switch', prompt: 'a��😀', key: 'retry' });
});
