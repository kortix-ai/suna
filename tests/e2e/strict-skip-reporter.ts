import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export class StrictSkipReporter implements Reporter {
  private readonly requireAll: boolean;
  private readonly skipped: string[] = [];

  constructor(options: { requireAll?: boolean } = {}) {
    this.requireAll = options.requireAll ?? process.env.E2E_REQUIRE_ALL_BROWSER === '1';
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') this.skipped.push(test.titlePath().join(' > '));
  }

  async onEnd(_result: FullResult): Promise<{ status: 'failed' } | undefined> {
    if (!this.requireAll || this.skipped.length === 0) return undefined;
    process.stderr.write(
      `[browser] strict target excluded ${this.skipped.length} journey(s):\n` +
        `${this.skipped.map((title) => `- ${title}`).join('\n')}\n`,
    );
    return { status: 'failed' };
  }
}

export default StrictSkipReporter;
