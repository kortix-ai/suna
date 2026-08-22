import { installDom, uninstallDom } from '@/features/session/timeline/__fixtures__/dom';
import { flush } from '@/features/session/timeline/__fixtures__/flush';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { __testing, useModelPricingLookup } from './model-pricing';

/**
 * `useModelPricingLookup` starts the models.dev prefetch on mount and flips
 * `pricingReady` when it lands. The fetch outlives the component: under
 * `bun test` the first DOM-mounting file of `src/features/session/` mounted
 * the transcript, unmounted it, tore its DOM down, and the fetch then
 * resolved into `react-dom`'s update path with no `window` —
 * `ReferenceError: window is not defined`, reported as an unhandled error
 * under whatever file ran next (3 of 14 full runs red with 0 failing tests).
 * The effect's cleanup now disarms the continuation.
 */

function Probe() {
  useModelPricingLookup(undefined);
  return null;
}

beforeAll(() => installDom());
afterAll(() => uninstallDom());

describe('useModelPricingLookup', () => {
  test('a prefetch that lands after unmount (and after the DOM is gone) sets no state', async () => {
    __testing.reset();
    // A models.dev fetch the test resolves by hand, after the unmount.
    const fetched: string[] = [];
    let land!: (r: Response) => void;
    globalThis.fetch = ((input: unknown) => {
      fetched.push(String(input));
      return new Promise<Response>((resolve) => {
        land = resolve;
      });
    }) as typeof fetch;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(<Probe />);
    await flush();
    expect(fetched).toEqual(['https://models.dev/api.json']);
    expect(__testing.pending()).not.toBeNull();

    root.unmount();
    await flush();
    container.remove();
    // The file's `afterAll` has run: no window, no document.
    uninstallDom();
    expect(typeof window).toBe('undefined');

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      land(new Response('{}', { headers: { 'content-type': 'application/json' } }));
      await __testing.pending();
      // The hook's `.then` ran before ours; give its (possible) rejection a
      // macrotask to be reported.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rejections.map((r) => String(r))).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      __testing.reset();
    }
  });
});
