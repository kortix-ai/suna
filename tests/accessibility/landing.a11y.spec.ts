import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The GTM container injects Google Ads/remarketing beacons (gtag, doubleclick,
// pagead, ccm/collect — including geo TLDs like google.rs) on every public
// page, and the landing page prefetches dozens of route chunks after hydration.
// Neither carries DOM that axe needs, but both keep the network busy — which is
// why these specs must not gate on `networkidle` (the beacons alone can hang
// past the 30s navigation timeout on CI runners). Navigation waits for
// `domcontentloaded` plus the concrete element under test; the beacons are
// additionally aborted at the route layer to keep runs quiet and fast.
const THIRD_PARTY_BEACONS =
  /https:\/\/[^/]*(googletagmanager\.com|google-analytics\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com)\/|https:\/\/www\.google\.[a-z.]+\/(pagead|ccm|rmkt)\//;

test.beforeEach(async ({ page }) => {
  await page.route(THIRD_PARTY_BEACONS, (route) => route.abort());
});

const CONTRAST_CEILING = Number(process.env.A11Y_CONTRAST_MAX ?? '560');

type Violation = {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: unknown[];
};

function summarize(violations: Violation[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.length} node(s)] ${v.helpUrl}`)
    .join('\n');
}

function blocking(violations: Violation[]): Violation[] {
  return violations.filter(
    (v) => (v.impact === 'serious' || v.impact === 'critical') && v.id !== 'color-contrast',
  );
}

function contrastNodeCount(violations: Violation[]): number {
  return violations
    .filter((v) => v.id === 'color-contrast')
    .reduce((total, v) => total + v.nodes.length, 0);
}

test.describe('Accessibility — axe-core', () => {
  test('landing page has no structural serious or critical violations', async ({
    page,
  }, testInfo) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const decorativeArtwork = page.locator('[data-a11y-decorative]');
    await decorativeArtwork.first().waitFor({ state: 'attached' });
    const decorativeArtworkCount = await decorativeArtwork.count();
    expect(decorativeArtworkCount).toBeGreaterThan(0);
    const ariaHiddenValues = await decorativeArtwork.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-hidden')),
    );
    expect(ariaHiddenValues).toEqual(Array(decorativeArtworkCount).fill('true'));

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('[data-a11y-decorative]')
      .analyze();
    await testInfo.attach('axe-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const structural = blocking(results.violations as Violation[]);
    expect(structural, `Structural a11y violations:\n${summarize(structural)}`).toEqual([]);

    const contrast = contrastNodeCount(results.violations as Violation[]);
    await testInfo.attach('contrast-debt.json', {
      body: JSON.stringify({ contrastNodes: contrast, ceiling: CONTRAST_CEILING }),
      contentType: 'application/json',
    });
    expect(
      contrast,
      `color-contrast debt is ${contrast} nodes, above the tracked ceiling of ${CONTRAST_CEILING}. Either fix the new low-contrast text or lower/raise A11Y_CONTRAST_MAX deliberately as the design debt is paid down.`,
    ).toBeLessThanOrEqual(CONTRAST_CEILING);
  });

  test('login page exposes labelled, accessible controls', async ({ page }, testInfo) => {
    const response = await page.goto('/auth', { waitUntil: 'domcontentloaded' });
    test.skip(!response || !response.ok(), 'No /auth route in this deployment');
    await page.locator('form').first().waitFor();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    await testInfo.attach('axe-login-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const structural = blocking(results.violations as Violation[]);
    expect(structural, `Login page a11y violations:\n${summarize(structural)}`).toEqual([]);
  });
});
