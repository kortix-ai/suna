import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

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
  test('landing page has no structural serious or critical violations', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
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
      `color-contrast debt is ${contrast} nodes, above the tracked ceiling of ${CONTRAST_CEILING}. ` +
        `Either fix the new low-contrast text or lower/raise A11Y_CONTRAST_MAX deliberately as the design debt is paid down.`,
    ).toBeLessThanOrEqual(CONTRAST_CEILING);
  });

  test('login page exposes labelled, accessible controls', async ({ page }, testInfo) => {
    const response = await page.goto('/auth', { waitUntil: 'networkidle' });
    test.skip(!response || !response.ok(), 'No /auth route in this deployment');

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    await testInfo.attach('axe-login-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const structural = blocking(results.violations as Violation[]);
    expect(structural, `Login page a11y violations:\n${summarize(structural)}`).toEqual([]);
  });
});
