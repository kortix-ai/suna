import { expect, test } from 'bun:test';
import { piModelLimits } from './pi-model-limits';

test('uses the managed gateway limit for the exact selected alias', () => {
  expect(piModelLimits('project', 'kortix/gpt-5.6-luna')).toMatchObject({ model: 'gpt-5.6-luna', context: 1050000 });
  expect(piModelLimits('project', 'gpt-5.6-luna')).toEqual(piModelLimits('project', 'kortix/gpt-5.6-luna'));
});

test('does not borrow a different model limit for an unknown or absent alias', () => {
  expect(piModelLimits('project', 'not-a-real-provider/not-a-model')).toBeUndefined();
  expect(piModelLimits('project', null)).toBeUndefined();
});
