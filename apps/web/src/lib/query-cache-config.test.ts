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

describe('react-query defaults', () => {
  const provider = () =>
    readFileSync(resolve(import.meta.dir, '../app/react-query-provider.tsx'), 'utf8');

  // gcTime === staleTime evicts an unobserved entry at the exact moment it
  // goes stale, so there is never a stale-while-revalidate window to render
  // from. gcTime must strictly exceed staleTime for cached content to survive
  // long enough to be worth having.
  test('gcTime strictly exceeds staleTime', () => {
    const source = provider();
    const stale = source.match(/staleTime:\s*([\d\s*]+),/)?.[1];
    const gc = source.match(/gcTime:\s*([\d\s*]+),/)?.[1];
    expect(stale).toBeTruthy();
    expect(gc).toBeTruthy();
    // eslint-disable-next-line no-eval -- arithmetic literals only, from our own source
    expect(eval(gc!)).toBeGreaterThan(eval(stale!));
  });

  test('gcTime is at least thirty minutes', () => {
    const gc = provider().match(/gcTime:\s*([\d\s*]+),/)?.[1];
    // eslint-disable-next-line no-eval -- arithmetic literals only, from our own source
    expect(eval(gc!)).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});
