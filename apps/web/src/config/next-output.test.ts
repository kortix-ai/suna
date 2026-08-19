import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');

describe('Next output mode', () => {
  test('disables standalone output when the Vercel adapter runs', () => {
    expect(nextConfig).toMatch(
      /output:\s*IS_PREVIEW_BUILD\s*\|\|\s*process\.env\.VERCEL\s*\?\s*undefined\s*:\s*'standalone'/,
    );
  });
});
