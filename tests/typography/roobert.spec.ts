import { test, expect } from '@playwright/test';

// Each line is exactly 17 characters and contains the sequences that collapse:
// '->' and '<-' come from `calt`; 'tt', 'ff', 'ffi' come from `liga`.
// In a monospaced face all five MUST measure identically.
const LINES_17 = [
  'getAttribute->off', // -> plus tt
  'setTimeout offset', // tt plus ff
  'diff pattern buff', // ff plus tt
  'WWWWWWWWWWWWWWWWW', // widest glyph
  'iiiiiiiiiiiiiiiii', // narrowest glyph
];

test.describe('Roobert Mono', () => {
  test('keeps monospace cell alignment (F3 regression)', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate((lines) => {
      const widths: number[] = [];
      let fontFamily = '';
      let ligatures = '';
      for (const line of lines) {
        const s = document.createElement('span');
        // Use the real utility class so the app's cascade is what gets tested.
        s.className = 'font-mono';
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px';
        s.textContent = line;
        document.body.appendChild(s);
        const cs = getComputedStyle(s);
        fontFamily = cs.fontFamily;
        ligatures = cs.fontVariantLigatures;
        // Range, not the element box: a block would report container width.
        const r = document.createRange();
        r.selectNodeContents(s);
        widths.push(Math.round(r.getBoundingClientRect().width * 100) / 100);
        s.remove();
      }
      // `getComputedStyle().fontFamily` returns the DECLARED list, so it says
      // "Roobert, ui-monospace, …" whether or not Roobert actually loaded.
      // Only document.fonts.check tells us the face is really available.
      const roobertLoaded = document.fonts.check('32px Roobert');
      return { widths, fontFamily, ligatures, roobertLoaded };
    }, LINES_17);

    // Guard: the system fallback mono would ALSO align, which would make this
    // test pass while proving nothing. Assert the real font actually loaded
    // first — declared font-family alone is not enough (see roobertLoaded).
    expect(
      result.roobertLoaded,
      'Roobert did not load — the alignment assertion below would pass on the system fallback and prove nothing',
    ).toBe(true);
    // NOTE: Task 2 landed ONE @font-face family named 'Roobert' (globals.css:32),
    // not 'Roobert Mono' — mono-ness comes from the MONO=100 axis position via
    // --rb-mono, not from a separate family name. Assert on the family that
    // actually exists.
    expect(
      result.fontFamily,
      `expected Roobert, got ${result.fontFamily}`,
    ).toContain('Roobert');
    expect(result.ligatures).toBe('none');

    const spread = Math.max(...result.widths) - Math.min(...result.widths);
    expect(
      spread,
      `17-char lines must be equal width, got [${result.widths.join(', ')}]`,
    ).toBeLessThan(0.5);
  });

  test('does not apply display-only stylistic sets to code', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    const features = await page.evaluate(() => {
      const s = document.createElement('span');
      s.className = 'font-mono';
      s.style.cssText = 'position:absolute;left:-9999px';
      s.textContent = 'EFLy:;?';
      document.body.appendChild(s);
      const v = getComputedStyle(s).fontFeatureSettings;
      s.remove();
      return v;
    });
    // 'zero' stays (slashed zero disambiguates 0 from O). The display sets that
    // html/body set at element level must NOT reach code text.
    expect(features).toContain('zero');
    for (const set of ['ss03', 'ss04', 'ss09', 'ss10', 'ss14']) {
      expect(features, `${set} leaked into font-mono`).not.toContain(set);
    }
  });

  test('bare <pre> and <code> use Roobert Mono, not the system mono', async ({
    page,
  }) => {
    // The UA stylesheet sets font-family: monospace on pre/code/kbd/samp and
    // that beats inheritance. globals.css must target them explicitly.
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    const result = await page.evaluate(() => {
      const fams: Record<string, string> = {};
      for (const tag of ['pre', 'code']) {
        const el = document.createElement(tag);
        el.style.cssText = 'position:absolute;left:-9999px';
        el.textContent = 'const x = 1;';
        document.body.appendChild(el);
        fams[tag] = getComputedStyle(el).fontFamily;
        el.remove();
      }
      // `getComputedStyle().fontFamily` returns the DECLARED list, so it says
      // "Roobert, ui-monospace, …" whether or not Roobert actually loaded.
      // Only document.fonts.check tells us the face is really available.
      const roobertLoaded = document.fonts.check('32px Roobert');
      return { fams, roobertLoaded };
    });
    // Guard: the system mono (ui-monospace/Menlo/etc.) would satisfy the UA
    // stylesheet just as well, which would make this test pass while proving
    // nothing about which font actually renders.
    expect(
      result.roobertLoaded,
      'Roobert did not load — the family assertions below would pass on the system mono and prove nothing',
    ).toBe(true);
    expect(result.fams.pre).toContain('Roobert');
    expect(result.fams.code).toContain('Roobert');
  });
});
