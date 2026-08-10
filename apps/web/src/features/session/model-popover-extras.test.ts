import { describe, expect, test } from 'bun:test';

import { computeModelExtrasRows } from './model-popover-extras';

/**
 * The popover's extras footer is variant-only. Reasoning effort used to be a
 * second row here and is now its own toolbar control
 * (`reasoning-effort-selector.tsx`), so the cases that used to cover it are
 * gone rather than rewritten — there is no reasoning row left to assert on.
 */
describe('computeModelExtrasRows', () => {
  test('variants plus a handler shows the row and the wrapping section', () => {
    expect(computeModelExtrasRows({ variants: ['thinking'], hasVariantHandler: true })).toEqual({
      showVariantRow: true,
      showSection: true,
    });
  });

  test('variants with NO handler shows nothing — a read-only picker grows no controls', () => {
    expect(computeModelExtrasRows({ variants: ['thinking'], hasVariantHandler: false })).toEqual({
      showVariantRow: false,
      showSection: false,
    });
  });

  test('a handler with no variants shows nothing — no empty row', () => {
    expect(computeModelExtrasRows({ variants: [], hasVariantHandler: true })).toEqual({
      showVariantRow: false,
      showSection: false,
    });
  });

  test('neither shows nothing — the default for every non-composer call site', () => {
    // Every `ModelSelector` outside the composer passes no variants at all;
    // this is the case that keeps their popover byte-identical.
    expect(computeModelExtrasRows({ variants: [], hasVariantHandler: false })).toEqual({
      showVariantRow: false,
      showSection: false,
    });
  });

  test('showSection tracks showVariantRow exactly, now that it is the only row', () => {
    for (const variants of [[], ['thinking']]) {
      for (const hasVariantHandler of [true, false]) {
        const rows = computeModelExtrasRows({ variants, hasVariantHandler });
        expect(rows.showSection).toBe(rows.showVariantRow);
      }
    }
  });
});
