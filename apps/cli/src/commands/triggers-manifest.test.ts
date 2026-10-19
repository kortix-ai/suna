import { describe, expect, test } from 'bun:test';
import { parseRunCapFlags } from './triggers-manifest.ts';

// KRTX-1721: the run caps a trigger flag sets, on `add` and on `set`.
describe('parseRunCapFlags', () => {
  test('a whole number of at least 1 becomes the manifest field', () => {
    expect(parseRunCapFlags({ maxRunsPerHour: '5', maxRunsPerDay: '40' }, false)).toEqual({
      caps: { max_runs_per_hour: 5, max_runs_per_day: 40 },
    });
    expect(parseRunCapFlags({}, false)).toEqual({ caps: {} });
  });

  test('`none` removes a cap on set, and is refused on add', () => {
    expect(parseRunCapFlags({ maxRunsPerDay: 'none' }, true)).toEqual({ caps: { max_runs_per_day: null } });
    expect(parseRunCapFlags({ maxRunsPerDay: 'none' }, false)).toEqual({
      error: '--max-runs-per-day must be a whole number of at least 1 (got "none").',
    });
  });

  test('zero, a negative, a fraction or text is refused, naming the flag', () => {
    for (const raw of ['0', '-3', '1.5', 'ten', '']) {
      expect(parseRunCapFlags({ maxRunsPerHour: raw }, true)).toEqual({
        error: `--max-runs-per-hour must be a whole number of at least 1, or none to remove it (got "${raw}").`,
      });
    }
  });
});
