import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');

describe('Next output mode', () => {
  test('disables standalone output when the Vercel adapter runs', () => {
    // Asserted against the SOURCE rather than the evaluated config because
    // importing next.config.ts has side effects (asset copies, manifest writes).
    // `\s` spans newlines, so the prettier-wrapped nested ternary still matches.
    expect(nextConfig).toMatch(
      /output:[\s\S]{0,80}?IS_PREVIEW_BUILD\s*\|\|\s*process\.env\.VERCEL\s*\?\s*undefined\s*:\s*'standalone'/,
    );
  });

  test('exports static output for the desktop bundle', () => {
    // The desktop installer serves a static export from a loopback server and
    // has no Node runtime, so 'standalone' there would ship a server that can
    // never start. Guarded in the same place as the Vercel branch because both
    // are one expression — editing either can silently drop the other.
    expect(nextConfig).toMatch(/output:\s*IS_DESKTOP_BUILD\s*\?\s*'export'/);
  });
});
