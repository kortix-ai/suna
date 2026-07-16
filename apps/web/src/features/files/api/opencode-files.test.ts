import { describe, expect, test } from 'bun:test';
import { isBrowserViewable, uniqueZipNames } from './opencode-files';

describe('isBrowserViewable (W4)', () => {
  test('inert-as-a-top-level-document formats open in a new tab', () => {
    for (const f of ['a.pdf', 'a.png', 'a.jpg', 'a.txt']) {
      expect(isBrowserViewable(f)).toBe(true);
    }
  });
  test('HTML and SVG are excluded — a same-origin blob URL would execute them (XSS)', () => {
    for (const f of ['a.html', 'a.htm', 'a.svg']) {
      expect(isBrowserViewable(f)).toBe(false);
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

  // ─── MINOR SWEEP (b) — a colon (and the rest of Windows' reserved set) in
  // an entry name breaks extraction on Windows even though the zip itself
  // built fine on macOS/Linux. Sanitize before dedup so the zip is
  // extractable cross-platform. ──
  test('sanitizes characters that break Windows extraction', () => {
    expect(uniqueZipNames(['Pitch: intro.pptx'])).toEqual(['Pitch- intro.pptx']);
    expect(uniqueZipNames(['a<b>c|d?e*f"g.txt'])).toEqual(['a-b-c-d-e-f-g.txt']);
  });

  test('sanitized collisions still dedupe against each other', () => {
    expect(uniqueZipNames(['Pitch: v1.pptx', 'Pitch- v1.pptx'])).toEqual([
      'Pitch- v1.pptx',
      'Pitch- v1-2.pptx',
    ]);
  });
});
