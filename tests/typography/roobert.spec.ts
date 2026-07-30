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

    // 0.5px, not 0: sub-pixel layout rounding leaves a residual even in a
    // perfectly monospaced face (measured 0.14px across the five lines). A
    // real ligature collapse is ~60px at 32px type, and was 411px before
    // --rb-mono landed — so this threshold cannot mask the bug it guards.
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

// wght is a 300-900 axis. Tailwind's default numeric names imply 100-950 and the
// browser silently clamps, so font-thin and font-extralight both used to render
// as Light 300. These ten spread the ten names across the real axis: 400-800 are
// unchanged, only light (300->368) and black (900->870) shift.
const LADDER: Array<[string, number]> = [
  ['font-thin', 300],
  ['font-extralight', 335],
  ['font-light', 368],
  ['font-normal', 400],
  ['font-medium', 500],
  ['font-semibold', 600],
  ['font-bold', 700],
  ['font-extrabold', 800],
  ['font-black', 870],
  ['font-heavy', 900],
];

test.describe('Roobert weight ladder', () => {
  // Asserts the UTILITIES, not the --font-weight-* tokens. Two reasons, both
  // learned the hard way:
  //   1. Tailwind v4 emits a utility only when its class name appears in scanned
  //      source. These ten resolve only because /design-system names all ten
  //      literally. If this test fails with everything reporting 500, that
  //      specimen has stopped naming them literally (e.g. refactored into a loop
  //      over a variable) — the mapping has not regressed.
  //   2. The tokens live in `@theme inline`, which bakes literals into the
  //      utilities and emits NO :root custom property, so reading
  //      --font-weight-* from the DOM returns "" and proves nothing.
  test('all ten weight utilities resolve onto the real axis, distinctly', async ({
    page,
  }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const measured = await page.evaluate((ladder) => ({
      roobertLoaded: document.fonts.check('64px Roobert'),
      rows: ladder.map(([cls]) => {
        const s = document.createElement('span');
        s.className = cls;
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:64px';
        s.textContent = 'Hamburgefonstiv 0123';
        document.body.appendChild(s);
        const r = document.createRange();
        r.selectNodeContents(s);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        const weight = Number(getComputedStyle(s).fontWeight);
        s.remove();
        return { cls, weight, width };
      }),
    }), LADDER);

    // Without the real font every weight renders identically, making the
    // distinctness assertion below meaningless.
    expect(
      measured.roobertLoaded,
      'Roobert did not load — weight comparisons would be against a fallback face',
    ).toBe(true);

    for (const [cls, expected] of LADDER) {
      const row = measured.rows.find((r) => r.cls === cls)!;
      expect(
        row.weight,
        `${cls} resolved to ${row.weight}, expected ${expected}. A value of 500 means Tailwind never emitted the utility — check /design-system still names it literally.`,
      ).toBe(expected);
    }

    // Each must actually RENDER differently. A weight outside the design space
    // would still report the right font-weight while drawing an identical glyph —
    // exactly the bug this task fixes.
    const widths = measured.rows.map((r) => r.width);
    expect(
      new Set(widths).size,
      `expected 10 distinct widths, got ${JSON.stringify(measured.rows)}`,
    ).toBe(10);

    // Monotonic: a heavier step must never render narrower than a lighter one.
    for (let i = 1; i < widths.length; i++) {
      expect(
        widths[i],
        `${LADDER[i][0]} (${widths[i]}px) should exceed ${LADDER[i - 1][0]} (${widths[i - 1]}px)`,
      ).toBeGreaterThan(widths[i - 1]);
    }
  });
});

test.describe('Roobert SemiMono', () => {
  // font-semimono sits at MONO=60 — between the sans (0) and the mono (100).
  // It must NOT be monospaced: it exists for IDs, hashes and timestamps, where
  // full mono is too wide and the sans is too loose. If MONO ever drifts to
  // 100 (e.g. someone "fixing" it to look more monospaced), every
  // column-aligned use of font-semimono would start lying about alignment.
  test('is proportional, not monospaced (guards MONO=60, not 100)', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate(() => {
      const measure = (text: string) => {
        const s = document.createElement('span');
        // Use the real utility class so the app's cascade is what gets tested.
        s.className = 'font-semimono';
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px';
        s.textContent = text;
        document.body.appendChild(s);
        const cs = getComputedStyle(s);
        const fontFamily = cs.fontFamily;
        // Range, not the element box: a block would report container width.
        const r = document.createRange();
        r.selectNodeContents(s);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        s.remove();
        return { width, fontFamily };
      };
      const w = measure('WWWWWWWWWW');
      const m = measure('mmmmmmmmmm');
      // `getComputedStyle().fontFamily` returns the DECLARED list, so it says
      // "Roobert, ui-sans-serif, …" whether or not Roobert actually loaded.
      // Only document.fonts.check tells us the face is really available.
      const roobertLoaded = document.fonts.check('32px Roobert');
      return { w, m, roobertLoaded };
    });

    // Guard: the system sans fallback would ALSO be proportional, which would
    // make this test pass while proving nothing about font-semimono. Assert
    // the real font actually loaded first.
    expect(
      result.roobertLoaded,
      'Roobert did not load — the proportional assertion below would pass on the system fallback and prove nothing',
    ).toBe(true);
    expect(
      result.w.fontFamily,
      `expected Roobert, got ${result.w.fontFamily}`,
    ).toContain('Roobert');

    // The actual guard. WWWWWWWWWW measured 371.72px vs mmmmmmmmmm 350.80px at
    // MONO=60 — a real but modest gap, unlike a monospaced face where both
    // would land within ~0.5px of each other (see the Roobert Mono suite
    // above). Flipping the `.font-semimono` --rb-mono stop from 60 to 100
    // collapses this gap to near zero and must fail this assertion.
    const diff = result.w.width - result.m.width;
    expect(
      diff,
      `W vs m must differ meaningfully (SemiMono is proportional, not monospaced) — got W=${result.w.width}px m=${result.m.width}px`,
    ).toBeGreaterThan(5);
  });
});
