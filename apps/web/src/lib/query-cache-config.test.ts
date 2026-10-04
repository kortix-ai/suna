import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { testUiTranslator } from '@/i18n/test-translator';

import { buildQueryClientDefaults } from './query-client-defaults';

const nextConfig = () => readFileSync(resolve(import.meta.dir, '../../next.config.ts'), 'utf8');

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
  // The defaults moved from an inline object in `app/react-query-provider.tsx`
  // to `lib/query-client-defaults.ts`; the same facts, now pinned as code
  // instead of source anchors.
  const defaults = buildQueryClientDefaults(testUiTranslator);

  // gcTime === staleTime evicts an unobserved entry at the exact moment it
  // goes stale, so there is never a stale-while-revalidate window to render
  // from. gcTime must strictly exceed staleTime for cached content to survive
  // long enough to be worth having.
  test('gcTime strictly exceeds staleTime', () => {
    const stale = defaults.queries?.staleTime;
    const gc = defaults.queries?.gcTime;
    expect(typeof stale).toBe('number');
    expect(typeof gc).toBe('number');
    expect(gc!).toBeGreaterThan(stale!);
  });

  test('gcTime is at least thirty minutes', () => {
    expect(defaults.queries?.gcTime).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  test('queries are refetched on mount and never on focus or reconnect', () => {
    expect(defaults.queries?.refetchOnMount).toBe(true);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.refetchOnReconnect).toBe(false);
    expect(defaults.queries?.structuralSharing).toBe(true);
  });

  test('query retry stops at any 4xx and caps at three attempts', () => {
    const retry = defaults.queries?.retry as
      | ((failureCount: number, error: unknown) => boolean)
      | undefined;
    expect(retry).toBeDefined();
    expect(retry!(0, { status: 404 })).toBe(false);
    expect(retry!(0, { status: 401 })).toBe(false);
    expect(retry!(0, new Error('network'))).toBe(true);
    expect(retry!(3, new Error('network'))).toBe(false);
  });

  test('mutation retry stops at any 4xx and allows exactly one retry otherwise', () => {
    const retry = defaults.mutations?.retry as
      | ((failureCount: number, error: unknown) => boolean)
      | undefined;
    expect(retry).toBeDefined();
    expect(retry!(0, { status: 409 })).toBe(false);
    expect(retry!(0, new Error('network'))).toBe(true);
    expect(retry!(1, new Error('network'))).toBe(false);
  });
});
