import { expect, test } from 'bun:test';
import { backgroundBuildKey } from './builder';

test('background snapshot build dedup is provider-qualified', () => {
  expect(backgroundBuildKey('daytona', 'kortix-default-abc')).not.toBe(
    backgroundBuildKey('e2b', 'kortix-default-abc'),
  );
  expect(backgroundBuildKey('e2b', 'kortix-default-abc')).toBe(
    'e2b:kortix-default-abc',
  );
});
