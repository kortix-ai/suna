import { test, expect } from '@playwright/test';

// Served by the webServer in playwright.config.ts, rooted at the repo root.
// Must be HTTP — @font-face is blocked under file://.
const FIXTURE = 'http://127.0.0.1:8842/tests/typography/fixtures/descriptor.html';

const measureIn = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    for (const f of ['DESC-Sans', 'DESC-Mono', 'ELEM']) {
      await document.fonts.load(`400 48px "${f}"`);
    }
    await document.fonts.ready;

    const measure = (css: string, text = 'Hamburgefonstiv 0123') => {
      const s = document.createElement('span');
      s.style.cssText =
        'display:inline-block;white-space:pre;font-size:48px;' + css;
      s.textContent = text;
      document.body.appendChild(s);
      const r = document.createRange();
      r.selectNodeContents(s);
      const w = r.getBoundingClientRect().width;
      s.remove();
      return Math.round(w * 100) / 100;
    };

    const el = (mono: number, ital = 0, text?: string) =>
      measure(
        `font-family:'ELEM';font-variation-settings:'MONO' ${mono},'ital' ${ital}`,
        text,
      );

    return {
      // A fetch failure would make every family identical, which reads exactly
      // like "technique unsupported". Report load state so that is unmistakable.
      loaded: [...document.fonts].map((f) => `${f.family}:${f.status}`),
      // Technique B — element level (adopted).
      elemSans: el(0),
      elemSemi: el(60),
      elemMono: el(100),
      elemItal: el(0, 11),
      elemMonoW: el(100, 0, 'WWWWWWWWWW'),
      elemMonoM: el(100, 0, 'mmmmmmmmmm'),
      elemSemiW: el(60, 0, 'WWWWWWWWWW'),
      elemSemiM: el(60, 0, 'mmmmmmmmmm'),
      elemW300: measure("font-family:'ELEM';font-weight:300"),
      elemW900: measure("font-family:'ELEM';font-weight:900"),
      // Technique A — descriptor (rejected).
      descSans: measure("font-family:'DESC-Sans'"),
      descMono: measure("font-family:'DESC-Mono'"),
    };
  });

test.describe('Roobert axis pinning', () => {
  test('element-level font-variation-settings pins every axis, in every engine', async ({
    page,
  }) => {
    const urls = new Set<string>();
    page.on('response', (r) => {
      if (r.url().endsWith('.woff2')) urls.add(r.url());
    });

    await page.goto(FIXTURE);
    const m = await measureIn(page);

    expect(
      m.loaded.filter((s) => s.endsWith(':loaded')).length,
      `fonts did not load — got ${JSON.stringify(m.loaded)}`,
    ).toBeGreaterThanOrEqual(3);

    // MONO=100 must be truly monospaced: W and m share one advance.
    expect(
      Math.abs(m.elemMonoW - m.elemMonoM),
      `MONO=100 not monospaced: W=${m.elemMonoW} m=${m.elemMonoM}`,
    ).toBeLessThan(0.5);

    // MONO=60 must NOT be monospaced (spec F7).
    expect(
      Math.abs(m.elemSemiW - m.elemSemiM),
      `MONO=60 unexpectedly monospaced: W=${m.elemSemiW} m=${m.elemSemiM}`,
    ).toBeGreaterThan(5);

    // The three MONO stops must be ordered sans < semi < mono.
    expect(m.elemSans).toBeLessThan(m.elemSemi);
    expect(m.elemSemi).toBeLessThan(m.elemMono);

    // ital=11 must actually slant.
    expect(Math.abs(m.elemItal - m.elemSans)).toBeGreaterThan(0.5);

    // Pinning MONO must not lock wght — font-weight still drives the axis.
    expect(m.elemW300).not.toBe(m.elemW900);

    // The payload claim: all faces come from ONE binary URL.
    expect([...urls]).toHaveLength(1);
  });

  test('the @font-face descriptor is NOT portable — this is why we do not use it', async ({
    page,
    browserName,
  }) => {
    await page.goto(FIXTURE);
    const m = await measureIn(page);
    const descriptorPins = Math.abs(m.descMono - m.descSans) > 5;

    if (browserName === 'webkit') {
      // WebKit ignores the descriptor entirely: MONO=100 renders proportional,
      // so shipping descriptor-pinned families would give Safari users code in
      // a proportional face. If this ever starts passing, WebKit gained support
      // and the app COULD be simplified — revisit deliberately, do not just
      // flip the assertion.
      expect(
        descriptorPins,
        `WebKit now honours the @font-face descriptor (sans=${m.descSans} mono=${m.descMono}). Revisit the design.`,
      ).toBe(false);
    } else {
      expect(
        descriptorPins,
        `${browserName} should honour the descriptor (sans=${m.descSans} mono=${m.descMono})`,
      ).toBe(true);
    }
  });
});
