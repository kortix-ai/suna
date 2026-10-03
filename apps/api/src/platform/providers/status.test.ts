import { describe, expect, test } from 'bun:test';
import { isProviderNotFound } from './status';

describe('isProviderNotFound', () => {
  const named = (name: string, fields: Record<string, unknown> = {}) =>
    Object.assign(new Error('x'), { name, ...fields });

  test('a 404, a not_found code or an SDK not-found class', () => {
    expect(isProviderNotFound(named('PlatinumHttpError', { status: 404 }))).toBe(true);
    expect(isProviderNotFound(named('DaytonaNotFoundError', { statusCode: 404 }))).toBe(true);
    expect(isProviderNotFound(named('SandboxNotFoundError'))).toBe(true);
    expect(isProviderNotFound(named('Error', { code: 'not_found' }))).toBe(true);
  });

  test('a 500 whose message says "not found" is not a lost box', () => {
    const err = Object.assign(new Error('sandbox not found in scheduler cache'), {
      name: 'DaytonaError',
      statusCode: 500,
    });
    expect(isProviderNotFound(err)).toBe(false);
    expect(isProviderNotFound(new Error('platinum GET /v1/sandboxes/x -> 500 {"error":"not found"}'))).toBe(false);
  });
});
