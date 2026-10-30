import { describe, expect, mock, test } from 'bun:test';
import { safeScrollTo } from './safe-scroll-to';

describe('safeScrollTo', () => {
  // The exact production failure shape: `t.scrollTo is not a function`.
  // `t` is NOT null — it's a truthy value (a ref object / non-element) that
  // lacks `.scrollTo`. The guard must swallow this instead of throwing.
  test('does not throw when the target lacks scrollTo (truthy non-element)', () => {
    expect(() => safeScrollTo({}, { top: 10 })).not.toThrow();
    expect(() => safeScrollTo({ current: null } as unknown as never, { top: 10 })).not.toThrow();
    expect(() =>
      safeScrollTo({ scrollTo: 'not-a-function' } as unknown as never, { top: 10 }),
    ).not.toThrow();
  });

  test('tolerates null and undefined', () => {
    expect(() => safeScrollTo(null, { top: 10 })).not.toThrow();
    expect(() => safeScrollTo(undefined, { top: 10 })).not.toThrow();
  });

  test('calls .scrollTo with the given options on a real scrollable element (happy path)', () => {
    const scrollTo = mock((_opts?: ScrollToOptions) => {});
    const el = { scrollTo } as unknown as Element;
    const options: ScrollToOptions = { top: 42, behavior: 'smooth' };
    safeScrollTo(el, options);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(options);
  });

  test('does not call .scrollTo when omitted but el is present', () => {
    const el = {} as { scrollTo?: (opts?: ScrollToOptions) => void };
    expect(() => safeScrollTo(el, { top: 0 })).not.toThrow();
  });
});
