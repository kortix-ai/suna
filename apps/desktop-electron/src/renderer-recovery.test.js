const { describe, expect, test } = require('bun:test');

const { rendererGoneNeedsRecovery } = require('./renderer-recovery');

describe('renderer recovery', () => {
  test('a crash, a kill, or an OOM leaves an empty window, so it needs recovery', () => {
    for (const reason of ['crashed', 'killed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure']) {
      expect(rendererGoneNeedsRecovery({ reason })).toBe(true);
    }
  });

  test('a clean exit is the window closing, not a failure', () => {
    expect(rendererGoneNeedsRecovery({ reason: 'clean-exit' })).toBe(false);
  });

  test('missing details still recover rather than leave an empty window', () => {
    expect(rendererGoneNeedsRecovery(undefined)).toBe(true);
    expect(rendererGoneNeedsRecovery({})).toBe(true);
  });
});
