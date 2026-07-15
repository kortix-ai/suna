import { describe, expect, test } from 'bun:test';
import { isBrowserViewable } from './opencode-files';

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
