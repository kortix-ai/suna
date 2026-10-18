import { describe, expect, it } from 'vitest';
import { StrictSkipReporter } from '../e2e/strict-skip-reporter';

function skipped(title: string[]) {
  return {
    titlePath: () => title,
  } as never;
}

describe('strict browser skip reporter', () => {
  it('fails an unapproved skip', async () => {
    const reporter = new StrictSkipReporter({ requireAll: true, writeExclusions: async () => {} });
    reporter.onTestEnd(skipped(['chromium', 'journey']), { status: 'skipped' } as never);
    await expect(reporter.onEnd({} as never)).resolves.toEqual({ status: 'failed' });
  });

  it('records a skip without failing a non-strict run', async () => {
    const reporter = new StrictSkipReporter({ requireAll: false, writeExclusions: async () => {} });
    reporter.onTestEnd(skipped(['chromium', 'journey']), { status: 'skipped' } as never);
    await expect(reporter.onEnd({} as never)).resolves.toBeUndefined();
  });
});
