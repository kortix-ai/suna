import { describe, expect, test } from 'bun:test';
import { isUniqueViolation } from './postgres-errors';

describe('isUniqueViolation', () => {
  test('recognizes direct and wrapped PostgreSQL unique violations', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { code: '23505' } } })).toBe(true);
  });

  test('rejects other and malformed errors', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('duplicate key'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
