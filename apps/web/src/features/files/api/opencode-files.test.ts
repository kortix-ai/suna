import { describe, expect, test } from 'bun:test';
import { isBrowserViewable, uniqueZipNames } from './opencode-files';

describe('isBrowserViewable (W4)', () => {
  test('browsers render these natively', () => {
    for (const f of ['a.pdf', 'a.html', 'a.png', 'a.jpg', 'a.svg', 'a.txt']) {
      expect(isBrowserViewable(f)).toBe(true);
    }
  });
  test('everything else downloads instead — no disabled mystery button', () => {
    for (const f of ['a.xlsx', 'a.docx', 'a.pptx', 'a.ts', 'a.zip']) {
      expect(isBrowserViewable(f)).toBe(false);
    }
  });
});

describe('uniqueZipNames (W15)', () => {
  test('same basename from different directories never overwrites inside the zip', () => {
    expect(uniqueZipNames(['report.md', 'report.md', 'data.csv', 'report.md'])).toEqual([
      'report.md',
      'report-2.md',
      'data.csv',
      'report-3.md',
    ]);
  });

  test('names without an extension still dedupe', () => {
    expect(uniqueZipNames(['LICENSE', 'LICENSE'])).toEqual(['LICENSE', 'LICENSE-2']);
  });
});
