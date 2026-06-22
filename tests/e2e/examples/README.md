# UI E2E Examples (Playwright)

Generic, copyable Playwright examples that drive the app's UI through a real
browser. They are intentionally deployment-agnostic: they hit
`process.env.E2E_BASE_URL` (default `http://localhost:3000`) and assert on roles
and accessible names rather than brittle CSS, so they survive markup changes.

These examples are standalone. They do **not** run as part of the existing
`tests/e2e/specs/` suite and use their own config so you can copy the pattern
into a new project without touching the production specs.

## How UI E2E works here

- **Browser-first.** Playwright launches Chromium, navigates to the app, and
  interacts the way a user would (click, type, assert visible text).
- **Web-first assertions.** Use `expect(locator).toBeVisible()` etc. They
  auto-wait and retry until the configured `expect.timeout`, so no manual
  `waitForTimeout`.
- **Role-based locators.** Prefer `getByRole`, `getByLabel`, `getByText` over
  CSS/XPath. They mirror what users and assistive tech perceive and are far more
  stable. Use `.or()` to tolerate copy/markup variation across builds.
- **Fixtures.** `fixtures.ts` extends the base `test` to clear cookies before
  each test and to surface a resolved `baseURL`. Import `test`/`expect` from
  `./fixtures`, not from `@playwright/test`, to inherit this setup.

## Run

```bash
cd tests
npm i -D @playwright/test@1.61.0
npx playwright install chromium

# point at your app
export E2E_BASE_URL=http://localhost:3000

npx playwright test --config e2e/examples/playwright.config.ts
```

Headed / debugging:

```bash
npx playwright test --config e2e/examples/playwright.config.ts --headed
npx playwright test --config e2e/examples/playwright.config.ts --debug
PWDEBUG=1 npx playwright test --config e2e/examples/playwright.config.ts
```

## Outputs

| Artifact | Path |
|----------|------|
| JUnit XML (CI ingest) | `tests/test-results/e2e/junit.xml` |
| HTML report | `tests/test-results/e2e/html/` |
| Traces / screenshots / video (on failure) | `tests/test-results/e2e/artifacts/` |

Open the HTML report:

```bash
npx playwright show-report tests/test-results/e2e/html
```

Open a failure trace (timeline, DOM snapshots, network):

```bash
npx playwright show-trace tests/test-results/e2e/artifacts/<test>/trace.zip
```

## Add a spec

1. Create `e2e/examples/<feature>.spec.ts`.
2. `import { test, expect } from './fixtures';`
3. Group with `test.describe('<feature>', () => { ... })`.
4. Inside each `test`, navigate with `await page.goto('/route')` (relative —
   `baseURL` is applied automatically).
5. Locate by role/label/text and assert with web-first matchers:

```ts
import { test, expect } from './fixtures';

test('user can open the settings page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /settings/i }).click();
  await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
});
```

## Conventions

- No inline/docstring comments in spec code — names carry intent.
- One behaviour per `test`; keep them independent (cookies are cleared per test).
- Never hardcode the host; always go through `E2E_BASE_URL`.
- Prefer `getByRole`/`getByLabel`. Reach for `locator(css)` only as a fallback.
