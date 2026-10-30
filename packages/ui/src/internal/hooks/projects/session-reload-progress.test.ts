import { describe, expect, test } from 'bun:test';
import {
  RELOAD_PROGRESS_STEPS,
  reloadProgressPosition,
  reloadProgressText,
} from './session-reload-progress';

describe('session reload progress', () => {
  test('keeps the visible steps in the server operation order', () => {
    expect(RELOAD_PROGRESS_STEPS.map((step) => step.phase)).toEqual([
      'checking-session',
      'refreshing-workspace',
      'compiling-config',
      'applying-config',
      'confirming-config',
    ]);
  });

  test('describes the blocking runtime swap without claiming an unconfirmed sub-phase', () => {
    expect(reloadProgressText('applying-config')).toBe('Applying config and validating runtime');
  });

  test('marks prior steps complete and later steps pending', () => {
    expect(reloadProgressPosition('compiling-config', 'checking-session')).toBe('complete');
    expect(reloadProgressPosition('compiling-config', 'compiling-config')).toBe('current');
    expect(reloadProgressPosition('compiling-config', 'applying-config')).toBe('pending');
  });

  test('treats the workspace refresh like any other step', () => {
    expect(reloadProgressPosition(null, 'refreshing-workspace')).toBe('pending');
    expect(reloadProgressPosition('refreshing-workspace', 'refreshing-workspace')).toBe('current');
    expect(reloadProgressPosition('compiling-config', 'refreshing-workspace')).toBe('complete');
  });
});
