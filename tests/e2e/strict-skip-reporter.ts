/**
 * Fails the deployed lane when a journey was excluded.
 *
 * This reporter and the specs' conditional `test.skip(...)` guards used to
 * contradict each other: the guards degrade gracefully on a missing capability,
 * this reporter turns that same degradation into a lane failure — after the
 * whole suite had run. `e2e/global-setup.ts` resolves it by asserting every
 * required capability up front, so on the strict lane a missing capability now
 * fails in seconds and never reaches a skip. What remains here is the genuine
 * case: a journey excluded for a reason the setup could not predict.
 *
 * A `@quarantine` journey is NOT such a case, and does not need an allowance
 * here. `playwright.config.ts` turns `E2E_EXCLUDE_TAGS` into `grepInvert`, and
 * Playwright applies grep at COLLECTION — before sharding, before any hook, and
 * before this reporter exists. An excluded journey therefore produces no
 * `TestCase` and no `onTestEnd` call at all: it is absent from the run, not
 * skipped in it, so `this.skipped` never sees it and the lane stays green
 * without weakening the strict rule for anything else. The exclusion is the
 * DEFAULT now, not something each gate opts into — see `resolveGrepFilters`.
 * Verified by `playwright test --list`: 15 tests bare, the same 15 with
 * `E2E_EXCLUDE_TAGS`, and exactly the 6 quarantined tests (3 files) with
 * `E2E_INCLUDE_TAGS`.
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type ExclusionWriter = (excluded: string[]) => Promise<void>;

export class StrictSkipReporter implements Reporter {
  private readonly requireAll: boolean;
  private readonly allowPreviewOAuthExclusion: boolean;
  private readonly writeExclusions: ExclusionWriter;
  private readonly skipped: string[] = [];

  constructor(
    options: {
      requireAll?: boolean;
      allowPreviewOAuthExclusion?: boolean;
      writeExclusions?: ExclusionWriter;
    } = {},
  ) {
    this.requireAll = options.requireAll ?? process.env.E2E_REQUIRE_ALL_BROWSER === '1';
    this.allowPreviewOAuthExclusion =
      options.allowPreviewOAuthExclusion ??
      process.env.E2E_ALLOW_PREVIEW_OAUTH_EXCLUSION === '1';
    this.writeExclusions = options.writeExclusions ?? (async (excluded) => {
      const output = resolve(process.cwd(), 'test-results/browser-exclusions.json');
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(
        output,
        `${JSON.stringify({ excluded, count: excluded.length }, null, 2)}\n`,
      );
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') this.skipped.push(test.titlePath().join(' > '));
  }

  async onEnd(_result: FullResult): Promise<{ status: 'failed' } | undefined> {
    if (this.skipped.length === 0) return undefined;
    await this.writeExclusions(this.skipped);
    const unauthorized = this.skipped.filter(
      (title) =>
        !(
          this.allowPreviewOAuthExclusion &&
          title.includes('17 — OAuth provider initiation')
        ),
    );
    if (!this.requireAll || unauthorized.length === 0) return undefined;
    process.stderr.write(
      `[browser] strict target excluded ${unauthorized.length} unauthorized journey(s):\n` +
        `${unauthorized.map((title) => `- ${title}`).join('\n')}\n`,
    );
    return { status: 'failed' };
  }
}

export default StrictSkipReporter;
