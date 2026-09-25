import { describe, expect, test } from 'bun:test';
import { isUuid, UUID_RE } from './validate';

describe('isUuid — the shape a PostgreSQL uuid column accepts', () => {
  test('accepts RFC 4122 ids of every version', () => {
    for (const id of [
      'a7100000-0000-4000-a000-000000000001', // v4
      '01890a5d-ac96-774b-bcce-b302099a8057', // v7
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8', // v1
    ]) {
      expect(isUuid(id)).toBe(true);
    }
  });

  test('accepts ids outside the RFC version and variant ranges', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true); // nil
    expect(isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true); // max
    expect(isUuid('a7100000-0000-0000-0000-000000000001')).toBe(true); // version 0, variant 0
  });

  test('accepts upper and mixed case', () => {
    expect(isUuid('A7100000-0000-4000-A000-00000000000F')).toBe(true);
    expect(isUuid('a7100000-0000-4000-A000-00000000000f')).toBe(true);
  });

  test('refuses garbage, wrong grouping, braces, and non-strings', () => {
    for (const value of [
      '',
      'not-a-uuid',
      'a7100000000040000a000000000000001',
      'a7100000-0000-4000-a000-00000000000',
      'a7100000-0000-4000-a000-0000000000011',
      '{a7100000-0000-4000-a000-000000000001}',
      ' a7100000-0000-4000-a000-000000000001',
      'g7100000-0000-4000-a000-000000000001',
      'a7100000-0000-4000-a000-000000000001\n',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  test('UUID_RE is stateless across calls', () => {
    const id = 'a7100000-0000-4000-a000-000000000001';
    expect([UUID_RE.test(id), UUID_RE.test(id), UUID_RE.test(id)]).toEqual([true, true, true]);
  });
});
