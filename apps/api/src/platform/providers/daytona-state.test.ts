import { describe, expect, test } from 'bun:test';

import { classifyDaytonaState } from './daytona-state';

describe('classifyDaytonaState', () => {
  test('running states', () => {
    for (const state of ['started', 'starting', 'running', 'active', 'restoring', 'pending_start']) {
      expect(classifyDaytonaState(state)).toBe('running');
    }
  });

  test('stopped states', () => {
    for (const state of ['stopped', 'stopping', 'pending_stop', 'archived', 'archiving']) {
      expect(classifyDaytonaState(state)).toBe('stopped');
    }
  });

  test('destroyed states are removed', () => {
    expect(classifyDaytonaState('destroyed')).toBe('removed');
    expect(classifyDaytonaState('destroying')).toBe('removed');
  });

  // THE 829-hour bug. The old substring matcher tested for
  // 'start'|'running'|'active'|'stop'|'archive'; `error` matched none of them,
  // fell through to 'unknown', and `decideReconcile('unknown')` returns 'none'
  // — so a permanently dead box was treated as transient uncertainty forever
  // while compute billing kept settling wall-clock against it. Live proof: 12 of
  // the longest-billed open rows were ALL in Daytona state `error`, the worst
  // still billing after 829 hours ($111.91), Daytona untouched for 35 days.
  test('REGRESSION: a dead box is terminal, never unknown', () => {
    expect(classifyDaytonaState('error')).toBe('terminal');
    expect(classifyDaytonaState('build_failed')).toBe('terminal');
  });

  test('genuinely transitional states stay unknown so we never act on them', () => {
    for (const state of ['creating', 'pending_build', 'building_snapshot']) {
      expect(classifyDaytonaState(state)).toBe('unknown');
    }
  });

  test('is case- and whitespace-insensitive', () => {
    expect(classifyDaytonaState('  ERROR ')).toBe('terminal');
    expect(classifyDaytonaState('Started')).toBe('running');
  });

  // An unmapped terminal state is a billable box. Degrading to 'unknown' is the
  // safe KILL decision, but it must be loud rather than silent.
  test('an unrecognised state degrades to unknown and warns', () => {
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      expect(classifyDaytonaState('some_future_state')).toBe('unknown');
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => String(w).includes('some_future_state'))).toBe(true);
  });

  test('null / undefined / empty never throw', () => {
    expect(classifyDaytonaState(null)).toBe('unknown');
    expect(classifyDaytonaState(undefined)).toBe('unknown');
  });
});
