import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let staticFileUrl = '';

mock.module('@kortix/sdk/react', () => ({
  getActiveStaticFilePreviewUrl: () => staticFileUrl,
}));

const { isBrowserViewable, openFileInNewTab, RuntimeNotBoundError, uniqueZipNames } = await import(
  './runtime-files'
);

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
let opened: string[] = [];

beforeEach(() => {
  opened = [];
  staticFileUrl = '';
  globalThis.window = {
    open: (url: string) => {
      opened.push(url);
      return null;
    },
  } as unknown as Window & typeof globalThis;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

describe('isBrowserViewable (W4)', () => {
  test('inert-as-a-top-level-document formats open in a new tab', () => {
    for (const f of ['a.pdf', 'a.png', 'a.jpg', 'a.txt']) {
      expect(isBrowserViewable(f)).toBe(true);
    }
  });
  test('HTML and SVG are excluded — a top-level tab has no sandbox attribute', () => {
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

describe('openFileInNewTab', () => {
  test('opens the addressable proxy URL, never a blob', async () => {
    staticFileUrl = 'https://api.kortix.com/v1/p/sbx1/3211/open?path=/workspace/a.md';

    await openFileInNewTab('/workspace/a.md');

    expect(opened).toEqual(['https://api.kortix.com/v1/p/sbx1/3211/open?path=/workspace/a.md']);
    expect(opened[0].startsWith('blob:')).toBe(false);
  });

  test('opens the local-dev subdomain form, which only looks localhost-ish', async () => {
    staticFileUrl = 'http://p3211-sbx1.localhost:8008/open?path=/workspace/a.md';

    await openFileInNewTab('/workspace/a.md');

    expect(opened).toEqual(['http://p3211-sbx1.localhost:8008/open?path=/workspace/a.md']);
  });

  test('refuses to open a localhost URL when the runtime has not bound', async () => {
    staticFileUrl = 'http://localhost:3211/open?path=/workspace/a.md';

    await expect(openFileInNewTab('/workspace/a.md')).rejects.toBeInstanceOf(RuntimeNotBoundError);
    expect(opened).toEqual([]);
  });

  test('refuses to open when no URL can be built at all', async () => {
    staticFileUrl = '';

    await expect(openFileInNewTab('/workspace/a.md')).rejects.toBeInstanceOf(RuntimeNotBoundError);
    expect(opened).toEqual([]);
  });
});
