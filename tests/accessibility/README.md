# Accessibility (axe-core + Playwright)

Automated a11y checks with [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm),
the OSS axe-core engine driven from a real Playwright browser session. axe runs
against the live, rendered DOM (post-hydration), so it catches issues in the
actual served markup.

Automated scanning catches roughly 30-50% of WCAG issues. It does **not** replace
manual keyboard, screen-reader, and contrast-in-context review.

## Run

```bash
cd tests
npm i -D @playwright/test@1.61.0 @axe-core/playwright@4.11.3
npx playwright install chromium

export E2E_BASE_URL=http://localhost:3000
npx playwright test --config accessibility/playwright.config.ts
```

## What the example does

- Loads a page, runs `AxeBuilder` scoped to the WCAG tag set.
- Attaches the full violation list as JSON to the Playwright report.
- **Fails only on `serious` and `critical`** impact, so the gate is actionable;
  `minor`/`moderate` findings still appear in the attached report for triage.

## WCAG levels and tags

axe maps rules to ruleset tags. Select them with `.withTags([...])`:

| Tag | Meaning |
|-----|---------|
| `wcag2a`, `wcag2aa` | WCAG 2.0 Level A / AA |
| `wcag21a`, `wcag21aa` | WCAG 2.1 Level A / AA |
| `wcag22aa` | WCAG 2.2 Level AA |
| `best-practice` | axe heuristics beyond strict WCAG |

The example targets A + AA for WCAG 2.0/2.1 — the common legal/compliance bar.
Add `wcag22aa` to tighten, or `best-practice` for stricter hygiene.

axe impact levels: `minor` < `moderate` < `serious` < `critical`.

## Triage a failure

1. Open the report and read the attached `axe-results.json` (or console summary):
   each violation has `id`, `impact`, `help`, `helpUrl`, and offending `nodes`
   with CSS selectors and HTML.
2. Follow `helpUrl` (Deque docs) for the rule and the fix.
3. Fix the markup (labels, `alt`, roles, contrast, landmarks, etc.).
4. **False positives / accepted debt:** scope the scan instead of disabling the
   gate — `.exclude('selector')` to skip a region, or
   `.disableRules(['rule-id'])` for a specific rule, with a comment-free,
   reviewed justification in the PR. Prefer fixing over suppressing.

```ts
const results = await new AxeBuilder({ page })
  .withTags(['wcag2a', 'wcag2aa'])
  .exclude('#third-party-widget')
  .disableRules(['color-contrast'])
  .analyze();
```

## Add a scan

```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('settings page is accessible', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking).toEqual([]);
});
```

## Outputs

| Artifact | Path |
|----------|------|
| JUnit XML | `tests/test-results/accessibility/junit.xml` |
| HTML report (+ attached JSON) | `tests/test-results/accessibility/html/` |
| Trace / video on failure | `tests/test-results/accessibility/artifacts/` |
