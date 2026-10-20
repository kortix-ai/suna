import { expect, test } from 'bun:test';
import { anyFlag, isTruthyFlag } from './prompts';

test('flags accept only the existing lowercase truthy values', () => {
  for (const value of ['true', '1', 'yes']) expect(isTruthyFlag(value)).toBe(true);
  for (const value of [undefined, '', 'false', '0', 'no', 'TRUE', ' yes ']) {
    expect(isTruthyFlag(value)).toBe(false);
  }
  expect(anyFlag({ yes: 'yes', no: 'false' }, ['missing', 'no', 'yes'])).toBe(true);
  expect(anyFlag({ yes: 'yes', no: 'false' }, ['missing', 'no'])).toBe(false);
  expect(anyFlag({ yes: 'yes' }, [])).toBe(false);
});
