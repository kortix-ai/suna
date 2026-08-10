import { describe, expect, it } from 'vitest';
import { StrictSkipReporter } from '../e2e/strict-skip-reporter';

describe('strict Playwright skip reporter', () => {
  it('fails a strict browser lane when one journey is skipped', async () => {
    const reporter = new StrictSkipReporter({ requireAll: true });
    reporter.onTestEnd({ titlePath: () => ['journey'] } as never, { status: 'skipped' } as never);

    await expect(reporter.onEnd({ status: 'passed' } as never)).resolves.toEqual({
      status: 'failed',
    });
  });

  it('keeps ordinary browser lanes compatible with explicit skips', async () => {
    const reporter = new StrictSkipReporter({ requireAll: false });
    reporter.onTestEnd({ titlePath: () => ['journey'] } as never, { status: 'skipped' } as never);

    await expect(reporter.onEnd({ status: 'passed' } as never)).resolves.toBeUndefined();
  });
});
