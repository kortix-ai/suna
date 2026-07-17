import { describe, expect, test } from 'bun:test';

import { isBlobUrl } from './xlsx-renderer';

describe('isBlobUrl', () => {
  test('true only for blob: URLs', () => {
    expect(isBlobUrl('blob:http://localhost/abc')).toBe(true);
    expect(isBlobUrl('/workspace/report.xlsx')).toBe(false);
    expect(isBlobUrl('https://example.com/report.xlsx')).toBe(false);
  });
});
