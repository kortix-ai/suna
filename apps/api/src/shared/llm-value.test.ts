import { expect, test } from 'bun:test';
import { estimateLlmValue } from './llm-value';

const call = {
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  input: 1000,
  output: 100,
  cached: 500,
  cacheWrite: 0,
};
test('subscription usage value is not a charge and cache reads replace plain input', () => {
  expect(estimateLlmValue(call)).toBeCloseTo(0.00205, 10);
});
test('unknown pricing and malformed cache counts stay unknown', () => {
  expect(estimateLlmValue({ ...call, model: 'unknown' })).toBeNull();
  expect(estimateLlmValue({ ...call, cached: 1001 })).toBeNull();
});
test('cache writes replace plain input and use their own rate', () => {
  expect(estimateLlmValue({ ...call, cached: 0, cacheWrite: 500 })).toBeCloseTo(0.00325, 10);
});
test('long context uses documented higher rates', () => {
  expect(estimateLlmValue({ ...call, input: 300000, cached: 0 })).toBeCloseTo(1.2015, 10);
});
test('request estimates reconcile when grouped without adding charges', () => {
  const a = estimateLlmValue(call);
  const b = estimateLlmValue({ ...call, output: 200 });
  if (a === null || b === null) throw new Error('Known rates must be priced');
  expect(a + b).toBeCloseTo(0.0051, 10);
});
