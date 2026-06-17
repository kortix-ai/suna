import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Accessibility — axe-core', () => {
  test('landing page has no serious or critical violations', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    await testInfo.attach('axe-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );

    const summary = blocking
      .map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.length} node(s)] ${v.helpUrl}`)
      .join('\n');

    expect(blocking, `Serious/critical a11y violations:\n${summary}`).toEqual([]);
  });

  test('login page exposes labelled form controls', async ({ page }, testInfo) => {
    const response = await page.goto('/auth', { waitUntil: 'networkidle' });
    test.skip(!response || !response.ok(), 'No /auth route in this deployment');

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include('form')
      .analyze();

    await testInfo.attach('axe-login-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );

    expect(blocking).toEqual([]);
  });
});
