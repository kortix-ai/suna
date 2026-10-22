import { describe, expect, test } from 'bun:test';

import { statusElapsedFrame } from './status-elapsed';

describe('statusElapsedFrame', () => {
  test('starts at zero when the same status becomes active again', () => {
    const result = statusElapsedFrame(
      {
        status: 'Gathering thoughts',
        working: false,
        startedAtMs: 1_000,
        elapsedMs: 0,
      },
      {
        status: 'Gathering thoughts',
        working: true,
        nowMs: 2_401_000,
      },
    );

    expect(result).toEqual({
      status: 'Gathering thoughts',
      working: true,
      startedAtMs: 2_401_000,
      elapsedMs: 0,
    });
  });

  test('measures only the current active interval', () => {
    const result = statusElapsedFrame(
      {
        status: 'Gathering thoughts',
        working: true,
        startedAtMs: 2_401_000,
        elapsedMs: 0,
      },
      {
        status: 'Gathering thoughts',
        working: true,
        nowMs: 2_426_000,
      },
    );

    expect(result.elapsedMs).toBe(25_000);
    expect(result.startedAtMs).toBe(2_401_000);
  });

  test('resets when the status text changes', () => {
    const result = statusElapsedFrame(
      {
        status: 'Gathering thoughts',
        working: true,
        startedAtMs: 2_401_000,
        elapsedMs: 25_000,
      },
      {
        status: 'Reading files',
        working: true,
        nowMs: 2_426_000,
      },
    );

    expect(result.elapsedMs).toBe(0);
    expect(result.startedAtMs).toBe(2_426_000);
  });

  test('stops and clears elapsed time when the turn becomes inactive', () => {
    const result = statusElapsedFrame(
      {
        status: 'Gathering thoughts',
        working: true,
        startedAtMs: 2_401_000,
        elapsedMs: 25_000,
      },
      {
        status: 'Gathering thoughts',
        working: false,
        nowMs: 2_426_000,
      },
    );

    expect(result.elapsedMs).toBe(0);
    expect(result.working).toBe(false);
  });
});
