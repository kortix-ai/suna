import { describe, expect, test } from 'bun:test';
import { toCsv } from '../../src/lib/csv';

describe('toCsv', () => {
  test('quotes commas, quotes and newlines; leaves plain fields alone', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', 'two\nlines', 3]])).toBe('a,"b,c","say ""hi""","two\nlines",3');
  });

  test('neutralizes spreadsheet formulas', () => {
    expect(toCsv([['=HYPERLINK("x")', '+1', '-2', '@SUM']])).toBe(`"'=HYPERLINK(""x"")",'+1,'-2,'@SUM`);
  });

  test('rows join with CRLF', () => {
    expect(toCsv([['h1', 'h2'], ['v1', 'v2']])).toBe('h1,h2\r\nv1,v2');
  });
});
