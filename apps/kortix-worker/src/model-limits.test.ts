import { expect, test } from 'bun:test';
import { parseWorkerModelLimits, selectWorkerModelLimits } from './model-limits';

const luna = { model: 'gpt-5.6-luna', context: 1050000, output: 128000 };
const other = { model: 'other', context: 200000, output: 32000 };

test('keeps limits attached to their exact model through session overrides', () => {
  expect(selectWorkerModelLimits(luna.model, undefined, luna)).toEqual(luna);
  expect(selectWorkerModelLimits(other.model, other, luna)).toEqual(other);
  expect(selectWorkerModelLimits(other.model, undefined, luna)).toBeUndefined();
  expect(() => selectWorkerModelLimits(other.model, luna, undefined)).toThrow('do not match');
});

test('validates serialized server limits without accepting missing or invalid dimensions', () => {
  expect(parseWorkerModelLimits(undefined)).toBeUndefined();
  expect(parseWorkerModelLimits(JSON.stringify(luna))).toEqual(luna);
  for (const value of [null, {}, { ...luna, model: '' }, { ...luna, context: 0 }, { ...luna, output: -1 }, { ...luna, context: 1.5 }]) {
    expect(() => parseWorkerModelLimits(JSON.stringify(value))).toThrow();
  }
});
