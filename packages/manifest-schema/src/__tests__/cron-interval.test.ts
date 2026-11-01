import { describe, expect, mock, test } from 'bun:test';

// Count the expensive part: sampling a cron's next fires. Validation also
// builds a Cron per trigger to check that it parses; that is cheap.
const real = await import('croner');
let sampled = 0;
mock.module('croner', () => ({
  ...real,
  Cron: class extends real.Cron {
    override nextRuns(...args: Parameters<InstanceType<typeof real.Cron>['nextRuns']>) {
      sampled += 1;
      return super.nextRuns(...args);
    }
  },
}));
const { cronIntervalError, validateManifest } = await import('../index');

describe('cronIntervalError', () => {
  test('flags a cron that fires more than once a minute, and passes one that does not', () => {
    expect(cronIntervalError('*/30 * * * * *')).toContain('fires more than once a minute');
    expect(cronIntervalError('0 */30 * * * *')).toBeNull();
    expect(cronIntervalError('0 0 3 * * *', 'Europe/London')).toBeNull();
  });

  test('samples each (timezone, cron) once: a manifest read validates every trigger on every connector call', () => {
    const text = `triggers:\n${Array.from({ length: 32 }, (_, i) =>
      `  - slug: job-${i}\n    type: cron\n    cron: "0 ${i} 5 * * *"\n    timezone: Asia/Tokyo\n    prompt: run ${i}\n`).join('')}`;
    sampled = 0;
    validateManifest(text);
    expect(sampled).toBe(32);
    for (let i = 0; i < 10; i++) validateManifest(text);
    expect(sampled).toBe(32);
    // A different timezone is a different answer.
    cronIntervalError('0 0 5 * * *', 'America/New_York');
    expect(sampled).toBe(33);
  });
});
