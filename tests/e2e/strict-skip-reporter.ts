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
