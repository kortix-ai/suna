import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nextConfig = () =>
  readFileSync(resolve(import.meta.dir, '../../next.config.ts'), 'utf8');

describe('router client cache', () => {
  // Without this, `staleTimes.dynamic` defaults to 0 and every navigation to a
  // route under the cookie-reading `projects/[id]/layout.tsx` discards its
  // segment and repaints `loading.tsx`. See
  // node_modules/next/dist/docs/01-app/02-guides/prefetching.md:61.
  test('dynamic segments are cached for five minutes', () => {
    const source = nextConfig();
    expect(source).toContain('staleTimes:');
    const dynamic = source.match(/staleTimes:\s*\{[^}]*dynamic:\s*(\d+)/)?.[1];
    expect(Number(dynamic)).toBe(300);
  });

  test('static segments keep at least the Next default', () => {
    const source = nextConfig();
    const staticTtl = source.match(/staleTimes:\s*\{[^}]*static:\s*(\d+)/)?.[1];
    expect(Number(staticTtl)).toBeGreaterThanOrEqual(300);
  });
});
