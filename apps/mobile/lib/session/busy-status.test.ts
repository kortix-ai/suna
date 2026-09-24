import { describe, expect, test } from 'bun:test';

import {
  BUSY_DEFAULT_STATUS,
  BUSY_RETRY_LABEL,
  STATUS_STALL_AFTER_MS,
  STATUS_THROTTLE_MS,
  attemptFailuresSummary,
  busyStatusLabels,
  failureLine,
  failureTarget,
  gatewayMetaLine,
  retrySecondsLeft,
  retryTitle,
  statusElapsedFrame,
  statusThrottleDecision,
} from './busy-status';

describe('busy indicator constants (apps/web session-chat.tsx + session-busy-indicator.tsx)', () => {
  test('match web', () => {
    expect(STATUS_THROTTLE_MS).toBe(2500);
    expect(STATUS_STALL_AFTER_MS).toBe(20_000);
    expect(BUSY_DEFAULT_STATUS).toBe('Thinking');
    expect(BUSY_RETRY_LABEL).toBe('Waiting to retry');
  });
});

describe('statusElapsedFrame (web turn/status-elapsed.ts)', () => {
  test('a new status restarts the clock', () => {
    const first = statusElapsedFrame(undefined, { status: 'Reading', working: true, nowMs: 1000 });
    expect(first).toEqual({ status: 'Reading', working: true, startedAtMs: 1000, elapsedMs: 0 });
    const later = statusElapsedFrame(first, { status: 'Reading', working: true, nowMs: 25_000 });
    expect(later.elapsedMs).toBe(24_000);
    const changed = statusElapsedFrame(later, { status: 'Writing', working: true, nowMs: 26_000 });
    expect(changed).toEqual({ status: 'Writing', working: true, startedAtMs: 26_000, elapsedMs: 0 });
  });

  test('a finished turn reads zero elapsed', () => {
    const idle = statusElapsedFrame(undefined, { status: 'Reading', working: false, nowMs: 0 });
    expect(statusElapsedFrame(idle, { status: 'Reading', working: false, nowMs: 90_000 }).elapsedMs).toBe(0);
  });
});

describe('statusThrottleDecision (web 2.5s status throttle)', () => {
  test('empty or unchanged status keeps the current label', () => {
    expect(statusThrottleDecision({ rawStatus: '', throttledStatus: 'A', lastChangeAtMs: 0, nowMs: 9000 })).toEqual({
      type: 'keep',
    });
    expect(statusThrottleDecision({ rawStatus: 'A', throttledStatus: 'A', lastChangeAtMs: 0, nowMs: 9000 })).toEqual({
      type: 'keep',
    });
  });

  test('a change 2.5s or more after the last one applies at once', () => {
    expect(statusThrottleDecision({ rawStatus: 'B', throttledStatus: 'A', lastChangeAtMs: 1000, nowMs: 3500 })).toEqual({
      type: 'apply',
    });
  });

  test('a change inside the window waits for the rest of it', () => {
    expect(statusThrottleDecision({ rawStatus: 'B', throttledStatus: 'A', lastChangeAtMs: 1000, nowMs: 2000 })).toEqual({
      type: 'defer',
      delayMs: 1500,
    });
  });
});

describe('busyStatusLabels (web statusPhrase / statusElapsedLabel)', () => {
  test('below 20s the phrase is the status and there is no clock', () => {
    expect(busyStatusLabels({ throttledStatus: 'Reading files...', working: true, elapsedMs: 19_999 })).toEqual({
      phrase: 'Reading files...',
      elapsedLabel: undefined,
    });
  });

  test('at 20s the phrase drops its ellipsis and the clock appears', () => {
    expect(busyStatusLabels({ throttledStatus: 'Reading files...', working: true, elapsedMs: 20_000 })).toEqual({
      phrase: 'Reading files',
      elapsedLabel: '20s',
    });
    expect(busyStatusLabels({ throttledStatus: 'Running command…', working: true, elapsedMs: 75_000 })).toEqual({
      phrase: 'Running command',
      elapsedLabel: '1m 15s',
    });
  });

  test('no status or not working never grows a clock', () => {
    expect(busyStatusLabels({ throttledStatus: '', working: true, elapsedMs: 60_000 })).toEqual({
      phrase: '',
      elapsedLabel: undefined,
    });
    expect(busyStatusLabels({ throttledStatus: 'Reading...', working: false, elapsedMs: 60_000 })).toEqual({
      phrase: 'Reading...',
      elapsedLabel: undefined,
    });
  });
});

describe('retry countdown (web SessionRetryDisplay)', () => {
  test('seconds left rounds and never goes negative', () => {
    expect(retrySecondsLeft(10_000, 4_400)).toBe(6);
    expect(retrySecondsLeft(10_000, 4_600)).toBe(5);
    expect(retrySecondsLeft(10_000, 12_000)).toBe(0);
  });

  test('ticks down one second per second', () => {
    const next = 30_000;
    const seen = [0, 1000, 2000, 3000].map((elapsed) => retrySecondsLeft(next, 20_000 + elapsed));
    expect(seen).toEqual([10, 9, 8, 7]);
  });

  test('title', () => {
    expect(retryTitle(7)).toBe('Retrying in 7s');
    expect(retryTitle(0)).toBe('Retrying now');
  });
});

describe('gateway meta (web GatewayMetaLine / GatewayAttemptFailureList)', () => {
  const failure = {
    attempt: 1,
    provider: 'anthropic',
    routeModel: 'kortix/best',
    resolvedModel: 'claude-x',
    stage: 'upstream',
    status: 529,
    code: 'overloaded',
    message: 'Overloaded',
  };

  test('meta line joins the present facts with a middle dot', () => {
    expect(gatewayMetaLine('Attempt 2', { provider: 'openai', code: 'rate_limited', requestId: 'req_1' })).toBe(
      'Attempt 2 · openai · rate_limited · req_1',
    );
    expect(gatewayMetaLine(undefined, { provider: 'openai' })).toBe('openai');
    expect(gatewayMetaLine(undefined, undefined)).toBe('');
  });

  test('failure target names the route only when it differs', () => {
    expect(failureTarget(failure)).toBe('anthropic/claude-x (route kortix/best)');
    expect(failureTarget({ ...failure, routeModel: 'claude-x' })).toBe('anthropic/claude-x');
  });

  test('failure line and summary match web output', () => {
    expect(failureLine(failure)).toBe(' · HTTP 529 ·overloaded · Overloaded');
    expect(failureLine({ ...failure, status: undefined })).toBe(' · overloaded · Overloaded');
    expect(attemptFailuresSummary(1)).toBe('1 attempt');
    expect(attemptFailuresSummary(3)).toBe('3 attempts');
  });
});
