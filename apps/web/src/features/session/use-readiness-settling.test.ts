import { describe, expect, test } from 'bun:test';
import { READINESS_SETTLE_MS } from './use-readiness-settling';

describe('READINESS_SETTLE_MS', () => {
  // The window only buys silence for the first probe round trip. Anything
  // longer delays a REAL wake notice on a parked box, which is the state the
  // notice exists for.
  test('is short enough that a real wake still announces itself promptly', () => {
    expect(READINESS_SETTLE_MS).toBeLessThanOrEqual(2_000);
  });

  test('is long enough to cover a first health probe', () => {
    expect(READINESS_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
  });
});

// The hook's own defect, found by an audit of this change: an earlier cut kept
// the window's identity in a ref that the EFFECT bumped and the RENDER read, so
// on the first render of each window they disagreed, the hook answered "not
// settling", and the composer painted the very notice it exists to suppress.
describe('useReadinessSettling contract', () => {
  test('the window identity is state, never a ref bumped inside an effect', async () => {
    const source = await Bun.file(
      new URL('./use-readiness-settling.ts', import.meta.url).pathname,
    ).text();

    expect(source).not.toMatch(/armRef|useRef/);
    // Settling must be TRUE before the effect has had a chance to run — that is
    // the render the flash happened on.
    expect(source).toMatch(/openedAt === null \|\|/);
  });
});
