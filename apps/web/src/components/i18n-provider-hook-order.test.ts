import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for minified React error #467 — "Update hook called on
 * initial render" — thrown during hydration (Better Stack pattern ed5fc3f3).
 *
 * `CatalogProvider` suspends on the first client render, so React replays it
 * with the rerender dispatcher (ReactFiberHooks `renderWithHooksAgain`).
 * React's `useThenable` switches that dispatcher back to mount/update only
 * while the `use()` call runs. The old `getLoadedCatalog(locale) ??
 * use(hydrationCatalog(locale))` short circuit skipped `use()` once the
 * catalog had loaded, which left the rerender dispatcher active; the following
 * `useState` then threw #467.
 *
 * `apps/web` registers no DOM harness for `bun test` (no jsdom/happy-dom), so
 * the hydration replay cannot be driven in-process. This test locks the
 * invariant the fix depends on: the client catalog is read through exactly one
 * unconditional `use(...)`, never through a direct-cache short circuit.
 */
const src = readFileSync(resolve(import.meta.dir, 'i18n-provider.tsx'), 'utf8');

describe('i18n provider catalog hook order', () => {
  test('resolves the client catalog through exactly one unconditional use()', () => {
    const bareUseCalls = src.match(/\buse\(/g) ?? [];
    expect(bareUseCalls).toHaveLength(1);
    expect(src).toContain('use(hydrationCatalog(initialLocale))');
  });

  test('does not short-circuit use() with a direct cache read', () => {
    expect(src).not.toContain('?? use(');
    expect(src).not.toContain('getLoadedCatalog');
  });
});
