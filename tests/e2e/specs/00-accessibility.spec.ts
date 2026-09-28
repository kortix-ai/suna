import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const THIRD_PARTY_BEACONS =
  /https:\/\/[^/]*(googletagmanager\.com|google-analytics\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com)\/|https:\/\/www\.google\.[a-z.]+\/(pagead|ccm|rmkt)\//;
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
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} ` +
        `[${violation.nodes.length} node(s)] ${violation.helpUrl}`,
    )
    .join('\n');
}

function blocking(violations: Violation[]): Violation[] {
  return violations.filter(
    (violation) =>
      (violation.impact === 'serious' || violation.impact === 'critical') &&
      violation.id !== 'color-contrast',
  );
}

function contrastNodeCount(violations: Violation[]): number {
  return violations
    .filter((violation) => violation.id === 'color-contrast')
    .reduce((total, violation) => total + violation.nodes.length, 0);
}

test.beforeEach(async ({ page }) => {
  await page.route(THIRD_PARTY_BEACONS, (route) => route.abort());
});

test.describe('00 - Accessibility', () => {
  test('the landing page meets the structural WCAG A and AA contract', async ({
    page,
  }, testInfo) => {
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.ok()).toBe(true);

    const decorativeArtwork = page.locator('[data-a11y-decorative]');
    // Hydration can replace the server-rendered artwork between two separate
    // reads (release gate 36067485325: attached, then count() returned 0).
    // Read presence and every aria-hidden value from one DOM snapshot, and
    // retry until that snapshot holds artwork that is all aria-hidden="true".
    await expect
      .poll(
        async () => {
          const ariaHidden = await decorativeArtwork.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('aria-hidden')),
          );
          return ariaHidden.length > 0 && ariaHidden.every((value) => value === 'true')
            ? 'all decorative artwork is aria-hidden'
            : ariaHidden;
        },
        { message: 'the landing page renders decorative artwork, and every piece is aria-hidden="true"' },
      )
      .toBe('all decorative artwork is aria-hidden');

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('[data-a11y-decorative]')
      .analyze();
    await testInfo.attach('axe-landing-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const structural = blocking(results.violations as Violation[]);
    expect(structural, `Landing accessibility violations:\n${summarize(structural)}`).toEqual([]);

    const contrastNodes = contrastNodeCount(results.violations as Violation[]);
    await testInfo.attach('axe-landing-contrast-debt.json', {
      body: JSON.stringify({ contrastNodes, ceiling: CONTRAST_CEILING }),
      contentType: 'application/json',
    });
    expect(
      contrastNodes,
      `Landing color-contrast debt is ${contrastNodes} nodes. The ceiling is ${CONTRAST_CEILING}.`,
    ).toBeLessThanOrEqual(CONTRAST_CEILING);
  });

  test('the login page exposes structurally accessible controls', async ({ page }, testInfo) => {
    const response = await page.goto('/auth', {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.ok()).toBe(true);
    await expect(page.locator('form').first()).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    await testInfo.attach('axe-login-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const structural = blocking(results.violations as Violation[]);
    expect(structural, `Login accessibility violations:\n${summarize(structural)}`).toEqual([]);
  });
});
