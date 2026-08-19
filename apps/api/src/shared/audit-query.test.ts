import { describe, expect, test } from 'bun:test';
import {
  parseAuditCursor,
  parseAuditInstant,
  parseAuditLimit,
  parseAuditSessionCursor,
} from './audit-query';

describe('strict audit query validation', () => {
  test('accepts exact limits and rejects clamping or parseInt prefixes', () => {
    expect(parseAuditLimit(null)).toBe(50);
    expect(parseAuditLimit('200')).toBe(200);
    for (const value of ['0', '-1', '201', '12x', '1.5', '']) {
      expect(() => parseAuditLimit(value)).toThrow('limit must be an integer');
    }
  });

  test('accepts ISO instants and rejects date-only or normalized garbage', () => {
    expect(parseAuditInstant('2026-08-07T12:00:00Z', 'since')?.toISOString()).toBe(
      '2026-08-07T12:00:00.000Z',
    );
    for (const value of ['2026-08-07', 'yesterday', '2026-13-40T99:00:00Z']) {
      expect(() => parseAuditInstant(value, 'since')).toThrow('since must be an ISO-8601 instant');
    }
  });

  test('validates every cursor component', () => {
    const id = 'a7100000-0000-4000-a000-000000000001';
    expect(parseAuditCursor(`2026-08-07T12:00:00Z|${id}`)?.eventId).toBe(id);
    expect(parseAuditSessionCursor(`42|${id}`)?.sequence).toBe(42);
    for (const value of ['bad', `yesterday|${id}`, '2026-08-07T12:00:00Z|bad', `x|${id}`]) {
      expect(() => parseAuditCursor(value)).toThrow();
    }
  });
});
