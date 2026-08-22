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

  it('records only the preview OAuth exclusion without failing the run', async () => {
    const reporter = new StrictSkipReporter({
      requireAll: true,
      allowPreviewOAuthExclusion: true,
      writeExclusions: async () => {},
    });
    reporter.onTestEnd(
      skipped(['chromium', '17 — OAuth provider initiation', 'Google accepts callback']),
      { status: 'skipped' } as never,
    );
    await expect(reporter.onEnd({} as never)).resolves.toBeUndefined();
  });
});
