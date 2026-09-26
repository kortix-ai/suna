import { describe, expect, test } from 'bun:test';

import { sheetScrimColor } from './sheet-scrim';

/** `hsl(0 0% L%)` → its 0–255 channel value (neutral: r = g = b). */
function greyLevel(hsl: string): number {
  const m = hsl.match(/^hsl\(0 0% ([\d.]+)%\)$/);
  if (!m) throw new Error(`not a neutral hsl: ${hsl}`);
  return (Number(m[1]) / 100) * 255;
}

/** One channel of `over` at `alpha` composited on `under`. */
const composite = (under: number, over: number, alpha: number) => under * (1 - alpha) + over * alpha;

// `DARK_BACKGROUND` / `DARK_POPOVER` (= global.css `--background`
// / `--popover` in `.dark:root`, pinned by lib/utils/theme.test.ts).
const DARK_BACKGROUND = 'hsl(0 0% 4.3%)';
const DARK_POPOVER = 'hsl(0 0% 7.8%)';

describe('sheetScrimColor', () => {
  test('light mode keeps gorhom’s black scrim', () => {
    expect(sheetScrimColor(false, DARK_BACKGROUND)).toBeUndefined();
  });

  test('dark mode fades toward the page background, a neutral grey', () => {
    expect(sheetScrimColor(true, DARK_BACKGROUND)).toBe(DARK_BACKGROUND);
    expect(() => greyLevel(sheetScrimColor(true, DARK_BACKGROUND)!)).not.toThrow();
  });

  test('dark page under the 50% scrim stays at its own level; black would sink it to ~5', () => {
    const page = greyLevel(DARK_BACKGROUND); // ≈ 11
    const scrim = greyLevel(sheetScrimColor(true, DARK_BACKGROUND)!);
    expect(Math.round(composite(page, scrim, 0.5))).toBe(Math.round(page));
    expect(Math.round(composite(page, 0, 0.5))).toBe(5);
  });

  test('white content still dims by about half, and the sheet stays above the dimmed page', () => {
    const scrim = greyLevel(sheetScrimColor(true, DARK_BACKGROUND)!);
    expect(Math.round(composite(255, scrim, 0.5))).toBe(133);
    expect(greyLevel(DARK_POPOVER)).toBeGreaterThan(greyLevel(DARK_BACKGROUND));
  });
});
