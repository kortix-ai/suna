import { expect, test } from 'bun:test';
import { jsonbSafeValue } from './jsonb-safe';

test('preserves nested own __proto__ properties without changing prototypes', () => {
  const input = JSON.parse('{"__proto__":{"polluted":"no"},"nested":[{"__proto__":{"text":"nul\\u0000"},"bad\\u0000key":"😀 café 漢字"}]}');
  const result = jsonbSafeValue(input);
  const expected = JSON.parse('{"__proto__":{"polluted":"no"},"nested":[{"__proto__":{"text":"nul�"},"bad�key":"😀 café 漢字"}]}');
  expect(result).toEqual(expected);
  expect(Object.hasOwn(result, '__proto__')).toBe(true);
  expect(Object.hasOwn(result.nested[0], '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(result.nested[0])).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  expect(input.nested[0].__proto__.text).toBe('nul\u0000');
});
