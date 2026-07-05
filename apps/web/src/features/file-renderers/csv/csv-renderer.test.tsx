import { describe, expect, test } from 'bun:test';

import { hasCsvContent } from './csv-renderer';

describe('hasCsvContent', () => {
  test('false for empty, whitespace, or missing content', () => {
    expect(hasCsvContent('')).toBe(false);
    expect(hasCsvContent('   \n\t')).toBe(false);
    expect(hasCsvContent(undefined)).toBe(false);
  });

  test('true for actual delimited content', () => {
    expect(hasCsvContent('a,b\n1,2')).toBe(true);
  });
});
