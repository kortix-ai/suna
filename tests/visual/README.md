# Visual Regression (Playwright `toHaveScreenshot`)

Pixel-diff visual regression using Playwright's built-in screenshot assertions.
Fully OSS, no paid SaaS, no extra runtime dependency beyond Playwright itself.

`expect(page).toHaveScreenshot()` captures the page and compares it against a
committed **baseline** image. The first run for a given platform writes the
baseline; later runs fail if the rendered pixels drift beyond the configured
threshold and emit a diff image.

## Run

```bash
cd tests
npm i -D @playwright/test@1.61.0
npx playwright install chromium

export E2E_BASE_URL=http://localhost:3000
npx playwright test --config visual/playwright.config.ts
```

## Baselines

Baselines are written next to the suite via `snapshotPathTemplate`:

```
tests/visual/__screenshots__/<spec-file>/<name>-<project>.png
```

They are **platform-specific** (OS + browser render text/AA differently). Commit
them, and generate/update them on the **same environment CI uses** — otherwise CI
will diff against a mismatched baseline. The standard approach is a Linux Docker
image (`mcr.microsoft.com/playwright:v1.61.0-jammy`) for both local baseline
generation and CI.

### Create / update baselines

```bash
# first time, or after an intentional UI change
npx playwright test --config visual/playwright.config.ts --update-snapshots

# update a single spec
npx playwright test --config visual/playwright.config.ts visual/landing.visual.spec.ts -u
```

Review the regenerated PNGs in the diff before committing — `--update-snapshots`
blindly accepts whatever currently renders.

## Reducing flake

The config and example already:
- disable animations (`animations: 'disabled'` + a CSS reset in `beforeEach`),
- pin the viewport (1280x720) and use `scale: 'css'`,
- allow a small tolerance (`maxDiffPixelRatio: 0.01`).

For dynamic regions (dates, avatars, ads), pass `mask: [locator]` to
`toHaveScreenshot` to paint them out, or stub the data before snapshotting.

## CI behaviour

- No baseline present for the platform -> the run **fails** (Playwright refuses to
  silently create baselines in CI). Generate them first and commit.
- A diff over threshold -> test fails; `expected`, `actual`, and `diff` PNGs land
  in `tests/test-results/visual/artifacts/` and the HTML report.
- Run baseline generation in the same container image as CI to avoid AA noise.

## Outputs

| Artifact | Path |
|----------|------|
| JUnit XML | `tests/test-results/visual/junit.xml` |
| HTML report (with image diffs) | `tests/test-results/visual/html/` |
| Diff / trace / video on failure | `tests/test-results/visual/artifacts/` |

## OSS alternatives

- **BackstopJS** — Puppeteer/Playwright-driven visual diffing with its own
  scenario config and HTML report; good when you want screenshot config decoupled
  from test code.
- **Loki** — visual regression for Storybook components (per-component snapshots
  rather than full pages).
- **jest-image-snapshot** — pixel diffing for a Jest-based stack.

Playwright's native `toHaveScreenshot` is preferred here because it reuses the
same browser/runner/report as the e2e and a11y suites with zero added deps.
