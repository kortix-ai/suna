import { expect, test } from 'bun:test';
import { bearerToken } from './bearer';

test('bearerToken reads only a case-sensitive `Bearer ` scheme, untrimmed', () => {
  expect(bearerToken('Bearer kortix_pat_x')).toBe('kortix_pat_x');
  expect(bearerToken('Bearer  padded ')).toBe(' padded ');
  expect(bearerToken('Bearer ')).toBe('');
  expect(bearerToken('bearer kortix_pat_x')).toBeNull();
  expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  expect(bearerToken('Bearer')).toBeNull();
  expect(bearerToken('')).toBeNull();
  expect(bearerToken(undefined)).toBeNull();
  expect(bearerToken(null)).toBeNull();
});
