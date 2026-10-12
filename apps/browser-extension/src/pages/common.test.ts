import { describe, expect, test } from 'bun:test';
import { accountsDiffer, identityFrom } from './common';

const frame = {} as Window;
const ok = { origin: 'https://kortix.com', source: frame, data: { type: 'kortix.identity', userId: 'u1', email: 'a@x.test' } };

describe('panel identity', () => {
  test('accepts the web app origin from the panel frame', () => {
    expect(identityFrom(ok, 'https://kortix.com', frame)).toEqual({ userId: 'u1', email: 'a@x.test' });
  });
  test('rejects another origin, another source, or another message', () => {
    expect(identityFrom({ ...ok, origin: 'https://evil.test' }, 'https://kortix.com', frame)).toBeUndefined();
    expect(identityFrom({ ...ok, source: {} }, 'https://kortix.com', frame)).toBeUndefined();
    expect(identityFrom({ ...ok, data: { type: 'x', userId: 'u1' } }, 'https://kortix.com', frame)).toBeUndefined();
    expect(identityFrom({ ...ok, data: { type: 'kortix.identity', userId: 5 } }, 'https://kortix.com', frame)).toBeUndefined();
  });
  test('accounts differ only when both ids are known and unequal', () => {
    expect(accountsDiffer({ userId: 'a', email: '' }, { userId: 'b', email: '' })).toBe(true);
    expect(accountsDiffer({ userId: 'a', email: '' }, { userId: 'a', email: '' })).toBe(false);
    expect(accountsDiffer(undefined, { userId: 'b', email: '' })).toBe(false);
  });
});
