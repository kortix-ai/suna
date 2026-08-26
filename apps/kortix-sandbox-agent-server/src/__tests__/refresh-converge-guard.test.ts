import { describe, expect, test } from 'bun:test';
import { refreshMayConvergeRuntime } from '../routes/refresh';

describe('refreshMayConvergeRuntime', () => {
  test('a booting runtime is never converged from a refresh', () => {
    // Essentia 2026-08-25 17:23: the session-open refresh installed OpenCode
    // 1.18.23 and restarted it while the resume was still booting.
    expect(refreshMayConvergeRuntime('starting')).toBe(false);
    expect(refreshMayConvergeRuntime('down')).toBe(false);
  });
  test('a serving runtime may be converged', () => {
    expect(refreshMayConvergeRuntime('ok')).toBe(true);
  });
});
